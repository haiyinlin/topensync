import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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
})
