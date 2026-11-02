import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Reconciler } from '../src/main/reconcile/reconciler'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig, DiffEntry } from '../src/shared/types'

/**
 * 对账差异的行为测试。
 *
 * 用户的原话：「对账没有列举差异文件和清单，即使是远端有，本地没有」。
 *
 * 根因有三条，这里逐条锁死：
 * 1. 差异只落库、不上报 → 渲染进程永远收不到
 * 2. 每轮对账都 INSERT 一条 → 同一个文件在界面上列 N 次
 * 3. remote_only 的 localPath 为空 → 「下载到本地」必抛「没有对应的本地路径」
 */

const CONFIG: AppConfig = {
  syncRoot: '',
  openlist: { baseUrl: 'http://127.0.0.1:5244', username: 'u', password: 'p' },
  remoteRoot: '/quark-backup',
  hashConcurrency: 2,
  uploadConcurrency: 2,
  singlePutMaxBytes: 8 * 1024 * 1024,
  chunkConcurrency: 2,
  deletePolicy: 'trash',
  trashRoot: '_trash',
  maxDeletesPerRun: 200,
  maxDeleteBytesPerRun: 10 * 1024 * 1024 * 1024,
  retry: { maxAttempts: 3, baseDelayMs: 10 },
  exclude: [],
  verifyMode: 'size',
  verifyHashMaxBytes: 64 * 1024 * 1024,
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  syncEmptyDirs: false,
  detectRenames: false,
  renameWindowMs: 5000,
  remoteScan: {
    enabled: true,
    intervalHours: 6,
    onStartup: false,
    refresh: true,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20,
    exclude: []
  }
}

describe('对账差异的上报与去重', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-diff-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 造一个只有 a.txt 的假远端 */
  function makeClient(): OpenListClient {
    return {
      list: vi.fn().mockResolvedValue({
        content: [{ name: 'a.txt', size: 10, modified: '2026-01-01T00:00:00Z', isDir: false }],
        total: 1,
        provider: 'mock'
      }),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    } as unknown as OpenListClient
  }

  it('远端独有的文件会被记录为差异并上报', async () => {
    const reported: DiffEntry[] = []
    const rec = new Reconciler({
      client: makeClient(),
      manifest,
      config: CONFIG,
      onDiffRecorded: (d) => reported.push(d)
    })

    await rec.runNow()

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs).toHaveLength(1)
    expect(diffs[0].kind).toBe('remote_only')
    expect(diffs[0].remotePath).toBe('/quark-backup/a.txt')

    // 上报：渲染进程靠这个事件刷新差异列表
    expect(reported).toHaveLength(1)
    expect(reported[0].kind).toBe('remote_only')
  })

  it('「远端有、本地无」的差异带本地路径，下载才有落点', async () => {
    const rec = new Reconciler({ client: makeClient(), manifest, config: CONFIG })
    await rec.runNow()

    const diff = manifest.listUnresolvedDiffs()[0]
    // 本地文件并不存在，但这条路径是它「应该在的位置」——
    // 没有它，「下载到本地」就找不到落点
    expect(diff.localPath).toBe('a.txt')
  })

  it('重复对账同一路径不会产生重复差异行', async () => {
    const rec = new Reconciler({ client: makeClient(), manifest, config: CONFIG })

    await rec.runNow()
    await rec.runNow()
    await rec.runNow()

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs, '同一个差异不能列成三条').toHaveLength(1)
  })

  it('重复对账更新的是同一条记录（id 保持不变）', async () => {
    const rec = new Reconciler({ client: makeClient(), manifest, config: CONFIG })

    await rec.runNow()
    const first = manifest.listUnresolvedDiffs()[0]
    await rec.runNow()
    const second = manifest.listUnresolvedDiffs()[0]

    expect(second.id).toBe(first.id)
  })

  it('pull 策略通过 onPull 回调排下载，而不是自己偷偷下载', async () => {
    const pulls: { relPath: string; remotePath: string; size: number }[] = []
    const downloadTo = vi.fn().mockResolvedValue(undefined)

    const rec = new Reconciler({
      client: {
        list: vi.fn().mockResolvedValue({
          content: [
            { name: 'extra.txt', size: 42, modified: '2026-01-01T00:00:00Z', isDir: false }
          ],
          total: 1,
          provider: 'mock'
        }),
        downloadTo
      } as unknown as OpenListClient,
      manifest,
      config: {
        ...CONFIG,
        syncRoot: join(dir, 'sync'),
        remoteScan: { ...CONFIG.remoteScan, remoteOnlyPolicy: 'pull' }
      },
      onPull: (p) => pulls.push(p)
    })

    await rec.runNow()

    expect(pulls).toHaveLength(1)
    expect(pulls[0].relPath).toBe('extra.txt')
    expect(pulls[0].remotePath).toBe('/quark-backup/extra.txt')
    expect(pulls[0].size).toBe(42)
    // 下载由 Planner 接管，Reconciler 自己不该直接调 downloadTo
    expect(downloadTo).not.toHaveBeenCalled()
  })

  it('对账结束时回调 onComplete，让统计能落库', async () => {
    const completed: { diffCount: number; scannedFiles: number }[] = []
    const rec = new Reconciler({
      client: makeClient(),
      manifest,
      config: CONFIG,
      onComplete: (r) => completed.push({ diffCount: r.diffCount, scannedFiles: r.scannedFiles })
    })

    await rec.runNow()

    expect(completed).toHaveLength(1)
    expect(completed[0].diffCount).toBe(1)
    expect(completed[0].scannedFiles).toBe(1)
  })
})

describe('差异记录的幂等性（清单库层）', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-diff-idem-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('同 kind + 同 remotePath 只保留一条未处置差异', () => {
    const input = {
      kind: 'remote_only' as const,
      localPath: null,
      remotePath: '/quark-backup/a.txt',
      localSize: null,
      remoteSize: 10,
      localMtime: null,
      remoteMtime: 1
    }

    const first = manifest.recordDiff(input)
    const second = manifest.recordDiff(input)

    expect(second.id).toBe(first.id)
    expect(manifest.listUnresolvedDiffs()).toHaveLength(1)
  })

  it('不同 kind 的同一路径各自保留一条', () => {
    manifest.recordDiff({
      kind: 'remote_only',
      localPath: null,
      remotePath: '/quark-backup/a.txt',
      localSize: null,
      remoteSize: 10,
      localMtime: null,
      remoteMtime: 1
    })
    manifest.recordDiff({
      kind: 'size_mismatch',
      localPath: 'a.txt',
      remotePath: '/quark-backup/a.txt',
      localSize: 5,
      remoteSize: 10,
      localMtime: 1,
      remoteMtime: 1
    })

    expect(manifest.listUnresolvedDiffs()).toHaveLength(2)
  })

  it('已处置的差异不会被新一轮的同路径记录顶掉', () => {
    const first = manifest.recordDiff({
      kind: 'remote_only',
      localPath: 'a.txt',
      remotePath: '/quark-backup/a.txt',
      localSize: null,
      remoteSize: 10,
      localMtime: null,
      remoteMtime: 1
    })
    manifest.resolveDiff(first.id, 'ignored')

    const second = manifest.recordDiff({
      kind: 'remote_only',
      localPath: 'a.txt',
      remotePath: '/quark-backup/a.txt',
      localSize: null,
      remoteSize: 10,
      localMtime: null,
      remoteMtime: 1
    })

    // 已处置的保持历史，新的另起一条
    expect(second.id).not.toBe(first.id)
    expect(manifest.listUnresolvedDiffs()).toHaveLength(1)
  })
})
