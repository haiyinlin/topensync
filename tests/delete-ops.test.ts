import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 删除与批量删除的行为测试。
 *
 * 三个列表的「删除」语义**必须不同**，混在一起就是数据损失：
 *
 * - 文件清单：删**本地文件**，远端按删除策略跟进
 * - 传输队列：只清**任务记录**，一个字节都不动
 * - 远端对账：删**远端文件**（走回收站）
 *
 * 特别要盯住队列那条：用户看到的是历史快照，
 * 「删除」指的是「这条记录我不要看了」，绝不能连带删文件。
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

describe('删除与批量删除', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let remove: ReturnType<typeof vi.fn>
  let move: ReturnType<typeof vi.fn>
  let planner: Planner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-delete-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })
    remove = vi.fn().mockResolvedValue(undefined)
    move = vi.fn().mockResolvedValue(undefined)

    const transfer = { upload } as unknown as Transfer
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      move,
      remove,
      downloadTo: vi.fn().mockResolvedValue(undefined)
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

  // ── 队列：只清记录，不动文件 ──────────────────────────

  it('从队列移除任务记录不会删除任何文件', async () => {
    const p = join(syncRoot, 'keep.txt')
    writeFileSync(p, 'content')
    const st = { size: 7, mtimeMs: Date.now() }

    manifest.upsertFile({
      localPath: 'keep.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'pending'
    })

    await planner.handleEvent('keep.txt', true)
    await settle()

    const task = planner.getTasks().find((t) => t.localPath === 'keep.txt')
    expect(task).toBeDefined()

    const removed = planner.removeTasks([task!.id])

    expect(removed).toBe(1)
    expect(planner.getTasks().some((t) => t.id === task!.id)).toBe(false)
    // 关键：文件必须还在
    expect(existsSync(p), '队列里删记录不该碰文件').toBe(true)
  })

  it('批量移除多条任务记录', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const p = join(syncRoot, name)
      writeFileSync(p, name)
      manifest.upsertFile({
        localPath: name,
        localSize: name.length,
        mtimeMs: Date.now(),
        state: 'pending'
      })
      await planner.handleEvent(name, true)
    }
    await settle()

    const ids = planner.getTasks().map((t) => t.id)
    expect(ids.length).toBe(3)

    expect(planner.removeTasks(ids)).toBe(3)
    expect(planner.getTasks()).toHaveLength(0)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      expect(existsSync(join(syncRoot, name))).toBe(true)
    }
  })

  it('移除不存在的任务 id 不报错、返回 0', () => {
    expect(planner.removeTasks(['nonexistent'])).toBe(0)
  })

  // ── 清单：删本地文件 ──────────────────────────────────

  it('删除本地文件后文件真的不在磁盘上', async () => {
    const p = join(syncRoot, 'gone.txt')
    writeFileSync(p, 'bye')
    expect(existsSync(p)).toBe(true)

    const deleted = await planner.deleteLocalFiles(['gone.txt'])

    expect(deleted).toBe(1)
    expect(existsSync(p)).toBe(false)
  })

  it('批量删除多个本地文件', async () => {
    for (const name of ['x.txt', 'y.txt']) {
      writeFileSync(join(syncRoot, name), name)
    }

    const deleted = await planner.deleteLocalFiles(['x.txt', 'y.txt'])

    expect(deleted).toBe(2)
    expect(existsSync(join(syncRoot, 'x.txt'))).toBe(false)
    expect(existsSync(join(syncRoot, 'y.txt'))).toBe(false)
  })

  it('删除不存在的文件不中断整批', async () => {
    writeFileSync(join(syncRoot, 'real.txt'), 'ok')

    const deleted = await planner.deleteLocalFiles(['not-there.txt', 'real.txt'])

    expect(deleted).toBe(1)
    expect(existsSync(join(syncRoot, 'real.txt'))).toBe(false)
  })

  it('删除空列表不做事', async () => {
    expect(await planner.deleteLocalFiles([])).toBe(0)
  })

  // ── 远端删除：回收站目录必须先建出来 ───────────────────

  it('删远端文件前会先建回收站目录（否则 move 静默失败）', async () => {
    const calls: string[] = []
    const mkdirp = vi.fn().mockImplementation(async (p: string) => {
      calls.push(p)
    })
    const move = vi.fn().mockResolvedValue(undefined)

    const planner2 = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        mkdir: mkdirp,
        mkdirp,
        move,
        remove,
        downloadTo: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner2.start()

    const res = await planner2.deleteRemoteFiles([
      { remotePath: '/quark-backup/from-elsewhere.txt', diffId: 7 }
    ])

    expect(res.deleted).toBe(1)
    expect(res.failed).toBe(0)

    // 回收站父目录必须被建出来
    expect(mkdirp).toHaveBeenCalled()
    const madeDirs = mkdirp.mock.calls.map((c) => String(c[0]))
    expect(
      madeDirs.some((d) => d.includes('_trash')),
      `回收站目录没建：${madeDirs.join(', ')}`
    ).toBe(true)

    // 文件确实被移走了
    expect(move).toHaveBeenCalled()
    const [src, dst] = move.mock.calls[0] as unknown as [string, string]
    expect(src).toBe('/quark-backup/from-elsewhere.txt')
    expect(dst).toContain('_trash')

    planner2.stop()
  })

  it('deletePolicy=keep 时不动远端，只关闭差异', async () => {
    const move = vi.fn().mockResolvedValue(undefined)
    const planner2 = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        move,
        remove,
        downloadTo: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot, deletePolicy: 'keep' })
    })
    planner2.start()

    const res = await planner2.deleteRemoteFiles([
      { remotePath: '/quark-backup/x.txt', diffId: 3 }
    ])

    expect(res.deleted).toBe(1)
    expect(move).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()

    planner2.stop()
  })

  it('远端删除失败时计入 failed，不假装成功', async () => {
    const planner2 = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockRejectedValue(new Error('storage not found')),
        remove: vi.fn().mockResolvedValue(undefined),
        downloadTo: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner2.start()

    const res = await planner2.deleteRemoteFiles([
      { remotePath: '/quark-backup/x.txt', diffId: 3 }
    ])

    expect(res.deleted).toBe(0)
    expect(res.failed).toBe(1)

    planner2.stop()
  })
})
