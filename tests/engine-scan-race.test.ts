import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 「远端对账」与「本地上传」的时序测试。
 *
 * 锁住一个真实发生的 bug：
 *
 *   全新环境首次运行时清单是空的。用户点「扫描本地」，程序开始上传；
 *   紧接着（上传还没落库）又点「远端对账」——对账读到的清单是空的，
 *   于是把远端一切判成「仅远端存在」，冒出 4 条假差异。
 *
 *   更糟的是：用户照着界面提示点「移入回收站」，
 *   好好的远端文件被移进了回收站。日志实证：
 *   「已移入回收站：/qh/topensync-demo/文档/需求记录.md」。
 *
 * 两道防线：
 * 1. 对账前先等上传队列排空（时序）
 * 2. 对账时探一下本地：清单没记但本地有 → 不算差异（内容）
 */

/** Electron 在 node 环境里不可用，这里替换成最小实现 */
const userDataDir = mkdtempSync(join(tmpdir(), 'topensync-race-'))
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

const login = vi.fn().mockResolvedValue(undefined)
const list = vi.fn().mockResolvedValue({ content: [], total: 0, provider: 'mock' })
const clientInstance = {
  login,
  list,
  reconfigure: vi.fn(),
  dirReady: vi.fn().mockResolvedValue(true),
  mkdirp: vi.fn().mockResolvedValue(undefined),
  downloadTo: vi.fn().mockResolvedValue(undefined),
  move: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  confirmMissing: vi.fn().mockResolvedValue(false),
  statWhenVisible: vi.fn().mockResolvedValue(null),
  putFile: vi.fn().mockResolvedValue(undefined)
}
vi.mock('../src/main/openlist/client', () => ({
  OpenListClient: class {
    constructor() {
      return clientInstance as never
    }
  },
  describeError: (e: unknown) => String(e)
}))

const { Engine } = await import('../src/main/engine')

const BASE_CONFIG = {
  syncRoot: '',
  openlist: { baseUrl: '', username: '', password: '' },
  remoteRoot: '/',
  hashConcurrency: 2,
  uploadConcurrency: 2,
  singlePutMaxBytes: 8 * 1024 * 1024,
  chunkConcurrency: 2,
  deletePolicy: 'trash' as const,
  trashRoot: '_trash',
  maxDeletesPerRun: 200,
  maxDeleteBytesPerRun: 10 * 1024 * 1024 * 1024,
  retry: { maxAttempts: 3, baseDelayMs: 10 },
  exclude: [],
  verifyMode: 'size' as const,
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
    conflictPolicy: 'local-wins' as const,
    remoteOnlyPolicy: 'record-only' as const,
    autoFixLimit: 20,
    exclude: []
  }
}

describe('对账与上传的时序', () => {
  beforeEach(() => {
    configStore = JSON.parse(JSON.stringify(BASE_CONFIG))
    login.mockClear()
    list.mockClear()
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('队列里还有成千上万个待传文件时，对账不再干等（这是「等待超时」那条告警的根因）', async () => {
    const engine = new Engine({})
    await engine.start()
    await engine.updateConfig({
      syncRoot: join(userDataDir, 'sync'),
      openlist: {
        baseUrl: 'http://192.168.100.10:5244',
        username: 'admin',
        password: 'secret'
      },
      remoteRoot: '/qh/backup',
      remoteScan: { ...BASE_CONFIG.remoteScan }
    })
    engine.startSync()

    const engineAny = engine as unknown as {
      planner: { isIdle: boolean; pendingCount: number; inFlightCount: number }
      settleInFlightTransfers: (ms?: number) => Promise<number>
    }
    expect(engineAny.planner).toBeDefined()

    /*
     * 真实场景：整盘首次扫描后有 2705 个任务排队，但**没有一个在途**。
     * 这些文件还没碰远端，清单里也没有 remote_path，比对阶段根本不会看它们，
     * 所以对账完全不用等——以前却会干等 30 秒然后报「结果可能不完整」。
     */
    Object.defineProperty(engineAny.planner, 'isIdle', { get: () => false, configurable: true })
    Object.defineProperty(engineAny.planner, 'pendingCount', {
      get: () => 2705,
      configurable: true
    })
    Object.defineProperty(engineAny.planner, 'inFlightCount', { get: () => 0, configurable: true })

    const started = Date.now()
    const left = await engineAny.settleInFlightTransfers(2_500)
    const elapsed = Date.now() - started

    expect(left).toBe(0)
    expect(elapsed).toBeLessThan(500)

    engine.stop()
  })

  it('确实有文件在途时只等一小会儿，等不到就交给「跳过在途」处理', async () => {
    const engine = new Engine({})
    await engine.start()
    await engine.updateConfig({
      syncRoot: join(userDataDir, 'sync'),
      openlist: {
        baseUrl: 'http://192.168.100.10:5244',
        username: 'admin',
        password: 'secret'
      },
      remoteRoot: '/qh/backup',
      remoteScan: { ...BASE_CONFIG.remoteScan }
    })
    engine.startSync()

    const engineAny = engine as unknown as {
      planner: { isIdle: boolean; pendingCount: number; inFlightCount: number }
      settleInFlightTransfers: (ms?: number) => Promise<number>
    }

    // 有 3 个文件正在传，而且一直传不完
    Object.defineProperty(engineAny.planner, 'isIdle', { get: () => false, configurable: true })
    Object.defineProperty(engineAny.planner, 'pendingCount', {
      get: () => 3,
      configurable: true
    })
    Object.defineProperty(engineAny.planner, 'inFlightCount', { get: () => 3, configurable: true })

    const started = Date.now()
    const left = await engineAny.settleInFlightTransfers(600)
    const elapsed = Date.now() - started

    // 等到了 grace 上限，并如实回报「还有 3 个会被跳过」
    expect(left).toBe(3)
    expect(elapsed).toBeGreaterThanOrEqual(500)
    expect(elapsed).toBeLessThan(3_000)

    engine.stop()
  })
})
