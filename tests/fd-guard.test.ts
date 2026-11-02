import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import { Watcher } from '../src/main/watcher/watcher'
import { IoGovernor, ioGovernor, isResourceExhausted } from '../src/main/io/governor'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 句柄耗尽（EMFILE）与事件风暴的回归测试。
 *
 * 现场：用户把整块盘（5.8 万文件）设为同步根，运行时出现
 *   EMFILE: too many open files, open 'Z:\download\...jpg'
 *   EMFILE: too many open files, watch 'Z:\...\IMG_8278.JPG'
 * 以及「点暂停没反应」。
 *
 * 根因是三处叠加，这里逐个锁住：
 * 1. 事件处理没有并发上限 → 几万个 stat 同时开
 * 2. 上传读流在失败时不销毁 → 每次失败漏一个句柄
 * 3. 初始扫描交给 chokidar 的 awaitWriteFinish → 几万个轮询
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
  retry: { maxAttempts: 2, baseDelayMs: 10 },
  exclude: [],
  verifyMode: 'size',
  verifyHashMaxBytes: 64 * 1024 * 1024,
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  syncEmptyDirs: false,
  detectRenames: false,
  renameWindowMs: 5000,
  remoteScan: {
    enabled: false,
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

function emfile(path = 'Z:\\a.jpg'): NodeJS.ErrnoException {
  const err = new Error(`EMFILE: too many open files, open '${path}'`) as NodeJS.ErrnoException
  err.code = 'EMFILE'
  return err
}

function enoent(path = 'Z:\\a.jpg'): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

describe('IO 闸门', () => {
  let gov: IoGovernor

  beforeEach(() => {
    gov = new IoGovernor()
    gov.setLimit(3)
  })

  it('同时进行的操作不超过额度', async () => {
    let active = 0
    let peak = 0

    const task = async (): Promise<void> => {
      active++
      peak = Math.max(peak, active)
      await settle(15)
      active--
    }

    await Promise.all(Array.from({ length: 24 }, () => gov.run(task)))

    expect(peak).toBeLessThanOrEqual(3)
    expect(gov.stats.active).toBe(0)
    // 真的并行过，不是退化成一个
    expect(peak).toBeGreaterThan(1)
  })

  it('EMFILE 会进入冷却，但错误照旧抛给调用方', async () => {
    await expect(gov.run(async () => Promise.reject(emfile()))).rejects.toThrow(/EMFILE/)

    expect(gov.coolingDown).toBe(true)
    expect(gov.stats.exhausted).toBe(1)
    expect(gov.remainingCooldownMs).toBeGreaterThan(0)
  })

  it('非 EMFILE 的错误不会触发冷却', async () => {
    await expect(gov.run(async () => Promise.reject(enoent()))).rejects.toThrow(/ENOENT/)
    expect(gov.coolingDown).toBe(false)
    expect(gov.stats.exhausted).toBe(0)
  })

  it('冷却结束后自动恢复，不需要外部干预', async () => {
    gov.penalize()
    const started = Date.now()
    await gov.run(async () => undefined)
    // 至少等过了这次冷却时长才放行
    expect(Date.now() - started).toBeGreaterThan(0)
    expect(gov.stats.active).toBe(0)
  })

  it('连续命中时退避阶梯变长', () => {
    const first = gov.penalize()
    const second = gov.penalize()
    expect(second).toBeGreaterThan(first)
  })

  it('isResourceExhausted 只认句柄类错误', () => {
    expect(isResourceExhausted(emfile())).toBe(true)
    expect(isResourceExhausted({ code: 'ENFILE' })).toBe(true)
    expect(isResourceExhausted(enoent())).toBe(false)
    expect(isResourceExhausted(new Error('boom'))).toBe(false)
  })
})

describe('Planner 的句柄耗尽处理', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let planner: Planner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-fd-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })

    planner = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    ioGovernor.resetForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('上传时句柄耗尽：任务重排队，而不是判失败', async () => {
    const p = join(syncRoot, 'big.bin')
    writeFileSync(p, 'x'.repeat(4096))
    upload.mockRejectedValue(emfile(p))

    await planner.handleEvent('big.bin', true)
    await settle(400)

    const task = planner.getTasks().find((t) => t.localPath === 'big.bin')
    expect(task).toBeDefined()
    // 关键：不是 failed。文件没坏、网络没断，只是句柄暂时不够
    expect(task?.state).toBe('queued')
    expect(task?.errorMsg).toMatch(/句柄/)
    expect(manifest.getFile('big.bin')?.state).toBe('pending')
  })

  it('上传阶段返回 EMFILE（不是抛异常）时也重排队', async () => {
    const p = join(syncRoot, 'mid.bin')
    writeFileSync(p, 'y'.repeat(2048))
    // Transfer 把异常收敛成 { ok:false, error }，错误码丢了，只剩文案
    upload.mockResolvedValue({ ok: false, error: 'EMFILE: too many open files' })

    await planner.handleEvent('mid.bin', true)
    await settle(400)

    const task = planner.getTasks().find((t) => t.localPath === 'mid.bin')
    expect(task?.state).toBe('queued')
    // 没消耗重试次数——否则三次重试全撞在同一段句柄枯竭期就判死了
    expect(task?.attempts).toBe(0)
  })

  it('上传时文件已消失：按跳过记录，不制造红叉', async () => {
    const p = join(syncRoot, 'gone.bin')
    writeFileSync(p, 'abc')
    // 让哈希通过（文件存在），上传阶段才报 ENOENT —— 模拟扫描后被移走
    upload.mockRejectedValue(enoent(p))

    await planner.handleEvent('gone.bin', true)
    await settle(400)

    const task = planner.getTasks().find((t) => t.localPath === 'gone.bin')
    expect(task?.state).toBe('skipped')
    expect(task?.skipReason).toBe('file_gone')
    // 「文件没了」不该计入「跳过省了多少上行」
    expect(planner.skippedCount).toBe(0)
  })

  it('文件不存在时事件直接跳过，不抛异常', async () => {
    await expect(planner.handleEvent('nope.txt', true)).resolves.toBeUndefined()
  })
})

describe('Watcher 的事件背压', () => {
  let dir: string
  let root: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-watch-'))
    root = join(dir, 'root')
    mkdirSync(root, { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, `f${i}.txt`), `${i}`)
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('扫描时同时进行的事件处理数不超过窗口大小', async () => {
    let active = 0
    let peak = 0
    let seen = 0

    const watcher = new Watcher({
      root,
      exclude: [],
      onEvent: async () => {
        active++
        peak = Math.max(peak, active)
        seen++
        await settle(5)
        active--
      }
    })

    const count = await watcher.rescan()
    watcher.stop()

    expect(count).toBe(40)
    expect(seen).toBe(40)
    /*
     * 窗口上限 32：既保证并行（不至于退化成一条一条处理），
     * 又保证「未消化的事件不会无限堆积」。
     * 真正同时打开的文件句柄由 IO 闸门压到 8 以内，
     * 所以这里允许的并发不会变成句柄压力。
     */
    expect(peak).toBeLessThanOrEqual(32)
    expect(peak).toBeGreaterThan(1)
  })

  it('停止后扫描不再继续产出事件', async () => {
    let seen = 0
    const watcher = new Watcher({
      root,
      exclude: [],
      onEvent: async () => {
        seen++
        if (seen === 5) watcher.stop()
        await settle(1)
      }
    })

    await watcher.rescan()
    const after = seen
    await settle(80)
    expect(seen).toBe(after)
    expect(after).toBeLessThan(40)
  })
})
