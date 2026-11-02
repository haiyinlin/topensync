import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'

/**
 * 本地清单的契约测试。
 *
 * 重点锁死 L1 去重的语义：**基准必须是「上次成功同步时的 size + mtime」**。
 * 曾经用 local_size / mtime_ms 做基准，而那两列会被 upsert 覆盖成当前值，
 * 等于自己跟自己比，去重永远命中——表现为「文件改了也不重传」。
 */
describe('Manifest', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-manifest-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // ── L1 去重 ────────────────────────────────────────────

  it('从未同步过的文件不算「未变化」', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 100 })
    expect(manifest.isUnchanged('a.txt', 10, 100)).toBe(false)
    expect(manifest.isSynced('a.txt')).toBe(false)
  })

  it('同步成功后 size+mtime 都一致才算未变化', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 100 })
    manifest.setState('a.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 100
    })
    expect(manifest.isUnchanged('a.txt', 10, 100)).toBe(true)
    expect(manifest.isSynced('a.txt')).toBe(true)
  })

  it('mtime 变了就不算未变化', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 100 })
    manifest.setState('a.txt', 'synced', { syncedSize: 10, syncedMtimeMs: 100 })
    expect(manifest.isUnchanged('a.txt', 10, 200)).toBe(false)
  })

  it('size 变了就不算未变化', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 100 })
    manifest.setState('a.txt', 'synced', { syncedSize: 10, syncedMtimeMs: 100 })
    expect(manifest.isUnchanged('a.txt', 20, 100)).toBe(false)
  })

  it('mtime 比较留 1ms 容差（写入侧取整也不会让去重失效）', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 1000.456 })
    // 写入侧做了取整
    manifest.setState('a.txt', 'synced', { syncedSize: 10, syncedMtimeMs: 1000 })
    expect(manifest.isUnchanged('a.txt', 10, 1000.456)).toBe(true)
  })

  it('mtime 真的变了（超过容差）就不算未变化', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 1000 })
    manifest.setState('a.txt', 'synced', { syncedSize: 10, syncedMtimeMs: 1000 })
    expect(manifest.isUnchanged('a.txt', 10, 1002)).toBe(false)
  })

  it('回归：upsert 覆盖当前 size/mtime 不会污染 L1 基准', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 100 })
    manifest.setState('a.txt', 'synced', { syncedSize: 10, syncedMtimeMs: 100 })

    // 上层再次 upsert 当前状态（文件已被改动）
    manifest.upsertFile({ localPath: 'a.txt', localSize: 20, mtimeMs: 300 })

    // 同步基准仍是上次成功同步的那组值
    expect(manifest.isUnchanged('a.txt', 10, 100)).toBe(true)
    // 当前值已经变了，必须重传
    expect(manifest.isUnchanged('a.txt', 20, 300)).toBe(false)
  })

  // ── 状态与统计 ────────────────────────────────────────

  it('countByState 按状态汇总文件数', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 1, mtimeMs: 1, state: 'synced' })
    manifest.upsertFile({ localPath: 'b.txt', localSize: 1, mtimeMs: 1, state: 'pending' })
    manifest.upsertFile({ localPath: 'c.txt', localSize: 1, mtimeMs: 1, state: 'pending' })

    const counts = manifest.countByState()
    expect(counts['synced']).toBe(1)
    expect(counts['pending']).toBe(2)
  })

  it('listFilesByStates 支持多状态查询（启动恢复用）', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 1, mtimeMs: 1, state: 'uploading' })
    manifest.upsertFile({ localPath: 'b.txt', localSize: 1, mtimeMs: 1, state: 'error' })
    manifest.upsertFile({ localPath: 'c.txt', localSize: 1, mtimeMs: 1, state: 'synced' })

    const pending = manifest.listFilesByStates(['uploading', 'error'])
    expect(pending.map((f) => f.localPath).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('upsert 不会丢掉已有的远端路径', () => {
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: 1,
      mtimeMs: 1,
      remotePath: '/remote/a.txt'
    })
    manifest.upsertFile({ localPath: 'a.txt', localSize: 2, mtimeMs: 2 })
    expect(manifest.getFile('a.txt')?.remotePath).toBe('/remote/a.txt')
  })

  // ── 对账差异 ──────────────────────────────────────────

  it('差异写入后可列出，处置后不再出现在未处置列表', () => {
    manifest.recordDiff({
      kind: 'missing_remote',
      localPath: 'a.txt',
      remotePath: '/remote/a.txt',
      localSize: 10,
      remoteSize: null,
      localMtime: 100,
      remoteMtime: null
    })

    const open = manifest.listUnresolvedDiffs()
    expect(open).toHaveLength(1)
    expect(open[0].kind).toBe('missing_remote')

    manifest.resolveDiff(open[0].id, 'uploaded')
    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
  })

  // ── 日志 ──────────────────────────────────────────────

  it('日志按时间倒序返回', () => {
    manifest.log('info', '第一条')
    manifest.log('error', '第二条')
    const logs = manifest.recentLogs(10)
    expect(logs).toHaveLength(2)
    expect(logs[0].message).toBe('第二条')
  })

  // ── inode 与重命名 ─────────────────────────────────────

  it('inode 会被记录并在重复 upsert 时保留', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 1, mtimeMs: 1, inode: '12345' })
    expect(manifest.getFile('a.txt')?.localInode).toBe('12345')

    // 后续 upsert 没带 inode 时不该把已有的清掉
    manifest.upsertFile({ localPath: 'a.txt', localSize: 2, mtimeMs: 2 })
    expect(manifest.getFile('a.txt')?.localInode).toBe('12345')
  })

  it('重命名后路径改变但同步基准保留', () => {
    manifest.upsertFile({
      localPath: 'old.txt',
      localSize: 10,
      mtimeMs: 100,
      remotePath: '/remote/old.txt',
      state: 'synced'
    })
    manifest.setState('old.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 100
    })

    manifest.renameLocalPath('old.txt', 'new.txt', '/remote/new.txt', {
      size: 10,
      mtimeMs: 100,
      inode: '777' 
    })

    const entry = manifest.getFile('new.txt')
    expect(entry?.remotePath).toBe('/remote/new.txt')
    expect(entry?.state).toBe('synced')
    // 同步基准必须原样保留，否则下一轮扫描会误判为变更而重传
    expect(entry?.syncedSize).toBe(10)
    expect(entry?.syncedMtimeMs).toBe(100)
    expect(entry?.localInode).toBe('777')
    expect(manifest.getFile('old.txt')).toBeNull()
  })

  it('重命名到已存在的路径时旧行被清掉，不会触发唯一约束', () => {
    manifest.upsertFile({ localPath: 'old.txt', localSize: 1, mtimeMs: 1, state: 'synced' })
    manifest.upsertFile({ localPath: 'new.txt', localSize: 2, mtimeMs: 2, state: 'pending' })

    expect(() =>
      manifest.renameLocalPath('old.txt', 'new.txt', '/remote/new.txt', {
        size: 1,
        mtimeMs: 1,
        inode: '5'
      })
    ).not.toThrow()

    expect(manifest.getFile('new.txt')?.state).toBe('synced')
  })

  it('旧库缺少 local_inode 列时会自动补上', () => {
    // 用一个「加 local_inode 之前」的完整表结构模拟老数据文件。
    // 列必须齐全——SCHEMA 里的索引会引用 remote_path 等列。
    const legacy = new DatabaseSync(join(dir, 'legacy.db'))
    legacy.exec(`
      CREATE TABLE files (
        id              INTEGER PRIMARY KEY,
        local_path      TEXT NOT NULL UNIQUE,
        local_size      INTEGER NOT NULL,
        mtime_ms        INTEGER NOT NULL,
        md5             TEXT,
        sha1            TEXT,
        remote_path     TEXT,
        remote_size     INTEGER,
        remote_etag     TEXT,
        synced_size     INTEGER,
        synced_mtime_ms INTEGER,
        state           TEXT NOT NULL DEFAULT 'pending',
        last_sync_at    INTEGER,
        last_verify_at  INTEGER,
        error_msg       TEXT,
        first_seen_at   INTEGER NOT NULL,
        deleted_at      INTEGER
      );
    `)
    legacy.close()

    const upgraded = new Manifest(join(dir, 'legacy.db'))
    // 列补上了，写入不报错
    upgraded.upsertFile({ localPath: 'x.txt', localSize: 1, mtimeMs: 1, inode: '42' })
    expect(upgraded.getFile('x.txt')?.localInode).toBe('42')
    upgraded.close()
  })

  it('超过 2^53 的 inode 能原样存取（Windows 文件索引号必然超）', () => {
    // 真实 Windows 上 stat.ino 形如 11540474047102422，
    // 超过 JS 的 2^53 安全整数范围。早期按 INTEGER 存，
    // 读出来会抛 "Value is too large to be represented as a JavaScript number"。
    const huge = '11540474047102422'
    manifest.upsertFile({ localPath: 'huge.txt', localSize: 1, mtimeMs: 1, inode: huge })
    expect(manifest.getFile('huge.txt')?.localInode).toBe(huge)

    // 重命名路径更新时也要能原样带上
    manifest.renameLocalPath('huge.txt', 'huge2.txt', '/remote/huge2.txt', {
      size: 1,
      mtimeMs: 1,
      inode: huge
    })
    expect(manifest.getFile('huge2.txt')?.localInode).toBe(huge)
  })

  it('老库 local_inode 是 INTEGER 列时会重建表转成文本', () => {
    const legacy = new DatabaseSync(join(dir, 'legacy-int.db'))
    legacy.exec(`
      CREATE TABLE files (
        id              INTEGER PRIMARY KEY,
        local_path      TEXT NOT NULL UNIQUE,
        local_size      INTEGER NOT NULL,
        mtime_ms        INTEGER NOT NULL,
        md5             TEXT,
        sha1            TEXT,
        remote_path     TEXT,
        remote_size     INTEGER,
        remote_etag     TEXT,
        synced_size     INTEGER,
        synced_mtime_ms INTEGER,
        local_inode     INTEGER,
        state           TEXT NOT NULL DEFAULT 'pending',
        last_sync_at    INTEGER,
        last_verify_at  INTEGER,
        error_msg       TEXT,
        first_seen_at   INTEGER NOT NULL,
        deleted_at      INTEGER
      );
    `)
    // 模拟老库里的真实值：整数列里存着超 2^53 的文件索引号
    legacy
      .prepare(
        `INSERT INTO files (local_path, local_size, mtime_ms, local_inode, state, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('old.txt', 1, 1, '11540474047102422', 'synced', Date.now())
    legacy.close()

    const upgraded = new Manifest(join(dir, 'legacy-int.db'))
    expect(upgraded.getFile('old.txt')?.localInode).toBe('11540474047102422')
    expect(upgraded.getFile('old.txt')?.state).toBe('synced')
    upgraded.close()
  })
})
