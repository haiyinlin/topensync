import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Watcher, type WatchEvent, type WatchMode } from '../src/main/watcher/watcher'
import { Manifest } from '../src/main/db/manifest'
import { Reconciler } from '../src/main/reconcile/reconciler'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 「同步与对账同时跑会卡」这一轮改造的契约测试。
 *
 * 用户的反馈（附日志截图）：
 *   ① 开始同步的同时又开始对账，这时候也会卡：并发太多、单次执行数量太多
 *   ② 同步时报 `EMFILE: too many open files, watch 'Z:\...'`
 *
 * 对应的三道防线：
 *   1. 实时监听建不起来时**降级为定时比对**（EMFILE 的直接解法）
 *   2. 启动对账**不跟本地首轮扫描同时开跑**（Reconciler.start 的 deferStartup）
 *   3. 差异**批量推送**，且统计不再读整张差异表（单次数量太多）
 */

/** 轮询等待一个条件成立（真实监听只能这样等，不能靠固定 sleep） */
function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
  })
}

// ── Watcher：轮询模式 ──────────────────────────────────

describe('Watcher 的定时比对模式（实时监听不可用时的降级）', () => {
  let dir: string
  let root: string
  let events: WatchEvent[]
  let watcher: Watcher | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-poll-'))
    root = join(dir, 'sync')
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    writeFileSync(join(root, 'sub', 'c.txt'), 'c')
    events = []
    watcher = null
  })

  afterEach(() => {
    watcher?.stop()
    watcher = null
    rmSync(dir, { recursive: true, force: true })
  })

  /** 直接驱动一轮比对（不必等真实的轮询间隔） */
  async function poll(w: Watcher, initial: boolean): Promise<void> {
    await (w as unknown as { pollOnce: (i: boolean) => Promise<number> }).pollOnce(initial)
  }

  it('第一轮把目录树里所有文件都发出来，并报 onReady', async () => {
    const readyCounts: number[] = []
    watcher = new Watcher({
      root,
      exclude: ['**/node_modules/**'],
      onEvent: (e) => events.push(e),
      onReady: (n) => readyCounts.push(n),
      forcePolling: true
    })

    expect(watcher.watchMode).toBe('poll')
    // 轮询模式没有 chokidar 实例，但确实在监控
    expect(watcher.isWatching).toBe(true)

    await poll(watcher, true)

    expect(events.map((e) => e.relPath).sort()).toEqual(['a.txt', 'b.md', 'sub/c.txt'])
    expect(readyCounts).toEqual([3])
  })

  it('后续轮次只发变化的文件，不重发没变的', async () => {
    watcher = new Watcher({
      root,
      exclude: [],
      onEvent: (e) => events.push(e),
      forcePolling: true
    })

    await poll(watcher, true)
    events.length = 0

    // 内容与 mtime 都没变 → 一个事件都不该有
    await poll(watcher, false)
    expect(events).toHaveLength(0)

    // 改一个文件 → 只有它被发出来
    writeFileSync(join(root, 'a.txt'), 'a-changed-longer')
    await poll(watcher, false)
    expect(events.map((e) => e.relPath)).toEqual(['a.txt'])
    expect(events[0].type).toBe('upsert')
  })

  it('文件消失时发出 remove 事件', async () => {
    watcher = new Watcher({
      root,
      exclude: [],
      onEvent: (e) => events.push(e),
      forcePolling: true
    })

    await poll(watcher, true)
    events.length = 0

    rmSync(join(root, 'sub', 'c.txt'))
    await poll(watcher, false)

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('remove')
    expect(events[0].relPath).toBe('sub/c.txt')
  })

  it('连续成片的 EMFILE 会让实时监听自动降级，而不是一直报错', async () => {
    const modes: WatchMode[] = []
    const logs: string[] = []
    watcher = new Watcher({
      root,
      exclude: [],
      // chokidar 的句柄错误只在这个模式出现（native 是单句柄）
      mode: 'watch',
      onEvent: () => undefined,
      onModeChange: (mode) => modes.push(mode),
      onLog: (_level, msg) => logs.push(msg)
    })

    const handleError = (
      watcher as unknown as { handleWatchError: (e: Error) => void }
    ).handleWatchError.bind(watcher)

    const emfile = (): Error =>
      Object.assign(new Error("EMFILE: too many open files, watch 'Z:\\备份\\x.jpg'"), {
        code: 'EMFILE'
      })

    // 前几次只是记录，仍在实时模式
    for (let i = 0; i < 7; i++) handleError(emfile())
    expect(watcher.watchMode).toBe('watch')

    // 达到阈值 → 降级
    handleError(emfile())
    expect(watcher.watchMode).toBe('poll')
    expect(modes).toEqual(['poll'])

    // 日志要能读懂：说清楚降级了、以及延迟多少
    expect(logs.some((m) => m.includes('已切换为定时比对'))).toBe(true)
    // 前置的报错不刷屏：同一类错误最多记几条
    expect(logs.filter((m) => m.startsWith('监控出错')).length).toBeLessThanOrEqual(3)
  })
})

// ── Watcher：原生整树单句柄监听（native）────────────────

describe('整树单句柄监听（native）', () => {
  let dir: string
  let root: string
  let events: WatchEvent[]
  let watcher: Watcher | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-native-'))
    root = join(dir, 'sync')
    mkdirSync(root, { recursive: true })
    events = []
    watcher = null
  })

  afterEach(() => {
    watcher?.stop()
    watcher = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('Windows 上默认走 native，而不是逐目录监听', () => {
    watcher = new Watcher({ root, exclude: [], onEvent: () => undefined })
    expect(watcher.watchMode).toBe(process.platform === 'win32' ? 'native' : 'watch')
  })

  it('初始扫描 + 改动 / 新建 / 删除都能收到事件', async () => {
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'sub', 'c.txt'), 'c')

    let readyCount = -1
    watcher = new Watcher({
      root,
      exclude: [],
      mode: 'native',
      onEvent: (e) => events.push(e),
      onReady: (n) => {
        readyCount = n
      }
    })
    watcher.start()

    expect(await waitFor(() => readyCount >= 0, 20_000)).toBe(true)
    expect(readyCount).toBe(2)
    expect(watcher.isWatching).toBe(true)

    // 改动
    events.length = 0
    writeFileSync(join(root, 'a.txt'), 'changed-content')
    expect(await waitFor(() => events.some((e) => e.relPath === 'a.txt'), 15_000)).toBe(true)

    // 新建目录 + 文件（递归监听要能自动覆盖新目录）
    events.length = 0
    mkdirSync(join(root, 'new', 'deep'), { recursive: true })
    writeFileSync(join(root, 'new', 'deep', 'n.txt'), 'n')
    expect(
      await waitFor(() => events.some((e) => e.relPath === 'new/deep/n.txt'), 15_000)
    ).toBe(true)

    // 删除
    events.length = 0
    rmSync(join(root, 'sub', 'c.txt'))
    expect(
      await waitFor(
        () => events.some((e) => e.relPath === 'sub/c.txt' && e.type === 'remove'),
        15_000
      )
    ).toBe(true)
  }, 120_000)

  it('突发计数超过阈值时，记下涉及的顶层目录并安排一次补扫', () => {
    watcher = new Watcher({ root, exclude: [], mode: 'native', onEvent: () => undefined })
    const w = watcher as unknown as {
      trackBurst: (rel: string) => void
      burstDirs: Set<string>
      burstTimer: unknown
    }
    // 阈值 120 条/秒：拷一个大目录进来就会跨过
    for (let i = 0; i < 150; i++) w.trackBurst(`新目录/子目录/f${i}.jpg`)
    expect([...w.burstDirs]).toEqual(['新目录'])
    expect(w.burstTimer).not.toBeNull()
  })
})

// ── Reconciler：启动对账延后 ────────────────────────────

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
    onStartup: true,
    refresh: true,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20,
    exclude: []
  }
}

describe('启动对账与本地扫描的错峰', () => {
  let dir: string
  let manifest: Manifest
  let list: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-defer-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
    list = vi.fn().mockResolvedValue({ content: [], total: 0, provider: 'mock' })
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeReconciler(): Reconciler {
    return new Reconciler({
      client: { list } as unknown as OpenListClient,
      manifest,
      getConfig: () => CONFIG
    })
  }

  it('deferStartup 时只排定时器，不立刻拉远端目录', async () => {
    const reconciler = makeReconciler()
    reconciler.start({ deferStartup: true })

    // 给异步任务一点时间：如果它要跑，这里就会看到 list 被调用
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(list).not.toHaveBeenCalled()

    reconciler.stop()
  })

  it('预热结束后手动 runStartup 才会真的跑一轮', async () => {
    const reconciler = makeReconciler()
    reconciler.start({ deferStartup: true })

    const res = await reconciler.runStartup()

    expect(list).toHaveBeenCalled()
    expect(res).not.toBeNull()
    reconciler.stop()
  })

  it('onStartup 关闭时 runStartup 什么都不做', async () => {
    const config = { ...CONFIG, remoteScan: { ...CONFIG.remoteScan, onStartup: false } }
    const reconciler = new Reconciler({
      client: { list } as unknown as OpenListClient,
      manifest,
      getConfig: () => config
    })

    await expect(reconciler.runStartup()).resolves.toBeNull()
    expect(list).not.toHaveBeenCalled()
  })
})

// ── Engine：差异批量推送 ────────────────────────────────

const userDataDir = mkdtempSync(join(tmpdir(), 'topensync-batch-'))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir())
  }
}))

let configStore: Record<string, unknown> = {}
vi.mock('../src/main/config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/config/store')>()
  return {
    ...actual,
    loadConfig: () => configStore,
    saveConfig: (c: Record<string, unknown>) => {
      configStore = c
    }
  }
})

/** 假远端：根目录下有 500 个文件 */
const REMOTE_FILE_COUNT = 500
const remoteList = vi.fn().mockImplementation(async (path: string) => {
  if (path !== '/r') return { content: [], total: 0, provider: 'mock' }
  return {
    content: Array.from({ length: REMOTE_FILE_COUNT }, (_, i) => ({
      name: `f${i}.bin`,
      size: 100 + i,
      modified: '2026-01-01T00:00:00Z',
      isDir: false
    })),
    total: REMOTE_FILE_COUNT,
    provider: 'mock'
  }
})

vi.mock('../src/main/openlist/client', () => ({
  OpenListClient: class {
    login = vi.fn().mockResolvedValue(undefined)
    list = remoteList
    reconfigure = vi.fn()
    dirReady = vi.fn().mockResolvedValue(true)
    mkdirp = vi.fn().mockResolvedValue(undefined)
    downloadTo = vi.fn().mockResolvedValue(undefined)
    move = vi.fn().mockResolvedValue(undefined)
    remove = vi.fn().mockResolvedValue(undefined)
    confirmMissing = vi.fn().mockResolvedValue(true)
  },
  describeError: (e: unknown) => String(e)
}))

const { Engine } = await import('../src/main/engine')

describe('对账差异的批量推送', () => {
  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it(`${REMOTE_FILE_COUNT} 条差异分批到达，不逐条推`, async () => {
    configStore = {
      syncRoot: join(userDataDir, 'sync'),
      openlist: { baseUrl: 'http://127.0.0.1:5244', username: 'admin', password: 'p' },
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

    const batches: number[] = []
    let received = 0
    const engine = new Engine({
      onDiffBatch: (diffs) => {
        batches.push(diffs.length)
        received += diffs.length
      }
    })

    await engine.start()
    await engine.triggerScan('remote')

    // 等最后一批（攒批窗口 150ms）落地
    const deadline = Date.now() + 3000
    while (received < REMOTE_FILE_COUNT && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(received).toBe(REMOTE_FILE_COUNT)
    // 一次 IPC 不该塞 500 条：单批有上限
    expect(Math.max(...batches)).toBeLessThanOrEqual(200)
    // 更不该变成 500 次推送
    expect(batches.length).toBeLessThan(REMOTE_FILE_COUNT)

    engine.stop()
  })
})
