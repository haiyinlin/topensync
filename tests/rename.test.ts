import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 新增功能的行为测试：
 * - 重命名识别（走远端 move，而不是删除 + 重传）
 * - 空目录同步
 * - 远端排除项
 */

const BASE_CONFIG: AppConfig = {
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
  detectRenames: true,
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

async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('重命名识别', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let move: ReturnType<typeof vi.fn>
  let remove: ReturnType<typeof vi.fn>
  let mkdir: ReturnType<typeof vi.fn>
  let planner: Planner

  function build(overrides: Partial<AppConfig> = {}): Planner {
    return new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: { mkdir, move, remove } as unknown as OpenListClient,
      getConfig: () => ({ ...BASE_CONFIG, syncRoot, ...overrides })
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-rename-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })
    move = vi.fn().mockResolvedValue(undefined)
    remove = vi.fn().mockResolvedValue(undefined)
    mkdir = vi.fn().mockResolvedValue(undefined)

    planner = build()
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 造一条「已同步」的清单记录。
   *
   * 远端路径是重命名 move 的**源**——没有它就无法 move，
   * 也就无从验证「走 move 而非重传」这条主线。
   */
  function seedSynced(relPath: string, remotePath: string, inode: string | null): void {
    manifest.upsertFile({
      localPath: relPath,
      localSize: 5,
      mtimeMs: 1000,
      remotePath,
      state: 'synced',
      inode
    })
    manifest.setState(relPath, 'synced', {
      remoteSize: 5,
      syncedSize: 5,
      syncedMtimeMs: 1000
    })
  }

  it('改名单文件时走远端 move，不重新上传', async () => {
    const oldPath = join(syncRoot, 'old.txt')
    const newPath = join(syncRoot, 'new.txt')
    writeFileSync(oldPath, 'hello')
    // 用 bigint 读法，和生产代码一致：Windows 的 ino 是 64 位文件索引号，
    // 按普通 number 读会丢精度，两边算出的字符串对不上。
    const ino = statSync(oldPath, { bigint: true }).ino.toString()

    seedSynced('old.txt', '/quark-backup/old.txt', ino)

    // 改名：先删旧路径，再建新路径（Windows 上的实际行为）
    require('fs').renameSync(oldPath, newPath)

    await planner.handleEvent('old.txt', false)
    await planner.handleEvent('new.txt', true)
    await settle()

    expect(move).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledWith('/quark-backup/old.txt', '/quark-backup/new.txt')
    // 关键断言：没有重新上传
    expect(upload).not.toHaveBeenCalled()
  })

  it('重命名后清单路径已更新且保留同步基准', async () => {
    const oldPath = join(syncRoot, 'old.txt')
    const newPath = join(syncRoot, 'new.txt')
    writeFileSync(oldPath, 'hello')
    // 用 bigint 读法，和生产代码一致：Windows 的 ino 是 64 位文件索引号，
    // 按普通 number 读会丢精度，两边算出的字符串对不上。
    const ino = statSync(oldPath, { bigint: true }).ino.toString()

    seedSynced('old.txt', '/quark-backup/old.txt', ino)
    require('fs').renameSync(oldPath, newPath)

    await planner.handleEvent('old.txt', false)
    await planner.handleEvent('new.txt', true)
    await settle()

    const entry = manifest.getFile('new.txt')
    expect(entry).not.toBeNull()
    expect(entry?.remotePath).toBe('/quark-backup/new.txt')
    expect(entry?.state).toBe('synced')
    // 同步基准必须保留——否则下一轮扫描会误判为变更而重传
    expect(entry?.syncedSize).toBe(5)
    expect(entry?.syncedMtimeMs).toBe(1000)
    // 旧路径不该还留在清单里
    expect(manifest.getFile('old.txt')).toBeNull()
  })

  it('远端 move 失败时退回重新上传，文件不会丢', async () => {
    const oldPath = join(syncRoot, 'old.txt')
    const newPath = join(syncRoot, 'new.txt')
    writeFileSync(oldPath, 'hello')
    // 用 bigint 读法，和生产代码一致：Windows 的 ino 是 64 位文件索引号，
    // 按普通 number 读会丢精度，两边算出的字符串对不上。
    const ino = statSync(oldPath, { bigint: true }).ino.toString()

    seedSynced('old.txt', '/quark-backup/old.txt', ino)
    move.mockRejectedValue(new Error('远端拒绝移动'))

    require('fs').renameSync(oldPath, newPath)
    await planner.handleEvent('old.txt', false)
    await planner.handleEvent('new.txt', true)
    await settle()

    // 关键：move 失败不能把文件丢掉——必须回落到上传
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toMatchObject({ relPath: 'new.txt' })
  })

  it('关闭重命名识别时退化为删除加重传', async () => {
    const plain = build({ detectRenames: false })
    plain.start()

    const oldPath = join(syncRoot, 'old.txt')
    const newPath = join(syncRoot, 'new.txt')
    writeFileSync(oldPath, 'hello')
    // 用 bigint 读法，和生产代码一致：Windows 的 ino 是 64 位文件索引号，
    // 按普通 number 读会丢精度，两边算出的字符串对不上。
    const ino = statSync(oldPath, { bigint: true }).ino.toString()

    seedSynced('old.txt', '/quark-backup/old.txt', ino)
    require('fs').renameSync(oldPath, newPath)

    await plain.handleEvent('old.txt', false)
    await plain.handleEvent('new.txt', true)
    await settle()

    // 删除策略是 trash，旧文件会被移进 _trash/——那是删除，不是重命名。
    // 断言的是**没有**发生「移到新路径」这种重命名式移动。
    expect(move).not.toHaveBeenCalledWith('/quark-backup/old.txt', '/quark-backup/new.txt')
    expect(upload).toHaveBeenCalledTimes(1)
    plain.stop()
  })

  it('不同内容的文件不会被误判为重命名', async () => {
    const oldPath = join(syncRoot, 'old.txt')
    const newPath = join(syncRoot, 'new.txt')
    writeFileSync(oldPath, 'hello')
    // 用 bigint 读法，和生产代码一致：Windows 的 ino 是 64 位文件索引号，
    // 按普通 number 读会丢精度，两边算出的字符串对不上。
    const ino = statSync(oldPath, { bigint: true }).ino.toString()

    seedSynced('old.txt', '/quark-backup/old.txt', ino)

    // 新文件是另一个 inode 的另一个文件（内容也不同）
    writeFileSync(newPath, 'completely different content')

    await planner.handleEvent('old.txt', false)
    await planner.handleEvent('new.txt', true)
    await settle()

    // 没有发生重命名式移动（移进 _trash/ 属于正常删除，不算误判）
    expect(move).not.toHaveBeenCalledWith('/quark-backup/old.txt', '/quark-backup/new.txt')
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('挂起窗口过期的删除仍会真正落到远端', async () => {
    // 回归测试：曾经有个 bug 让过期删除被静默丢弃——
    // drainExpired() 先调 prune()，而 prune() 会把「已过窗口」的记录
    // 直接删掉，于是过期删除永远等不到执行：
    // 本地文件没了，远端副本却一直留着。
    const short = build({ renameWindowMs: 1000 })
    short.start()

    const filePath = join(syncRoot, 'gone.txt')
    writeFileSync(filePath, 'bye')
    const ino = statSync(filePath, { bigint: true }).ino.toString()
    seedSynced('gone.txt', '/quark-backup/gone.txt', ino)

    require('fs').unlinkSync(filePath)
    await short.handleEvent('gone.txt', false)
    await settle(1500)

    // 窗口过后，删除必须真的执行（移进 _trash/）
    expect(
      move.mock.calls.some((c) => String(c[1]).includes('/_trash/')),
      '过期删除必须落到远端回收站'
    ).toBe(true)
    short.stop()
  })

  it('过期删除不会误配对到后来才出现的新文件', async () => {
    // 配对窗口之外出现的文件不该被当成重命名。
    const short = build({ renameWindowMs: 1000 })
    short.start()

    const oldPath = join(syncRoot, 'old.txt')
    writeFileSync(oldPath, 'hello')
    const ino = statSync(oldPath, { bigint: true }).ino.toString()
    seedSynced('old.txt', '/quark-backup/old.txt', ino)

    await short.handleEvent('old.txt', false)
    await settle(1500)

    // 窗口过后，同 inode 的新文件出现了 —— 不该被认成重命名。
    // 注意区分：过期删除本身会移进 _trash/（源路径同为 old.txt），
    // 那是删除，不是重命名；这里要排除的是「移到新路径」这种重命名式移动。
    const newPath = join(syncRoot, 'new.txt')
    require('fs').renameSync(oldPath, newPath)
    await short.handleEvent('new.txt', true)
    await settle()

    expect(
      move.mock.calls.some((c) => String(c[1]).includes('/quark-backup/new.txt')),
      '过期的删除不能配对成重命名'
    ).toBe(false)
    short.stop()
  })
})

describe('空目录同步', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let mkdir: ReturnType<typeof vi.fn>
  let planner: Planner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-dir-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    mkdir = vi.fn().mockResolvedValue(undefined)

    planner = new Planner({
      manifest,
      transfer: { upload: vi.fn() } as unknown as Transfer,
      client: { mkdir, move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({ ...BASE_CONFIG, syncRoot, syncEmptyDirs: true })
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('空目录会在远端建出来', async () => {
    mkdirSync(join(syncRoot, 'empty-dir'))

    await planner.handleEvent('empty-dir', true, true)
    await settle()

    expect(mkdir).toHaveBeenCalledWith('/quark-backup/empty-dir')
  })

  it('非空目录不单独建（其下文件上传时会自动创建）', async () => {
    mkdirSync(join(syncRoot, 'has-files'))
    writeFileSync(join(syncRoot, 'has-files', 'a.txt'), 'x')

    await planner.handleEvent('has-files', true, true)
    await settle()

    expect(mkdir).not.toHaveBeenCalledWith('/quark-backup/has-files')
  })

  it('关闭开关时不同步空目录', async () => {
    const off = new Planner({
      manifest,
      transfer: { upload: vi.fn() } as unknown as Transfer,
      client: { mkdir, move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({ ...BASE_CONFIG, syncRoot, syncEmptyDirs: false })
    })
    off.start()

    mkdirSync(join(syncRoot, 'empty2'))
    await off.handleEvent('empty2', true, true)
    await settle()

    expect(mkdir).not.toHaveBeenCalled()
    off.stop()
  })
})
