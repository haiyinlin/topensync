import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Reconciler } from '../src/main/reconcile/reconciler'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 「正在传输的文件不参与对账」。
 *
 * 用户实测告警：`等待上传完成超时（仍有 2705 个任务在跑），对账结果可能不完整`。
 *
 * 根因是旧的时序设计：对账前要等**整个上传队列**排空。整盘场景下队列里
 * 有上万个文件，30 秒必然超时——然后只能打一句既看不懂又没法处理的告警。
 *
 * 真正危险的不是「排队待传」（它们还没碰远端，清单里也没有 remote_path），
 * 而是**正在传的那几个**：远端还没有它们、或只有半截，比出来的
 * 「远端缺失」「大小不符」全是假差异，还会触发重传形成死循环。
 *
 * 所以改成：等一小会儿 → 还没完的就**跳过**，不计为差异。
 */

const CONFIG: AppConfig = {
  syncRoot: '',
  openlist: { baseUrl: 'http://127.0.0.1:5244', username: 'u', password: 'p' },
  remoteRoot: '/r',
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

/** 假远端：根目录下给定文件 */
function makeClient(files: { name: string; size: number }[]): OpenListClient {
  const list = vi.fn().mockImplementation(async (path: string) => ({
    content:
      path === '/r'
        ? files.map((f) => ({
            name: f.name,
            size: f.size,
            modified: '2026-01-01T00:00:00Z',
            isDir: false
          }))
        : [],
    total: files.length,
    provider: 'mock'
  }))
  return {
    list,
    confirmMissing: vi.fn().mockResolvedValue(true)
  } as unknown as OpenListClient
}

describe('对账：正在传输的文件不计为差异', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-inflight-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('远端有、清单没记，但本地正在上传 → 不产生 remote_only', async () => {
    const rec = new Reconciler({
      client: makeClient([{ name: 'a.txt', size: 10 }]),
      manifest,
      config: CONFIG,
      probeLocal: () => null,
      isTransferInFlight: (rel) => rel === 'a.txt'
    })

    const res = await rec.runNow()

    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
    expect(res.diffCount).toBe(0)
    expect(res.skippedInFlight).toBe(1)
  })

  it('大小不符，但本地正在上传（远端还是半截）→ 不产生 size_mismatch', async () => {
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1_700_000_000_000,
      remotePath: '/r/a.txt',
      state: 'uploading'
    })
    manifest.setState('a.txt', 'uploading', { remoteSize: 100 })

    const rec = new Reconciler({
      client: makeClient([{ name: 'a.txt', size: 40 }]),
      manifest,
      config: CONFIG,
      probeLocal: () => ({ size: 100, mtimeMs: 1_700_000_000_000 }),
      isTransferInFlight: () => true
    })

    const res = await rec.runNow()

    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
    expect(res.skippedInFlight).toBe(1)
  })

  it('远端缺失，但本地正在上传 → 不产生 missing_remote', async () => {
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1_700_000_000_000,
      remotePath: '/r/a.txt',
      state: 'pending'
    })

    const rec = new Reconciler({
      // 远端目录里放一个无关文件：空目录会被判成「列举不可信」，
      // 那样 missing_remote 分支根本不会执行，测不到想测的东西
      client: makeClient([{ name: 'b.txt', size: 10 }]),
      manifest,
      config: CONFIG,
      probeLocal: (rel) =>
        rel === 'a.txt' ? { size: 100, mtimeMs: 1_700_000_000_000 } : { size: 10, mtimeMs: 1 },
      isTransferInFlight: (rel) => rel === 'a.txt'
    })

    const res = await rec.runNow()

    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
    expect(res.skippedInFlight).toBe(1)
  })

  it('没有在途文件时，行为与以前一致（该报的差异照报）', async () => {
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1_700_000_000_000,
      remotePath: '/r/a.txt',
      state: 'pending'
    })

    const rec = new Reconciler({
      client: makeClient([{ name: 'b.txt', size: 10 }]),
      manifest,
      config: CONFIG,
      // b.txt 在本地确实存在（只是清单没记）→ 它不是差异
      probeLocal: (rel) => (rel === 'b.txt' ? { size: 10, mtimeMs: 1 } : null)
    })

    const res = await rec.runNow()

    /*
     * 这条记录是 `pending`（从没传过），所以类型是「仅本地」而不是
     * 「远端缺失」——后者专指「传过、后来没了」。
     * 但它照样要被列出来，否则「远端缺什么」的统计会少一截。
     */
    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.filter((d) => d.kind === 'local_only')).toHaveLength(1)
    expect(res.skippedInFlight).toBe(0)
  })
})
