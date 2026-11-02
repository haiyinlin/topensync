import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 「传输类别」的行为测试。
 *
 * 用户要看到的是：这个文件**在干什么**，以及**为什么没传**。
 * 所以三个类别各自要有可验证的落地：
 *
 * - upload   → 真的调了上传
 * - download → 真的调了下载，且带进度
 * - skip     → 真的没传，且说得出是「本地未变」还是「远端已有」
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

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('传输类别与跳过原因', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let downloadTo: ReturnType<typeof vi.fn>
  let planner: Planner
  let skipDetail: { local: number; remote: number; total: number }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-category-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })
    downloadTo = vi.fn().mockResolvedValue(undefined)
    skipDetail = { local: 0, remote: 0, total: 0 }

    const transfer = { upload } as unknown as Transfer
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      downloadTo
    } as unknown as OpenListClient

    planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => ({ ...CONFIG, syncRoot }),
      onSkipDetail: (d) => {
        skipDetail = d
      }
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('L1 命中产出「跳过 / 本地重复」任务，且不上传', async () => {
    const p = join(syncRoot, 'same.txt')
    writeFileSync(p, 'hello')
    const st = statSync(p)

    manifest.upsertFile({
      localPath: 'same.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('same.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs)
    })

    await planner.handleEvent('same.txt', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()

    const task = planner.getTasks().find((t) => t.localPath === 'same.txt')
    expect(task, '跳过也要有任务记录，用户才问得出「为什么没传」').toBeDefined()
    expect(task!.category).toBe('skip')
    expect(task!.skipReason).toBe('local_duplicate')
    expect(task!.state).toBe('skipped')

    expect(skipDetail.local).toBe(1)
    expect(skipDetail.remote).toBe(0)
    expect(skipDetail.total).toBe(1)
  })

  it('远端已有同样内容时产出「跳过 / 远端重复」任务，且不上传', async () => {
    const p = join(syncRoot, 'dup.txt')
    writeFileSync(p, 'same-content')
    const st = statSync(p)

    // 造一条「远端已存着同样内容」的记录：
    // synced_md5/synced_sha1 是上次成功同步时远端那份内容的哈希。
    manifest.upsertFile({
      localPath: 'dup.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    // 先用真实哈希填上：直接算一次
    const { hashFile } = await import('../src/main/hash/hashes')
    const hashes = await hashFile(p)
    manifest.setState('dup.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs),
      syncedMd5: hashes.md5,
      syncedSha1: hashes.sha1
    })

    // 改一下 mtime 让 L1 不命中（size 也要变，否则 size 相同仍会被 L1 判为未变）
    // → 这里改内容为**同样的内容**是不行的（size 变了）。
    // 正确做法：改内容但保持哈希？不可能。
    // 所以：让 L1 失效靠 mtime 变化，且 size 也变——那就说明内容变了。
    // 因此远端重复的判定场景是：文件被 touch（mtime 变、size 不变）。
    // L1 的判定要求 size 和 mtime 同时一致才命中，所以 size 不变、mtime 变 → L1 不命中。
    writeFileSync(p, 'same-content')
    // touch：改 mtime 不改内容
    const future = new Date(Date.now() + 5000)
    require('fs').utimesSync(p, future, future)

    await planner.handleEvent('dup.txt', true)
    await settle()

    expect(upload, '远端已有同样内容就不该再上行').not.toHaveBeenCalled()

    const task = planner.getTasks().find((t) => t.localPath === 'dup.txt')
    expect(task).toBeDefined()
    expect(task!.category).toBe('skip')
    expect(task!.skipReason).toBe('remote_duplicate')
    expect(task!.state).toBe('skipped')

    expect(skipDetail.remote).toBe(1)
    expect(skipDetail.local).toBe(0)
  })

  it('上传类任务默认类别为 upload', async () => {
    const p = join(syncRoot, 'new.txt')
    writeFileSync(p, 'data')

    await planner.handleEvent('new.txt', true)
    await settle()

    const task = planner.getTasks().find((t) => t.localPath === 'new.txt')
    expect(task!.category).toBe('upload')
    expect(task!.skipReason).toBeNull()
  })

  it('下载任务类别为 download，并在完成后标记完成', async () => {
    // 模拟下载：把内容写到本地
    downloadTo.mockImplementation(async (_remote: string, local: string) => {
      writeFileSync(local, 'downloaded')
    })

    planner.enqueueDownload({
      relPath: 'sub/remote.txt',
      remotePath: '/quark-backup/sub/remote.txt',
      size: 10
    })
    await settle()

    expect(downloadTo).toHaveBeenCalledTimes(1)
    expect(downloadTo.mock.calls[0][0]).toBe('/quark-backup/sub/remote.txt')
    expect(downloadTo.mock.calls[0][1]).toContain('remote.txt')

    const task = planner.getTasks().find((t) => t.localPath === 'sub/remote.txt')
    expect(task!.category).toBe('download')
    expect(task!.state).toBe('done')
    expect(task!.progress).toBe(1)

    // 下载完的文件应进入清单，且标为已同步
    const entry = manifest.getFile('sub/remote.txt')
    expect(entry).not.toBeNull()
    expect(entry!.state).toBe('synced')
    expect(entry!.remotePath).toBe('/quark-backup/sub/remote.txt')
  })

  it('下载失败后自动重试，重试成功则完成', async () => {
    // 第一次失败、第二次成功：应自动重试并最终落到完成态
    downloadTo
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async (_remote: string, local: string) => {
        writeFileSync(local, 'downloaded')
      })

    planner.enqueueDownload({
      relPath: 'flaky.txt',
      remotePath: '/quark-backup/flaky.txt',
      size: 10
    })
    await settle(900)

    expect(downloadTo.mock.calls.length).toBeGreaterThanOrEqual(2)
    const task = planner.getTasks().find((t) => t.localPath === 'flaky.txt')
    expect(task!.state).toBe('done')
    expect(task!.category).toBe('download')
  })

  it('下载持续失败时重试耗尽并落到失败态', async () => {
    downloadTo.mockRejectedValue(new Error('network down'))

    planner.enqueueDownload({
      relPath: 'dead.txt',
      remotePath: '/quark-backup/dead.txt',
      size: 10
    })
    await settle(1200)

    const task = planner.getTasks().find((t) => t.localPath === 'dead.txt')
    expect(task).toBeDefined()
    // maxAttempts=3 → 试满 3 次后落到失败态
    expect(task!.state).toBe('failed')
    expect(task!.category).toBe('download')
    expect(task!.errorMsg).toContain('network down')
  })

  it('跳过的任务不提供重试（重试会把判定结论变成一次真实上传）', async () => {
    const p = join(syncRoot, 'skipme.txt')
    writeFileSync(p, 'hello')
    const st = statSync(p)

    manifest.upsertFile({
      localPath: 'skipme.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('skipme.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs)
    })

    await planner.handleEvent('skipme.txt', true)
    await settle()

    const task = planner.getTasks().find((t) => t.localPath === 'skipme.txt')!
    planner.retry(task.id)
    await settle()

    expect(upload).not.toHaveBeenCalled()
    expect(planner.getTasks().find((t) => t.localPath === 'skipme.txt')!.state).toBe('skipped')
  })
})
