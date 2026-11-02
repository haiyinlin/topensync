import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type {
  AppConfig,
  FileEntry,
  FileState,
  DiffEntry,
  LogEntry,
  LogMeta,
  ScanRecord
} from '@shared/types'

/**
 * 本地清单数据库（node:sqlite，Electron 36+ 内置，无 native 编译）。
 *
 * Schema 是数据层的唯一权威定义。
 */

/**
 * files 表定义（单独抽出，迁移重建表时复用）。
 *
 * local_inode 存 TEXT：Windows 的文件索引号是 64 位，数值普遍超过
 * JS 的 2^53 安全整数范围，按 INTEGER 存再读出来会抛
 * "Value is too large to be represented as a JavaScript number"。
 */
const FILES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id              INTEGER PRIMARY KEY,
  local_path      TEXT NOT NULL UNIQUE,
  local_size      INTEGER NOT NULL,
  mtime_ms        INTEGER NOT NULL,
  md5             TEXT,
  sha1            TEXT,
  remote_path     TEXT,
  remote_size     INTEGER,
  remote_etag     TEXT,
  -- 最近一次「成功同步」时确认的本地 size / mtime。
  -- L1 去重的基准必须是这两个值，而不是 local_size/mtime_ms——
  -- 后者会被 upsert 覆盖，拿它做基准会让去重永远命中。
  synced_size     INTEGER,
  synced_mtime_ms INTEGER,
  -- 最近一次「成功同步」时远端那份内容的哈希。
  -- 与 md5/sha1 分开：md5/sha1 会被一次失败的上传改写，
  -- 只有 synced_* 能代表「远端确实存着的版本」。
  -- 服务端不给任何秒传信号，客户端只能靠它自行判定「远端重复」。
  synced_md5      TEXT,
  synced_sha1     TEXT,
  -- 本地文件的 inode。重命名时 inode 不变而路径变，
  -- 是识别重命名最可靠的信号，且比算哈希便宜得多。
  local_inode     TEXT,
  -- 同步结论的可信级别（见 VerifyLevel）。
  -- 'hash' = 上传后经哈希/校验确认内容一致；
  -- 'size' = 仅凭「远端同名 + 同大小」弱认定，内容未校验。
  -- null   = 未标记（旧库或未走完同步流程）。
  verify_level    TEXT,
  state           TEXT NOT NULL DEFAULT 'pending',
  last_sync_at    INTEGER,
  last_verify_at  INTEGER,
  error_msg       TEXT,
  first_seen_at   INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_state ON files(state);
CREATE INDEX IF NOT EXISTS idx_files_remote ON files(remote_path);
`

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

${FILES_TABLE_SQL}

-- 上传会话（分片上传断点续传）
CREATE TABLE IF NOT EXISTS upload_sessions (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id),
  upload_id     TEXT NOT NULL,
  remote_path   TEXT NOT NULL,
  total_size    INTEGER NOT NULL,
  chunk_size    INTEGER NOT NULL,
  received      TEXT NOT NULL DEFAULT '[]',
  state         TEXT NOT NULL DEFAULT 'active',
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_file ON upload_sessions(file_id, state);

-- 远端快照（远端对账产物）
CREATE TABLE IF NOT EXISTS remote_snapshot (
  id            INTEGER PRIMARY KEY,
  remote_path   TEXT NOT NULL UNIQUE,
  remote_size   INTEGER NOT NULL,
  remote_mtime  INTEGER,
  is_dir        INTEGER NOT NULL DEFAULT 0,
  seen_at       INTEGER NOT NULL,
  scan_id       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rs_seen ON remote_snapshot(seen_at);
CREATE INDEX IF NOT EXISTS idx_rs_scan ON remote_snapshot(scan_id);

-- 扫描批次
CREATE TABLE IF NOT EXISTS scans (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running',
  error_msg     TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_kind ON scans(kind, started_at);

-- 差异（远端对账与本地清单比对后的结论）
CREATE TABLE IF NOT EXISTS diffs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  local_path    TEXT,
  remote_path   TEXT NOT NULL,
  local_size    INTEGER,
  remote_size   INTEGER,
  local_mtime   INTEGER,
  remote_mtime  INTEGER,
  detected_at   INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolution    TEXT
);
CREATE INDEX IF NOT EXISTS idx_diffs_unresolved ON diffs(resolved_at);

-- 操作日志
--
-- category 与 local_path 是为了让日志能回答「这个文件到底怎么了」：
--   category   → 上传 / 下载 / 跳过 / 对账 / 系统
--   local_path → 涉及的文件（相对同步根）
-- 老库缺这两列，migrate() 会补上。
CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  file_id     INTEGER,
  remote      TEXT,
  category    TEXT,
  local_path  TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON sync_log(ts);
-- 注意：category 上的索引**不能**在这里建。
-- 老库的 sync_log 表没有 category 列，而建表语句在迁移之前执行——
-- 此时建索引会直接报 "no such column: category"，连迁移的机会都没有。
-- 索引统一在 migrateLog() 补完列之后建。
`

export class Manifest {
  private readonly raw: DatabaseSync
  /**
   * 数据库句柄。
   *
   * 关闭后**所有** prepare 都返回空操作语句——写操作静默跳过。
   *
   * 为什么需要这一层：
   * 引擎退出时先 `planner.stop()`（不等待在途任务）再 `manifest.close()`。
   * 在途的上传任务恢复后还会调 `manifest.setState(...)`，
   * 对已关闭的连接会抛 "database is not open"。
   * 而这个异常经由 planner 的 `.catch(handleFatal)` 又会调一次 setState，
   * 再次抛出 → 变成无人接手的 Promise 拒绝 → **主进程被终止**。
   *
   * 用户看到的就是「上传途中退出，应用崩了」。
   *
   * 用代理而不是在每个方法里加判断：写操作点很多（40+），
   * 逐个加守卫一定会漏，漏一处就是同一个崩溃。
   */
  private readonly db: DatabaseSync
  /** 连接是否已关闭 */
  private closed = false

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.raw = new DatabaseSync(dbPath)
    // 先装好带守卫的句柄，再跑迁移——迁移内部要用 this.db.prepare
    this.db = this.makeGuardedDb(this.raw)
    this.db.exec(SCHEMA)
    this.migrate()
    this.migrateLog()
  }

  /**
   * 包一层：连接关闭后，prepare 返回空操作语句。
   *
   * 读操作在关闭后同样返回「空结果」而不是抛错——
   * 退出流程里读清单的代码路径也不该把整个进程带崩。
   */
  private makeGuardedDb(raw: DatabaseSync): DatabaseSync {
    const self = this
    return new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (self.closed) return makeNoopStatement()
            return target.prepare(sql)
          }
        }
        if (prop === 'exec') {
          return (sql: string) => {
            if (self.closed) return
            return target.exec(sql)
          }
        }
        return Reflect.get(target, prop, receiver)
      }
    })
  }
  /**
   * 增量迁移。
   *
   * `CREATE TABLE IF NOT EXISTS` 只在表不存在时生效，
   * 已存在的库不会因为 SCHEMA 变了就长出新列——
   * 旧版本建的库缺列时，查询会直接报 "no such column"。
   * 因此每次启动都要比对一次实际列，把缺的补上。
   *
   * 另外 local_inode 的列类型从 INTEGER 改成了 TEXT：
   * 老的库还留着 INTEGER 列的话，按 INTEGER 存进去再读出来
   * 会抛 "Value is too large to be represented as a JavaScript number"
   *（Windows 的文件索引号超过 2^53）。这种情况要重建表把值转成文本。
   */
  private migrate(): void {
    const info = this.db.prepare('PRAGMA table_info(files)').all() as {
      name: string
      type: string
    }[]
    const cols = new Map(info.map((c) => [c.name, (c.type || '').toUpperCase()]))

    // 补列：先加缺失的列，再判断是否需要重建表。
    // 顺序不能反——重建表会按 FILES_TABLE_SQL 建出完整列集，
    // 提前 ADD COLUMN 会造成重复列。
    const added = new Set<string>()
    if (!cols.has('local_inode')) {
      this.db.exec('ALTER TABLE files ADD COLUMN local_inode TEXT')
      added.add('local_inode')
    }
    if (!cols.has('synced_md5')) {
      this.db.exec('ALTER TABLE files ADD COLUMN synced_md5 TEXT')
      added.add('synced_md5')
    }
    if (!cols.has('synced_sha1')) {
      this.db.exec('ALTER TABLE files ADD COLUMN synced_sha1 TEXT')
      added.add('synced_sha1')
    }
    if (!cols.has('verify_level')) {
      this.db.exec('ALTER TABLE files ADD COLUMN verify_level TEXT')
      added.add('verify_level')
    }

    // 刚补完列就重建表没有意义（重建会带出全部列）
    if (added.has('local_inode')) return

    const type = cols.get('local_inode') ?? ''
    if (!type.includes('INT')) return

    // 老库是 INTEGER 列 → 重建表，把 inode 值转成文本
    this.db.exec('BEGIN')
    try {
      this.db.exec(
        FILES_TABLE_SQL
          .replace('CREATE TABLE IF NOT EXISTS files', 'CREATE TABLE files_new')
          .replace(/CREATE INDEX[^;]+;/g, '')
      )
      this.db.exec(`
        INSERT INTO files_new (
          id, local_path, local_size, mtime_ms, md5, sha1, remote_path,
          remote_size, remote_etag, synced_size, synced_mtime_ms, synced_md5, synced_sha1,
          local_inode, verify_level, state, last_sync_at, last_verify_at, error_msg, first_seen_at, deleted_at
        )
        SELECT
          id, local_path, local_size, mtime_ms, md5, sha1, remote_path,
          remote_size, remote_etag, synced_size, synced_mtime_ms, synced_md5, synced_sha1,
          CAST(local_inode AS TEXT),
          verify_level,
          state, last_sync_at, last_verify_at, error_msg, first_seen_at, deleted_at
        FROM files
      `)
      this.db.exec('DROP TABLE files')
      this.db.exec('ALTER TABLE files_new RENAME TO files')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_state ON files(state)')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_remote ON files(remote_path)')
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * sync_log 的增量迁移。
   *
   * 与 files 分开做：files 缺列时要重建表（inode 类型变了），
   * 而 sync_log 只是**新增**两列，ALTER TABLE 补上就行——
   * 日志是流水，重建会丢历史，没必要。
   */
  private migrateLog(): void {
    const info = this.db.prepare('PRAGMA table_info(sync_log)').all() as { name: string }[]
    const cols = new Set(info.map((c) => c.name))
    if (!cols.has('category')) {
      this.db.exec('ALTER TABLE sync_log ADD COLUMN category TEXT')
    }
    if (!cols.has('local_path')) {
      this.db.exec('ALTER TABLE sync_log ADD COLUMN local_path TEXT')
    }
    // 索引必须在补列之后建：老库补列前 category 还不存在。
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_log_category ON sync_log(category)')
  }

  /**
   * 关闭数据库连接。
   *
   * 幂等：重复调用不应抛错。引擎退出路径与测试清理都可能重复关闭，
   * 而 node:sqlite 对已关闭的连接再调 close() 会抛 "database is not open"。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.raw.close()
    } catch {
      // 已经关过了——无事可做
    }
  }

  /**
   * 执行一个写操作；连接已关闭时**静默跳过**。
   *
   * 为什么需要这一层：
   * 引擎退出时先 `planner.stop()`（不等待在途任务）再 `manifest.close()`。
   * 在途的上传任务恢复后还会调 `manifest.setState(...)`，
   * 对已关闭的连接会抛 "database is not open"。
   * 而这个异常经由 planner 的 `.catch(handleFatal)` 又会调一次 setState，
   * 再次抛出 → 变成无人接手的 Promise 拒绝 → **主进程被终止**。
   *
   * 用户看到的就是「上传途中退出，应用崩了」。
   */
  private write<T>(fn: (db: DatabaseSync) => T): T | undefined {
    if (this.closed) return undefined
    try {
      return fn(this.db)
    } catch (err) {
      // 连接刚好被关掉（竞态）：当作「没写成功」处理，不往上抛
      if (this.closed) return undefined
      throw err
    }
  }
  // ── files ───────────────────────────────────────────
  upsertFile(entry: {
    localPath: string
    localSize: number
    mtimeMs: number
    remotePath?: string | null
    state?: FileState
    /** 本地 inode，用于识别重命名（字符串：Windows 文件索引号超出 2^53） */
    inode?: string | null
  }): number {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO files (local_path, local_size, mtime_ms, remote_path, state, local_inode, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_path) DO UPDATE SET
           local_size = excluded.local_size,
           mtime_ms  = excluded.mtime_ms,
           remote_path = COALESCE(excluded.remote_path, files.remote_path),
           state = CASE WHEN excluded.state IS NULL THEN files.state ELSE excluded.state END,
           local_inode = COALESCE(excluded.local_inode, files.local_inode),
           deleted_at = NULL`
      )
      .run(
        entry.localPath,
        entry.localSize,
        entry.mtimeMs,
        entry.remotePath ?? null,
        entry.state ?? 'pending',
        entry.inode ?? null,
        now
      )

    const row = this.db
      .prepare('SELECT id FROM files WHERE local_path = ?')
      .get(entry.localPath) as { id: number }
    return row.id
  }

  getFile(localPath: string): FileEntry | null {
    const row = this.db.prepare('SELECT * FROM files WHERE local_path = ?').get(localPath) as
      | Record<string, unknown>
      | undefined
    return row ? (mapFileRow(row) as unknown as FileEntry) : null
  }

  getFileById(id: number): FileEntry | null {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? (mapFileRow(row) as unknown as FileEntry) : null
  }

  /**
   * 列出文件清单。
   *
   * 默认**降序**（local_path DESC）：用户要的「最新/最靠前的先看」，
   * 升序在几万行里等于让人自己滚到最底下。
   *
   * `offset` 配合 `limit` 做分页——数据量大时不能一次把六万行
   * 全塞进 IPC 的返回值里，那会让渲染进程卡住好几秒。
   */
  listFiles(
    opts: { state?: FileState; limit?: number; offset?: number; desc?: boolean } = {}
  ): FileEntry[] {
    const limit = opts.limit ?? 500
    const offset = opts.offset ?? 0
    const order = opts.desc === false ? 'local_path ASC' : 'local_path DESC'
    const sql = opts.state
      ? `SELECT * FROM files WHERE state = ? ORDER BY ${order} LIMIT ? OFFSET ?`
      : `SELECT * FROM files ORDER BY ${order} LIMIT ? OFFSET ?`
    const rows = (
      opts.state
        ? this.db.prepare(sql).all(opts.state, limit, offset)
        : this.db.prepare(sql).all(limit, offset)
    ) as Record<string, unknown>[]
    return rows.map((r) => mapFileRow(r) as unknown as FileEntry)
  }

  /** 文件总数（分页与「共 N 个」提示用） */
  countFiles(state?: FileState): number {
    const row = (
      state
        ? this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE state = ?').get(state)
        : this.db.prepare('SELECT COUNT(*) AS n FROM files').get()
    ) as { n: number } | undefined
    return row?.n ?? 0
  }

  /** 按多个状态批量查询（启动时恢复未完成任务用） */
  listFilesByStates(states: FileState[], limit = 1000): FileEntry[] {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE state IN (${placeholders}) ORDER BY local_path LIMIT ?`
      )
      .all(...(states as string[]), limit) as Record<string, unknown>[]
    return rows.map((r) => mapFileRow(r) as unknown as FileEntry)
  }

  /** 各状态的文件计数，用于概览统计卡 */
  countByState(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM files GROUP BY state')
      .all() as { state: string; n: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.state] = r.n
    return out
  }

  /** 清空远端快照（远端根目录变更时用） */
  clearRemoteSnapshot(): void {
    this.write((db) => db.prepare('DELETE FROM remote_snapshot').run())
  }

  /**
   * 远端根变更时，改写清单里已存的 remote_path 前缀。
   *
   * 为什么必须改写：remote_path 是**当时实际用的远端路径**。
   * 远端根从 `/A` 改成 `/B` 后，若还留着 `/A/...`，
   * 下一轮对账会拿着旧前缀去远端找文件 → 全部判「远端缺失」→ 整批重传。
   * 这正是「换了目录就重传一遍」的成因。
   *
   * 只有以旧根为前缀的路径才改写；其余（例如别的根下同步过的条目）不动。
   *
   * @returns 改写掉的行数
   */
  rewriteRemoteRoot(oldRoot: string, newRoot: string): number {
    const oldBase = oldRoot.replace(/\/+$/, '')
    const newBase = newRoot.replace(/\/+$/, '')
    if (!oldBase || oldBase === newBase) return 0

    const rows = this.db
      .prepare('SELECT id, remote_path FROM files WHERE remote_path IS NOT NULL')
      .all() as { id: number; remote_path: string }[]

    if (this.closed) return 0
    const update = this.db.prepare('UPDATE files SET remote_path = ? WHERE id = ?')
    let changed = 0
    for (const row of rows) {
      if (row.remote_path !== oldBase && !row.remote_path.startsWith(`${oldBase}/`)) continue
      const rest = row.remote_path.slice(oldBase.length)
      update.run(`${newBase}${rest}`, row.id)
      changed++
    }
    return changed
  }

  /**
   * L1 本地去重的快筛。
   *
   * 基准是**最近一次成功同步时**确认的 size + mtime：
   * 两者都与当前文件一致 → 文件自上次同步以来没变 → 完全不上传。
   *
   * 注意不能用 local_size / mtime_ms 做基准——那两列会被 upsertFile
   * 覆盖成当前值，拿它比较等于自己跟自己比，去重会永远命中。
   *
   * mtime 比较留 1ms 容差：文件系统的修改时间精度不一，
   * 而写入侧可能做过取整，直接用 `===` 会让去重永远不命中。
   */
  isUnchanged(localPath: string, size: number, mtimeMs: number): boolean {
    const row = this.db
      .prepare('SELECT synced_size, synced_mtime_ms FROM files WHERE local_path = ?')
      .get(localPath) as { synced_size: number | null; synced_mtime_ms: number | null } | undefined
    if (!row || row.synced_size === null || row.synced_mtime_ms === null) return false
    if (row.synced_size !== size) return false
    return Math.abs(row.synced_mtime_ms - mtimeMs) < 1
  }

  /** 该文件是否已经成功同步过（无论此后是否被修改） */
  isSynced(localPath: string): boolean {
    const row = this.db
      .prepare('SELECT synced_size FROM files WHERE local_path = ?')
      .get(localPath) as { synced_size: number | null } | undefined
    return !!row && row.synced_size !== null
  }

  /**
   * 「同名同大小」弱认定：把远端已有的文件认领成本地文件的同步基准。
   *
   * 场景：本地有文件、远端也有同名同大小的文件，但**本程序从未同步过它**
   * （清过 userData、或远端是从别处来的）。此时清单里没有任何基准，
   * L1/L2 都不命中 → 整批重传一遍，而远端那份内容其实已经在了。
   *
   * 认领之后写入 synced_size / synced_mtime_ms，
   * 下一轮扫描的 L1 快筛就会命中 → 零上行。
   *
   * ⚠️ 关键取舍：这里**只按名称与大小**判定，没校验内容。
   * 所以 verify_level 记 'size'（弱认定），界面必须能看出这条结论
   * 没有内容校验支撑。synced_md5 / synced_sha1 保持 NULL——
   * 没校验过内容就不能谎称哈希已确认，否则 L2 判重会拿本地哈希
   * 当成远端哈希去比，得出「远端重复」的假结论。
   *
   * @returns 是否真的认领了（false 表示已有行且处于在途状态，不能覆盖）
   */
  adoptRemote(entry: {
    localPath: string
    localSize: number
    mtimeMs: number
    remotePath: string
    remoteSize: number
  }): boolean {
    const existing = this.db
      .prepare('SELECT id, state, synced_size FROM files WHERE local_path = ?')
      .get(entry.localPath) as
      | { id: number; state: string; synced_size: number | null }
      | undefined

    /*
     * 真正在途的行不能覆盖。
     *
     * 'uploading' = 传输正在进行；'hashing' = 正在算哈希。
     * 这两种状态下行的状态由 Planner 收口，认领改写会让界面与实际脱节。
     *
     * 'hashed' 不算在途——它只是「哈希算完了、还没开始传」，
     * 上次会话中断留下的那种。认领它恰恰是本闸门想要的：远端已经有同样大小的文件，
     * 不必再传一遍。
     */
    if (existing && ['uploading', 'hashing'].includes(existing.state)) return false
    // 已经同步过（有基准）的行不改：它已有内容校验过的结论，
    // 弱认定反而会把结论降级。
    if (existing && existing.synced_size !== null) return false

    const now = Date.now()
    if (existing) {
      this.db
        .prepare(
          `UPDATE files SET
             local_size = ?, mtime_ms = ?, remote_path = ?, remote_size = ?,
             synced_size = ?, synced_mtime_ms = ?,
             state = 'synced', verify_level = 'size',
             error_msg = NULL, deleted_at = NULL, last_sync_at = ?
           WHERE local_path = ?`
        )
        .run(
          entry.localSize,
          entry.mtimeMs,
          entry.remotePath,
          entry.remoteSize,
          entry.localSize,
          entry.mtimeMs,
          now,
          entry.localPath
        )
      return true
    }

    this.db
      .prepare(
        `INSERT INTO files (
           local_path, local_size, mtime_ms, remote_path, remote_size,
           synced_size, synced_mtime_ms, state, verify_level,
           first_seen_at, last_sync_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', 'size', ?, ?)`
      )
      .run(
        entry.localPath,
        entry.localSize,
        entry.mtimeMs,
        entry.remotePath,
        entry.remoteSize,
        entry.localSize,
        entry.mtimeMs,
        now,
        now
      )
    return true
  }

  /**
   * 深度校验通过后升级可信级别：弱认定 → 哈希确认。
   *
   * 同时把哈希写进 synced_md5 / synced_sha1，
   * 让 L2 判重从这一刻起真正可用（此前 synced_* 为 NULL，L2 永远不命中）。
   */
  promoteToHashVerified(localPath: string, md5: string, sha1: string, remoteSize: number): void {
    this.db
      .prepare(
        `UPDATE files SET
           verify_level = 'hash',
           remote_size = ?,
           synced_md5 = ?, synced_sha1 = ?,
           state = 'synced',
           error_msg = NULL,
           last_sync_at = ?,
           last_verify_at = ?
         WHERE local_path = ?`
      )
      .run(remoteSize, md5, sha1, Date.now(), Date.now(), localPath)
  }

  /**
   * 重命名：把清单条目的本地路径改掉，保留远端路径与同步基准。
   *
   * 远端已经用 move 改过路径，本地只是「同一个文件换了个名字」，
   * 因此 synced_* 基准必须原样保留——否则下一轮扫描会误判为变更而重传。
   *
   * 新路径上若已有残留行（之前上传过同名文件）先删掉，
   * 否则 UNIQUE(local_path) 约束会让 UPDATE 失败。
   */
  renameLocalPath(
    oldPath: string,
    newPath: string,
    newRemotePath: string,
    stats: { size: number; mtimeMs: number; inode: string | null }
  ): void {
    if (oldPath === newPath) return
    this.write((db) =>
      db.prepare('DELETE FROM files WHERE local_path = ? AND local_path != ?').run(newPath, oldPath)
    )
    this.db
      .prepare(
        `UPDATE files SET
           local_path = ?,
           remote_path = ?,
           local_size = ?,
           mtime_ms = ?,
           local_inode = ?,
           state = 'synced',
           deleted_at = NULL,
           error_msg = NULL,
           last_sync_at = ?
         WHERE local_path = ?`
      )
      .run(newPath, newRemotePath, stats.size, stats.mtimeMs, stats.inode, Date.now(), oldPath)
  }

  /** 更新记录的 inode（文件被替换后 inode 会变） */
  setInode(localPath: string, inode: string | null): void {
    this.write((db) =>
      db.prepare('UPDATE files SET local_inode = ? WHERE local_path = ?').run(inode, localPath)
    )
  }

  setState(
    localPath: string,
    state: FileState,
    extra: {
      md5?: string
      sha1?: string
      remoteSize?: number
      /** 成功同步时写入 L1 去重基准 */
      syncedSize?: number
      syncedMtimeMs?: number
      /**
       * 成功同步时写入「远端那份内容」的哈希。
       *
       * 只在**确认远端已存好**之后写——它代表远端的状态，
       * 不是本地文件的当前状态。混用会让「远端重复」判定失真。
       */
      syncedMd5?: string
      syncedSha1?: string
      errorMsg?: string | null
    } = {}
  ): void {
    this.db
      .prepare(
        `UPDATE files SET
           state = ?,
           md5 = COALESCE(?, md5),
           sha1 = COALESCE(?, sha1),
           remote_size = COALESCE(?, remote_size),
           synced_size = COALESCE(?, synced_size),
           synced_mtime_ms = COALESCE(?, synced_mtime_ms),
           synced_md5 = COALESCE(?, synced_md5),
           synced_sha1 = COALESCE(?, synced_sha1),
           verify_level = CASE
             WHEN ? IS NOT NULL AND ? IS NOT NULL THEN 'hash'
             ELSE verify_level
           END,
           error_msg = ?,
           last_sync_at = CASE WHEN ? = 'synced' THEN ? ELSE last_sync_at END,
           deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END
         WHERE local_path = ?`
        )
        .run(
          state,
          extra.md5 ?? null,
          extra.sha1 ?? null,
          extra.remoteSize ?? null,
          extra.syncedSize ?? null,
          extra.syncedMtimeMs ?? null,
          extra.syncedMd5 ?? null,
          extra.syncedSha1 ?? null,
          // 写进「远端那份内容」的哈希 = 内容确实对上了 → 结论升级为哈希确认。
          // 只写 synced_size（认领）时不升级，verify_level 保持 'size'。
          extra.syncedMd5 ?? null,
          extra.syncedSha1 ?? null,
          extra.errorMsg ?? null,
          state,
          Date.now(),
          state,
          Date.now(),
          localPath
        )
  }

  markVerified(localPath: string): void {
    this.db
      .prepare('UPDATE files SET last_verify_at = ? WHERE local_path = ?')
      .run(Date.now(), localPath)
  }

  /**
   * 清掉同步基准（强制重新上传时用）。
   *
   * 为什么需要：L1 快筛与 L2 哈希判重都以 synced_* 为基准。
   * 深度校验发现「远端内容其实和本地不一样」时，若不清掉基准，
   * L2 会拿本地哈希和 synced_md5 一比——本地文件没改过就相等了 →
   * 判成「远端重复」→ 跳过上传 → 远端那份错的内容永远留在那里。
   *
   * 所以「强制重传」必须先把这套基准抹掉。
   */
  clearSyncBaseline(localPath: string): void {
    this.db
      .prepare(
        `UPDATE files SET
           synced_size = NULL, synced_mtime_ms = NULL,
           synced_md5 = NULL, synced_sha1 = NULL,
           verify_level = NULL
         WHERE local_path = ?`
      )
      .run(localPath)
  }

  // ── remote_snapshot ──────────────────────────────────
  upsertRemoteSnapshot(entry: {
    remotePath: string
    remoteSize: number
    remoteMtime: number | null
    isDir: boolean
    scanId: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO remote_snapshot (remote_path, remote_size, remote_mtime, is_dir, seen_at, scan_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(remote_path) DO UPDATE SET
           remote_size  = excluded.remote_size,
           remote_mtime = excluded.remote_mtime,
           is_dir       = excluded.is_dir,
           seen_at      = excluded.seen_at,
           scan_id      = excluded.scan_id`
      )
      .run(
        entry.remotePath,
        entry.remoteSize,
        entry.remoteMtime,
        entry.isDir ? 1 : 0,
        Date.now(),
        entry.scanId
      )
  }

  /** 本次扫描未看到的条目 → 远端已被删除 */
  pruneRemoteSnapshot(scanId: number, keepPaths: string[]): string[] {
    if (this.closed) return []
    const rows = this.db
      .prepare('SELECT remote_path FROM remote_snapshot WHERE scan_id != ?')
      .all(scanId) as { remote_path: string }[]
    const keep = new Set(keepPaths)
    const removed = rows.map((r) => r.remote_path).filter((p) => !keep.has(p))
    if (removed.length > 0) {
      const stmt = this.db.prepare('DELETE FROM remote_snapshot WHERE remote_path = ?')
      for (const p of removed) stmt.run(p)
    }
    return removed
  }

  // ── diffs ───────────────────────────────────────────
  /**
   * 记录一条对账差异。
   *
   * **幂等**：同一 kind + localPath + remotePath 若已有未处置的差异行，
   * 就更新那一行，而不是再插一条新的。
   *
   * 为什么必须幂等：同一路径每轮对账都会再次命中，
   * 纯 INSERT 会让同一个文件在界面上出现 N 次——
   * 用户看到「同一个差异列了 8 条」，根本没法判断真实差异数量。
   * 更新而不是删除重建，是为了保住原有的 id 与处置状态。
   *
   * 幂等键里**必须带 localPath**：只按 kind + remotePath 匹配的话，
   * 同一个远端路径先后以不同 localPath 出现（本地重命名过），
   * 旧行会被就地改写，历史处置记录丢失。
   *
   * 返回落库后的差异条目（含 id），供上层推给渲染进程。
   */
  recordDiff(diff: {
    kind: DiffEntry['kind']
    localPath: string | null
    remotePath: string
    localSize: number | null
    remoteSize: number | null
    localMtime: number | null
    remoteMtime: number | null
  }): DiffEntry {
    const existing = this.db
      .prepare(
        `SELECT id FROM diffs
          WHERE kind = ? AND remote_path = ? AND resolved_at IS NULL
            AND (local_path IS ? OR local_path = ?)
          LIMIT 1`
      )
      .get(diff.kind, diff.remotePath, diff.localPath, diff.localPath) as
      | { id: number }
      | undefined

    const now = Date.now()

    if (existing) {
      this.db
        .prepare(
          `UPDATE diffs SET
             local_path = ?, local_size = ?, remote_size = ?,
             local_mtime = ?, remote_mtime = ?, detected_at = ?
           WHERE id = ?`
        )
        .run(
          diff.localPath,
          diff.localSize,
          diff.remoteSize,
          diff.localMtime,
          diff.remoteMtime,
          now,
          existing.id
        )
      const row = this.db.prepare('SELECT * FROM diffs WHERE id = ?').get(existing.id) as Record<
        string,
        unknown
      >
      return mapDiffRow(row) as unknown as DiffEntry
    }

    const res = this.db
      .prepare(
        `INSERT INTO diffs (kind, local_path, remote_path, local_size, remote_size, local_mtime, remote_mtime, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        diff.kind,
        diff.localPath,
        diff.remotePath,
        diff.localSize,
        diff.remoteSize,
        diff.localMtime,
        diff.remoteMtime,
        now
      )
    const row = this.db
      .prepare('SELECT * FROM diffs WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Record<string, unknown>
    return mapDiffRow(row) as unknown as DiffEntry
  }

  /**
   * 未处置的差异列表。
   *
   * ⚠️ 过滤掉历史遗留的 `mtime_mismatch` 行。
   *
   * 「仅修改时间不同」已经不再算差异（复制、解压、跨设备同步都会改 mtime，
   * 而内容可能一模一样，列出来只是噪声）。但旧库里可能还留着这类行，
   * 它们不该再出现在对账清单与差异计数里。
   */
  listUnresolvedDiffs(): DiffEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM diffs
         WHERE resolved_at IS NULL AND kind != 'mtime_mismatch'
         ORDER BY detected_at DESC`
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => mapDiffRow(r) as unknown as DiffEntry)
  }

  /**
   * 标记差异为已处置。
   *
   * 返回处置后的完整条目（含 resolvedAt / resolution），
   * 供上层推给渲染进程——渲染层据此把这一行从列表里撤掉。
   */
  resolveDiff(diffId: number, resolution: DiffEntry['resolution']): DiffEntry | null {
    this.db
      .prepare('UPDATE diffs SET resolved_at = ?, resolution = ? WHERE id = ?')
      .run(Date.now(), resolution, diffId)
    const row = this.db.prepare('SELECT * FROM diffs WHERE id = ?').get(diffId) as
      | Record<string, unknown>
      | undefined
    return row ? (mapDiffRow(row) as unknown as DiffEntry) : null
  }

  // ── scans ───────────────────────────────────────────
  startScan(kind: ScanRecord['kind'], trigger: ScanRecord['trigger']): number {
    const res = this.db
      .prepare('INSERT INTO scans (kind, trigger, started_at) VALUES (?, ?, ?)')
      .run(kind, trigger, Date.now())
    return Number(res.lastInsertRowid)
  }

  /**
   * 取某个通道最近一次扫描记录。
   *
   * 为什么必须有这个：扫描结果以前只存在 engine 的内存字段里，
   * 程序一关就没了——用户重开应用看到「已扫描 0 个文件」，
   * 以为没扫过。实际上上一轮扫了六万个。
   *
   * scans 表一直都在，只是没人往里写、也没人读。
   */
  lastScan(kind: ScanRecord['kind']): ScanRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM scans WHERE kind = ? AND status != 'running'
          ORDER BY started_at DESC LIMIT 1`
      )
      .get(kind) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: Number(row.id),
      kind: row.kind as ScanRecord['kind'],
      trigger: row.trigger as ScanRecord['trigger'],
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      scannedCount: Number(row.scanned_count),
      changedCount: Number(row.changed_count),
      errorCount: Number(row.error_count),
      status: row.status as ScanRecord['status'],
      errorMsg: (row.error_msg as string | null) ?? null
    }
  }

  /** 某通道最近一次扫描记录的 id（续写用） */
  lastScanId(kind: ScanRecord['kind']): number | null {
    const row = this.db
      .prepare('SELECT id FROM scans WHERE kind = ? ORDER BY started_at DESC LIMIT 1')
      .get(kind) as { id: number } | undefined
    return row?.id ?? null
  }

  /** 某通道的扫描历史（倒序） */
  listScans(kind: ScanRecord['kind'], limit = 20): ScanRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM scans WHERE kind = ? ORDER BY started_at DESC LIMIT ?')
      .all(kind, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind as ScanRecord['kind'],
      trigger: row.trigger as ScanRecord['trigger'],
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      scannedCount: Number(row.scanned_count),
      changedCount: Number(row.changed_count),
      errorCount: Number(row.error_count),
      status: row.status as ScanRecord['status'],
      errorMsg: (row.error_msg as string | null) ?? null
    }))
  }

  /**
   * 更新某通道最近一次扫描的计数（不新建行）。
   *
   * 本地扫描是「持续」的：chokidar 的 ready 只报一次总数，
   * 但后续增量事件一直在来。写入 scans 表能保证重启后
   * 看到的仍是上次真实的数量，而不是 0。
   */
  updateLastScanCounts(kind: ScanRecord['kind'], counts: { scanned: number }): void {
    const id = this.lastScanId(kind)
    if (id === null) return
    this.db
      .prepare('UPDATE scans SET scanned_count = ?, finished_at = ? WHERE id = ?')
      .run(counts.scanned, Date.now(), id)
  }

  finishScan(
    scanId: number,
    status: ScanRecord['status'],
    counts: { scanned: number; changed: number; errors: number },
    errorMsg?: string
  ): void {
    this.db
      .prepare(
        `UPDATE scans SET finished_at = ?, scanned_count = ?, changed_count = ?,
           error_count = ?, status = ?, error_msg = ? WHERE id = ?`
      )
      .run(
        Date.now(),
        counts.scanned,
        counts.changed,
        counts.errors,
        status,
        errorMsg ?? null,
        scanId
      )
  }

  // ── 日志 ────────────────────────────────────────────
  /**
   * 写一条日志。
   *
   * `meta` 里的类别与文件路径是**结构化信息**，
   * 消息文本是给人读的补充说明。两者都要有：
   * 只有文本的话，日志页没法按类别筛选，也没法按文件查历史。
   */
  log(
    level: 'info' | 'warn' | 'error',
    message: string,
    fileId?: number | null,
    remote?: string | null,
    meta?: LogMeta
  ): void {
    this.db
      .prepare(
        'INSERT INTO sync_log (ts, level, message, file_id, remote, category, local_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        Date.now(),
        level,
        message,
        fileId ?? meta?.fileId ?? null,
        remote ?? meta?.remotePath ?? null,
        meta?.category ?? 'system',
        meta?.filePath ?? null
      )
  }

  recentLogs(limit = 200): LogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT ts, level, message, category, local_path, remote
         FROM sync_log ORDER BY ts DESC LIMIT ?`
      )
      .all(limit) as {
      ts: number
      level: string
      message: string
      category: string | null
      local_path: string | null
      remote: string | null
    }[]
    return rows.map((r) => ({
      ts: r.ts,
      level: r.level as LogEntry['level'],
      message: r.message,
      // 老数据没有 category 列，一律按「系统」处理
      category: (r.category as LogEntry['category']) ?? 'system',
      filePath: r.local_path,
      remotePath: r.remote
    }))
  }

  /**
   * 清空日志。
   *
   * 只清日志表，不碰 files / diffs / scans——那些是同步状态本身，
   * 删了会让程序忘记「哪些文件已经同步过」，从而整批重传。
   */
  clearLogs(): number {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM sync_log').get() as { n: number }
    this.write((db) => db.prepare('DELETE FROM sync_log').run())
    return n.n
  }
}

// ── 行映射：snake_case → camelCase ─────────────────────
function mapFileRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r['id'],
    localPath: r['local_path'],
    localSize: r['local_size'],
    mtimeMs: r['mtime_ms'],
    md5: r['md5'],
    sha1: r['sha1'],
    remotePath: r['remote_path'],
    remoteSize: r['remote_size'],
    remoteEtag: r['remote_etag'],
    syncedSize: r['synced_size'],
    syncedMtimeMs: r['synced_mtime_ms'],
    syncedMd5: r['synced_md5'] ?? null,
    syncedSha1: r['synced_sha1'] ?? null,
    verifyLevel: (r['verify_level'] as 'hash' | 'size' | null) ?? null,
    localInode: r['local_inode'] === null || r['local_inode'] === undefined ? null : String(r['local_inode']),
    state: r['state'],
    lastSyncAt: r['last_sync_at'],
    lastVerifyAt: r['last_verify_at'],
    errorMsg: r['error_msg'],
    firstSeenAt: r['first_seen_at'],
    deletedAt: r['deleted_at']
  }
}

function mapDiffRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r['id'],
    kind: r['kind'],
    localPath: r['local_path'],
    remotePath: r['remote_path'],
    localSize: r['local_size'],
    remoteSize: r['remote_size'],
    localMtime: r['local_mtime'],
    remoteMtime: r['remote_mtime'],
    detectedAt: r['detected_at'],
    resolvedAt: r['resolved_at'],
    resolution: r['resolution']
  }
}

/** 便于测试与诊断：返回清单库路径 */
export function defaultManifestPath(userDataPath: string): string {
  return `${userDataPath}/manifest.db`
}

/**
 * 空操作语句：连接已关闭时代替真实的 prepared statement。
 *
 * 所有方法都不报错，只是「什么都没做」：
 * - run() 返回「没有插入任何行」的结果
 * - get() 返回 undefined
 * - all() 返回空数组
 *
 * 这样退出流程里残留的写调用既不会崩，也不会产生半截数据。
 */
function makeNoopStatement(): StatementSync {
  const noop = {
    all: () => [],
    get: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    iterate: () => [][Symbol.iterator](),
    columns: () => [],
    setAllowBareNamedParameters: () => {},
    setAllowUnknownNamedParameters: () => {},
    setReadBigInts: () => {},
    setReturnArrays: () => {},
    expandedSQL: ''
  }
  return noop as unknown as StatementSync
}

export type { AppConfig }
