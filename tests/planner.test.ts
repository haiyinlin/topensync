import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import { hashFile } from '../src/main/hash/hashes'
import type { AppConfig } from '../src/shared/types'

/**
 * Planner 的行为测试。
 *
 * 核心要验证的是「省上行」这条主线：
 * 文件没变 → **一次网络请求都不该发**。
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
  exclude: ['**/node_modules/**'],
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

/** 让异步流水线跑完 */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('Planner', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let planner: Planner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-planner-'))
    syncRoot = join(dir, 'sync')
    rmSync(syncRoot, { recursive: true, force: true })
    // syncRoot 由 handleEvent 内部读取，这里只需要它存在
    require('fs').mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })

    const transfer = { upload } as unknown as Transfer
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    } as unknown as OpenListClient

    planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件未变化时完全不上传（L1 去重命中）', async () => {
    const p = join(syncRoot, 'a.txt')
    writeFileSync(p, 'hello')
    const st = statSync(p)

    // 造一条「上次已同步」的记录，size/mtime 与当前一致
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('a.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs)
    })

    await planner.handleEvent('a.txt', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()
    expect(planner.skippedCount).toBe(1)
  })

  it('文件从未同步过时会上传', async () => {
    const p = join(syncRoot, 'b.txt')
    writeFileSync(p, 'world')

    await planner.handleEvent('b.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toMatchObject({
      relPath: 'b.txt',
      remotePath: '/quark-backup/b.txt'
    })
  })

  it('文件内容变化后（mtime 变）会重新上传', async () => {
    const p = join(syncRoot, 'c.txt')
    writeFileSync(p, 'v1')
    const st = statSync(p)

    manifest.upsertFile({
      localPath: 'c.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('c.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs)
    })

    // 改内容 → size 与 mtime 都变
    writeFileSync(p, 'v2-longer')
    await planner.handleEvent('c.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('命中排除规则的文件不上传', async () => {
    const p = join(syncRoot, 'node_modules', 'pkg', 'x.js')
    require('fs').mkdirSync(join(syncRoot, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(p, 'x')

    await planner.handleEvent('node_modules/pkg/x.js', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()
  })

  it('对账发现远端缺失时回流重传', async () => {
    const p = join(syncRoot, 'd.txt')
    writeFileSync(p, 'data')

    await planner.handleDiff({
      kind: 'missing_remote',
      localPath: 'd.txt',
      remotePath: '/quark-backup/d.txt'
    })
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toMatchObject({ relPath: 'd.txt' })
  })

  /*
   * 回归：远端被外部删除后，「对账重传」不能被哈希判重吞掉。
   *
   * 这条曾经是静默的数据缺口：清单里留着上次同步时的
   * synced_md5/sha1，远端那份已经被人删了。对账发现 missing_remote
   * 后入队，哈希阶段拿本地哈希跟 synced_md5 一比——本地没改过，
   * 相等 → 判成「远端重复」→ 跳过上传。
   *
   * 于是每轮对账都发现差异、每轮都「重新上传」、每轮都被跳过，
   * 远端那份永远补不回来，而清单里还写着 synced。
   *
   * 修法是入队前先 clearSyncBaseline()。这条测试锁住它。
   */
  it('远端被外部删除后，对账重传不会被哈希判重吞掉', async () => {
    const p = join(syncRoot, 'gone.txt')
    writeFileSync(p, 'important-data')
    const st = statSync(p)
    const hashes = await hashFile(p)

    // 模拟「上次同步成功」：清单里留着远端那份内容的哈希
    manifest.upsertFile({
      localPath: 'gone.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      remotePath: '/quark-backup/gone.txt',
      state: 'synced'
    })
    manifest.setState('gone.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: st.mtimeMs,
      syncedMd5: hashes.md5,
      syncedSha1: hashes.sha1
    })

    await planner.handleDiff({
      kind: 'missing_remote',
      localPath: 'gone.txt',
      remotePath: '/quark-backup/gone.txt'
    })
    await settle(600)

    // 修复前这里是 0：文件被判成「远端已有」而根本没上传
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('内容不符时同样真正重传，不被判重挡住', async () => {
    const p = join(syncRoot, 'mismatch.txt')
    writeFileSync(p, 'version-A')
    const st = statSync(p)
    const hashes = await hashFile(p)

    manifest.upsertFile({
      localPath: 'mismatch.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      remotePath: '/quark-backup/mismatch.txt',
      state: 'synced'
    })
    manifest.setState('mismatch.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: st.mtimeMs,
      syncedMd5: hashes.md5,
      syncedSha1: hashes.sha1
    })

    await planner.handleDiff({
      kind: 'size_mismatch',
      localPath: 'mismatch.txt',
      remotePath: '/quark-backup/mismatch.txt'
    })
    await settle(600)

    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('对账发现仅远端存在时不动作', async () => {
    await planner.handleDiff({
      kind: 'remote_only',
      localPath: null,
      remotePath: '/quark-backup/other.txt'
    })
    await settle()

    expect(upload).not.toHaveBeenCalled()
  })

  it('超过单文件上限的文件不上传，并写明原因', async () => {
    const p = join(syncRoot, 'big.bin')
    writeFileSync(p, 'x'.repeat(2048))

    const limited = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot, quarkMaxFileBytes: 1024 })
    })
    limited.start()

    await limited.handleEvent('big.bin', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()
    const entry = manifest.getFile('big.bin')
    expect(entry?.state).toBe('error')
    expect(entry?.errorMsg).toContain('超过单文件上限')
    limited.stop()
  })

  it('对账回流时同样受单文件上限约束', async () => {
    const p = join(syncRoot, 'big2.bin')
    writeFileSync(p, 'x'.repeat(2048))

    const limited = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot, quarkMaxFileBytes: 1024 })
    })
    limited.start()

    await limited.handleDiff({
      kind: 'missing_remote',
      localPath: 'big2.bin',
      remotePath: '/quark-backup/big2.bin'
    })
    await settle()

    expect(upload).not.toHaveBeenCalled()
    limited.stop()
  })

  it('确定性失败（不可重试）不消耗重试次数', async () => {
    const p = join(syncRoot, 'f.txt')
    writeFileSync(p, 'data')

    upload.mockResolvedValue({ ok: false, error: '文件超过单文件上限', retryable: false })

    await planner.handleEvent('f.txt', true)
    await settle(500)

    // 可重试的失败会重试到 maxAttempts=3 次；不可重试的只试 1 次
    expect(upload).toHaveBeenCalledTimes(1)
    const task = planner.getTasks().find((t) => t.localPath === 'f.txt')
    expect(task?.state).toBe('failed')
  })

  it('冲突策略为「全部交由我确认」时不自动重传', async () => {
    const p = join(syncRoot, 'e.txt')
    writeFileSync(p, 'data')

    const manual = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: { mkdir: vi.fn(), move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({
        ...CONFIG,
        syncRoot,
        remoteScan: { ...CONFIG.remoteScan, conflictPolicy: 'manual' }
      })
    })
    manual.start()

    await manual.handleDiff({
      kind: 'missing_remote',
      localPath: 'e.txt',
      remotePath: '/quark-backup/e.txt'
    })
    await settle()

    expect(upload).not.toHaveBeenCalled()
    manual.stop()
  })
})

/**
 * 队列的「重试」与「取消」按钮。
 *
 * 这两个按钮曾经完全不起作用，根因是**任务表与队列是两份数据**：
 * 任务表是给界面看的快照，队列是真正在跑的数据流。
 * 只改任务表不改队列 → 任务照样跑完并把状态覆盖回 done，
 * 界面看着像「点了没反应」。
 */
describe('Planner 的重试与取消', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let planner: Planner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-queue-'))
    syncRoot = join(dir, 'sync')
    rmSync(syncRoot, { recursive: true, force: true })
    require('fs').mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })

    const transfer = { upload } as unknown as Transfer
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    } as unknown as OpenListClient

    planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('取消排队中的任务：不再上传，状态变为已取消', async () => {
    const p = join(syncRoot, 'q.txt')
    writeFileSync(p, 'data')

    // 先让它失败，拿到一个 failed 任务
    // 注意：失败会自动重试（retryable 默认 true），
    // 所以要让它**持续**失败，直到耗尽 maxAttempts 才落到 failed。
    upload.mockResolvedValue({ ok: false, error: 'boom' })
    await planner.handleEvent('q.txt', true)
    await settle(1200)

    let task = planner.getTasks().find((t) => t.localPath === 'q.txt')
    expect(task?.state).toBe('failed')

    upload.mockResolvedValue({ ok: true })
    planner.cancel(task!.id)
    await settle(400)

    task = planner.getTasks().find((t) => t.localPath === 'q.txt')
    expect(task?.state).toBe('canceled')
    // 取消后不应该再有新的上传
    expect(upload).toHaveBeenCalledTimes(3)
  })

  it('取消正在上传的任务：上传结束后状态仍是已取消，不被覆盖成已完成', async () => {
    const p = join(syncRoot, 'r.txt')
    writeFileSync(p, 'data')

    let release: (v: unknown) => void = () => undefined
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )

    await planner.handleEvent('r.txt', true)
    await settle(300)

    const task = planner.getTasks().find((t) => t.localPath === 'r.txt')
    expect(task?.state).toBe('uploading')

    planner.cancel(task!.id)
    // 放行上传
    release({ ok: true })
    await settle(400)

    const after = planner.getTasks().find((t) => t.localPath === 'r.txt')
    expect(after?.state).toBe('canceled')
  })

  it('取消后状态不会被流水线的后续回报覆盖（不退回上传中）', async () => {
    const p = join(syncRoot, 'r2.txt')
    writeFileSync(p, 'data')

    // 上传挂住：模拟「取消发生在哈希/上传阶段之间」
    let release: (v: unknown) => void = () => undefined
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )

    await planner.handleEvent('r2.txt', true)
    await settle(300)

    const task = planner.getTasks().find((t) => t.localPath === 'r2.txt')
    planner.cancel(task!.id)
    release({ ok: true })
    // 多等几轮，让流水线的每个阶段都有机会回报状态
    await settle(1000)

    const after = planner.getTasks().find((t) => t.localPath === 'r2.txt')
    expect(after?.state).toBe('canceled')
  })

  it('重试失败的任务：会重新上传并最终成功', async () => {
    const p = join(syncRoot, 's.txt')
    writeFileSync(p, 'data')

    upload.mockResolvedValue({ ok: false, error: 'boom', retryable: false })
    await planner.handleEvent('s.txt', true)
    await settle(600)

    const failed = planner.getTasks().find((t) => t.localPath === 's.txt')
    expect(failed?.state).toBe('failed')
    expect(upload).toHaveBeenCalledTimes(1)

    upload.mockResolvedValue({ ok: true })
    planner.retry(failed!.id)
    await settle(600)

    expect(upload).toHaveBeenCalledTimes(2)
    const done = planner.getTasks().find((t) => t.localPath === 's.txt')
    expect(done?.state).toBe('done')
  })

  it('重试会重置尝试次数（否则一进队列就又判失败）', async () => {
    const p = join(syncRoot, 't.txt')
    writeFileSync(p, 'data')

    upload.mockResolvedValue({ ok: false, error: 'boom', retryable: false })
    await planner.handleEvent('t.txt', true)
    await settle(600)

    const failed = planner.getTasks().find((t) => t.localPath === 't.txt')
    expect(failed?.attempts).toBeGreaterThan(0)

    upload.mockResolvedValue({ ok: true })
    planner.retry(failed!.id)
    await settle(600)

    const done = planner.getTasks().find((t) => t.localPath === 't.txt')
    expect(done?.attempts).toBe(0)
    expect(done?.state).toBe('done')
  })
})

/**
 * 换同步目录后，上一轮的清单记录不该被当成「本地待传文件」重传。
 *
 * 实测踩过：切到新目录启动后，上一轮的 readme.txt / docs/guide.md /
 * sub/c.txt 全被重新上传，远端凭空多出 docs/、sub/ 目录。
 */
describe('Planner 的未完成任务恢复', () => {
  it('本地已不存在的历史记录不会被重新上传', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topensync-recover-'))
    const syncRoot = join(dir, 'sync')
    require('fs').mkdirSync(syncRoot, { recursive: true })
    const manifest = new Manifest(join(dir, 'manifest.db'))
    const upload = vi.fn().mockResolvedValue({ ok: true })

    // 模拟上一轮遗留：三个记录对应的文件在新目录里都不存在
    manifest.upsertFile({ localPath: 'readme.txt', localSize: 10, mtimeMs: 1, state: 'error' })
    manifest.upsertFile({ localPath: 'docs/guide.md', localSize: 10, mtimeMs: 1, state: 'error' })
    manifest.upsertFile({ localPath: 'sub/c.txt', localSize: 10, mtimeMs: 1, state: 'error' })

    const planner = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: { mkdir: vi.fn(), move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()

    const recovered = planner.recoverPending()
    await settle(400)

    expect(recovered).toBe(0)
    expect(upload).not.toHaveBeenCalled()

    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('本地确实存在的记录仍会被恢复上传', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topensync-recover2-'))
    const syncRoot = join(dir, 'sync')
    require('fs').mkdirSync(syncRoot, { recursive: true })
    writeFileSync(join(syncRoot, 'keep.txt'), 'data')
    const manifest = new Manifest(join(dir, 'manifest.db'))
    const upload = vi.fn().mockResolvedValue({ ok: true })

    manifest.upsertFile({ localPath: 'keep.txt', localSize: 4, mtimeMs: 1, state: 'error' })

    const planner = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: { mkdir: vi.fn(), move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()

    const recovered = planner.recoverPending()
    await settle(400)

    expect(recovered).toBe(1)
    expect(upload).toHaveBeenCalledTimes(1)

    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * 取消的语义要能跨重启保持。
 *
 * 取消 = 「我现在不想传这个文件」。
 * 如果清单状态写成 error，下次启动的恢复逻辑会把它捞起来重传，
 * 用户明明取消了，程序又偷偷传一遍。
 */
describe('取消后的持久化语义', () => {
  it('取消的文件不会被下次启动的恢复逻辑重新上传', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topensync-cancel-persist-'))
    const syncRoot = join(dir, 'sync')
    require('fs').mkdirSync(syncRoot, { recursive: true })
    writeFileSync(join(syncRoot, 'skip.txt'), 'data')

    const manifest = new Manifest(join(dir, 'manifest.db'))
    // 上传挂住不返回——模拟「正在上传时用户点了取消」
    let release: (v: unknown) => void = () => undefined
    const upload = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const planner = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: { mkdir: vi.fn(), move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()

    await planner.handleEvent('skip.txt', true)
    await settle(400)
    const task = planner.getTasks().find((t) => t.localPath === 'skip.txt')!
    expect(task.state).toBe('uploading')

    planner.cancel(task.id)
    // 放行上传：即便它返回成功，也不该被记成 synced
    release({ ok: true })
    await settle(400)

    planner.stop()
    manifest.close()

    // 模拟重启：新 Planner 读同一份清单
    const manifest2 = new Manifest(join(dir, 'manifest.db'))
    const upload2 = vi.fn().mockResolvedValue({ ok: true })
    const planner2 = new Planner({
      manifest: manifest2,
      transfer: { upload: upload2 } as unknown as Transfer,
      client: { mkdir: vi.fn(), move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner2.start()
    const recovered = planner2.recoverPending()
    await settle(400)

    expect(recovered).toBe(0)
    expect(upload2).not.toHaveBeenCalled()

    planner2.stop()
    manifest2.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
