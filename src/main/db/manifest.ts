import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { AppConfig, FileEntry, FileState, DiffEntry, ScanRecord } from '@shared/types'

/**
 * 本地清单数据库（node:sqlite，Electron 36+ 内置，无 native 编译）。
 *
 * Schema 是数据层的唯一权威定义。
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- 每个本地文件的当前已知状态
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
  state           TEXT NOT NULL DEFAULT 'pending',
  last_sync_at    INTEGER,
  last_verify_at  INTEGER,
  error_msg       TEXT,
  first_seen_at   INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_state ON files(state);
CREATE INDEX IF NOT EXISTS idx_files_remote ON files(remote_path);

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
CREATE TABLE IF NOT EXISTS sync_log (
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL,
  message   TEXT NOT NULL,
  file_id   INTEGER,
  remote    TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON sync_log(ts);
`

export class Manifest {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ── files ───────────────────────────────────────────
  upsertFile(entry: {
    localPath: string
    localSize: number
    mtimeMs: number
    remotePath?: string | null
    state?: FileState
  }): number {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO files (local_path, local_size, mtime_ms, remote_path, state, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_path) DO UPDATE SET
           local_size = excluded.local_size,
           mtime_ms  = excluded.mtime_ms,
           remote_path = COALESCE(excluded.remote_path, files.remote_path),
           state = CASE WHEN excluded.state IS NULL THEN files.state ELSE excluded.state END,
           deleted_at = NULL`
      )
      .run(
        entry.localPath,
        entry.localSize,
        entry.mtimeMs,
        entry.remotePath ?? null,
        entry.state ?? 'pending',
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

  listFiles(opts: { state?: FileState; limit?: number } = {}): FileEntry[] {
    const limit = opts.limit ?? 500
    const rows = opts.state
      ? (this.db
          .prepare('SELECT * FROM files WHERE state = ? ORDER BY local_path LIMIT ?')
          .all(opts.state, limit) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM files ORDER BY local_path LIMIT ?')
          .all(limit) as Record<string, unknown>[])
    return rows.map((r) => mapFileRow(r) as unknown as FileEntry)
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
    this.db.prepare('DELETE FROM remote_snapshot').run()
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
  recordDiff(diff: {
    kind: DiffEntry['kind']
    localPath: string | null
    remotePath: string
    localSize: number | null
    remoteSize: number | null
    localMtime: number | null
    remoteMtime: number | null
  }): void {
    this.db
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
        Date.now()
      )
  }

  listUnresolvedDiffs(): DiffEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM diffs WHERE resolved_at IS NULL ORDER BY detected_at DESC')
      .all() as Record<string, unknown>[]
    return rows.map((r) => mapDiffRow(r) as unknown as DiffEntry)
  }

  resolveDiff(diffId: number, resolution: DiffEntry['resolution']): void {
    this.db
      .prepare('UPDATE diffs SET resolved_at = ?, resolution = ? WHERE id = ?')
      .run(Date.now(), resolution, diffId)
  }

  // ── scans ───────────────────────────────────────────
  startScan(kind: ScanRecord['kind'], trigger: ScanRecord['trigger']): number {
    const res = this.db
      .prepare('INSERT INTO scans (kind, trigger, started_at) VALUES (?, ?, ?)')
      .run(kind, trigger, Date.now())
    return Number(res.lastInsertRowid)
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
  log(level: 'info' | 'warn' | 'error', message: string, fileId?: number, remote?: string): void {
    this.db
      .prepare('INSERT INTO sync_log (ts, level, message, file_id, remote) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), level, message, fileId ?? null, remote ?? null)
  }

  recentLogs(limit = 200): { ts: number; level: string; message: string }[] {
    return this.db
      .prepare('SELECT ts, level, message FROM sync_log ORDER BY ts DESC LIMIT ?')
      .all(limit) as { ts: number; level: string; message: string }[]
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

export type { AppConfig }
