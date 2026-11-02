import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Reconciler } from '../src/main/reconcile/reconciler'
import { Planner } from '../src/main/planner/planner'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 「同名 + 同大小」认领。
 *
 * 背景：清单里没有同步基准时（清过 userData、换了台设备），
 * L1 快筛与 L2 哈希判重都不命中 → 整批文件完整上行一遍。
 * 而远端那份内容其实已经在了——白传一次不说，还会覆盖远端。
 *
 * 这条认领路只比对**文件名与大小**两个条件，**不校验内容**。
 * 所以：
 * - 认领必须打上 `verify_level='size'` 标记，让界面能看出来
 * - `synced_md5/synced_sha1` 必须保持 NULL——没校验内容不能谎称哈希确认
 * - 已同步过的文件不能走这条路（内容改了但大小不变时会漏传）
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
    adoptByNameAndSize: true,
    exclude: []
  }
}

async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('认领：Manifest.adoptRemote', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-adopt-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('认领写入同步基准，并标记为「仅大小」弱认定', () => {
    const ok = manifest.adoptRemote({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1_700_000_000_000,
      remotePath: '/quark-backup/a.txt',
      remoteSize: 100
    })

    expect(ok).toBe(true)
    const entry = manifest.getFile('a.txt')
    expect(entry?.state).toBe('synced')
    expect(entry?.syncedSize).toBe(100)
    expect(entry?.syncedMtimeMs).toBe(1_700_000_000_000)
    expect(entry?.remotePath).toBe('/quark-backup/a.txt')
    expect(entry?.verifyLevel).toBe('size')
  })

  it('认领**不写**哈希基准（没校验内容就不能谎称哈希确认）', () => {
    manifest.adoptRemote({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1,
      remotePath: '/quark-backup/a.txt',
      remoteSize: 100
    })

    const entry = manifest.getFile('a.txt')
    // 哈希基准必须为空：L2 判重要拿它跟远端那份内容比，
    // 填了本地哈希就会得出「远端重复」的假结论。
    expect(entry?.syncedMd5).toBeNull()
    expect(entry?.syncedSha1).toBeNull()
  })

  it('已经同步过的文件不再被认领（避免把强结论降级成弱结论）', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 100, mtimeMs: 1, state: 'synced' })
    manifest.setState('a.txt', 'synced', {
      remoteSize: 100,
      syncedSize: 100,
      syncedMtimeMs: 1,
      syncedMd5: 'a'.repeat(32),
      syncedSha1: 'b'.repeat(40)
    })

    const ok = manifest.adoptRemote({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1,
      remotePath: '/quark-backup/a.txt',
      remoteSize: 100
    })

    expect(ok).toBe(false)
    const entry = manifest.getFile('a.txt')
    expect(entry?.verifyLevel).toBe('hash')
    expect(entry?.syncedMd5).toBe('a'.repeat(32))
  })

  it('正在上传的行不被认领覆盖（状态由 Planner 收口）', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 100, mtimeMs: 1, state: 'uploading' })

    const ok = manifest.adoptRemote({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1,
      remotePath: '/quark-backup/a.txt',
      remoteSize: 100
    })

    expect(ok).toBe(false)
    expect(manifest.getFile('a.txt')?.state).toBe('uploading')
  })

  it('认领后 L1 快筛命中（下一轮扫描零上行）', () => {
    manifest.adoptRemote({
      localPath: 'a.txt',
      localSize: 100,
      mtimeMs: 1_700_000_000_000,
      remotePath: '/quark-backup/a.txt',
      remoteSize: 100
    })

    expect(manifest.isUnchanged('a.txt', 100, 1_700_000_000_000)).toBe(true)
    expect(manifest.isSynced('a.txt')).toBe(true)
  })
})

describe('认领：对账侧', () => {
  let dir: string
  let manifest: Manifest

  function makeClient(
    tree: Record<string, { name: string; isDir: boolean; size?: number }[]>
  ): OpenListClient {
    const list = vi.fn().mockImplementation(async (path: string) => {
      const entries = tree[path] ?? []
      return {
        content: entries.map((e) => ({
          name: e.name,
          size: e.size ?? 10,
          modified: '2026-01-01T00:00:00Z',
          isDir: e.isDir
        })),
        total: entries.length,
        provider: 'mock'
      }
    })
    return { list } as unknown as OpenListClient
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-adopt-recon-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('远端同名同大小 → 认领，不产生差异', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false, size: 100 }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: () => ({ size: 100, mtimeMs: 1_700_000_000_000 })
    })

    const res = await rec.runNow()

    expect(res.diffCount).toBe(0)
    const entry = manifest.getFile('a.txt')
    expect(entry?.state).toBe('synced')
    expect(entry?.verifyLevel).toBe('size')
    expect(entry?.syncedSize).toBe(100)
    expect(entry?.syncedMd5).toBeNull()
  })

  it('远端同名但大小不同 → 不认领', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false, size: 999 }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: () => ({ size: 100, mtimeMs: 1_700_000_000_000 })
    })

    await rec.runNow()

    // 没认领 → 清单里没有这条记录
    expect(manifest.getFile('a.txt')).toBeNull()
  })

  it('关掉认领开关 → 不认领', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false, size: 100 }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: {
        ...CONFIG,
        remoteScan: { ...CONFIG.remoteScan, adoptByNameAndSize: false }
      },
      probeLocal: () => ({ size: 100, mtimeMs: 1_700_000_000_000 })
    })

    await rec.runNow()

    expect(manifest.getFile('a.txt')).toBeNull()
  })

  it('认领按相对路径匹配：同名不同目录不会被认成一个文件', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'sub', isDir: true }],
      '/quark-backup/sub': [{ name: 'x.jpg', isDir: false, size: 100 }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      // 本地有的是根目录下的 x.jpg，不是 sub/x.jpg
      probeLocal: (relPath) =>
        relPath === 'x.jpg' ? { size: 100, mtimeMs: 1_700_000_000_000 } : null
    })

    await rec.runNow()

    // sub/x.jpg 在本地不存在 → 仍然是 remote_only 差异
    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.filter((d) => d.kind === 'remote_only')).toHaveLength(1)
    expect(diffs[0].remotePath).toBe('/quark-backup/sub/x.jpg')
    // 根目录的 x.jpg 没被认领（远端根下并没有这个文件）
    expect(manifest.getFile('x.jpg')).toBeNull()
  })
})

describe('认领：上传前闸门', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let list: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-adopt-planner-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })
    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })
    list = vi.fn().mockResolvedValue({
      content: [{ name: 'a.txt', size: 4, modified: '', isDir: false }],
      total: 1,
      provider: 'mock'
    })
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makePlanner(config: AppConfig = CONFIG): Planner {
    const planner = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        list,
        mkdir: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...config, syncRoot })
    })
    planner.start()
    return planner
  }

  it('远端已有同名同大小 → 不上传，记为「远端同名同大小」跳过', async () => {
    const p = join(syncRoot, 'a.txt')
    writeFileSync(p, 'data')
    const st = statSync(p)

    const planner = makePlanner()
    await planner.handleEvent('a.txt', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()
    const task = planner.getTasks().find((t) => t.localPath === 'a.txt')
    expect(task?.category).toBe('skip')
    expect(task?.skipReason).toBe('remote_size_match')

    const entry = manifest.getFile('a.txt')
    expect(entry?.state).toBe('synced')
    expect(entry?.verifyLevel).toBe('size')
    /*
     * 基准写的是本地真实的 mtime：写错会让下一轮 L1 快筛永远不命中。
     *
     * 比对留 1ms 容差：Planner 用 bigint stat 读 mtime，
     * BigInt 除法会把小数部分截掉（整毫秒），
     * 而浮点 stat 给出的是带小数的毫秒。
     */
    expect(Math.abs((entry?.syncedMtimeMs ?? 0) - st.mtimeMs)).toBeLessThan(1)
    planner.stop()
  })

  it('远端没有同名文件 → 正常上传', async () => {
    const p = join(syncRoot, 'b.txt')
    writeFileSync(p, 'data')

    list.mockResolvedValue({ content: [], total: 0, provider: 'mock' })

    const planner = makePlanner()
    await planner.handleEvent('b.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    planner.stop()
  })

  it('远端同名但大小不同 → 正常上传（覆盖）', async () => {
    const p = join(syncRoot, 'a.txt')
    writeFileSync(p, 'data')

    list.mockResolvedValue({
      content: [{ name: 'a.txt', size: 999, modified: '', isDir: false }],
      total: 1,
      provider: 'mock'
    })

    const planner = makePlanner()
    await planner.handleEvent('a.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    planner.stop()
  })

  it('已同步过的文件不走认领：内容变了但大小不变时仍要上传', async () => {
    const p = join(syncRoot, 'c.txt')
    writeFileSync(p, 'data')
    const st = statSync(p)

    // 造一条「已同步」记录（上次同步的是另一个内容，但大小相同）
    manifest.upsertFile({
      localPath: 'c.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('c.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: st.mtimeMs - 1000,
      syncedMd5: '0'.repeat(32),
      syncedSha1: '1'.repeat(40)
    })

    // 远端有同名同大小的文件——若走认领就会漏传
    list.mockResolvedValue({
      content: [{ name: 'c.txt', size: st.size, modified: '', isDir: false }],
      total: 1,
      provider: 'mock'
    })

    const planner = makePlanner()
    await planner.handleEvent('c.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    planner.stop()
  })

  it('关掉认领开关 → 一律走正常上传', async () => {
    const p = join(syncRoot, 'a.txt')
    writeFileSync(p, 'data')

    const planner = makePlanner({
      ...CONFIG,
      remoteScan: { ...CONFIG.remoteScan, adoptByNameAndSize: false }
    })
    await planner.handleEvent('a.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    planner.stop()
  })
})
