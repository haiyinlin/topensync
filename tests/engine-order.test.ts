import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Engine 的装配顺序测试。
 *
 * 锁住一条曾经真实存在的 bug：
 *
 *   「首次配置」时，用户一次性填完地址、账号、密码、远端根、对账参数。
 *   updateConfig 里却**先建对账器、后握手**——
 *   而 startReconciler 有这么一道闸：`if (!this.connection.reachable) return`。
 *   握手还没跑，reachable 还是 false → 对账器**根本没被创建**。
 *
 *   后果：点「立即对账」毫无反应，日志里只留一句
 *   「尚未连接 OpenList，无法执行远端对账」——而连接其实是通的。
 *
 * 顺序必须反过来：**先握手，再建对账器**。
 */

/** Electron 在 node 环境里不可用，这里替换成最小实现 */
const userDataDir = mkdtempSync(join(tmpdir(), 'topensync-engine-'))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir())
  }
}))

/**
 * 配置读写替换成内存实现，避免测试去碰真实的用户配置。
 *
 * normalizeConfig 必须保留真实实现——它负责去掉路径首尾空白，
 * 而路径带空白会导致文件传到「另一个目录」去（重复上传）。
 */
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

/** OpenList 客户端全部替换成假实现 */
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
  remove: vi.fn().mockResolvedValue(undefined)
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

describe('Engine 配置更新后的装配顺序', () => {
  beforeEach(() => {
    configStore = JSON.parse(JSON.stringify(BASE_CONFIG))
    login.mockClear()
    list.mockClear()
  })

  // 临时目录在 afterAll 里统一删：
  // 引擎还持有 manifest.db 的句柄时删目录会报 EBUSY。
  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('首次配置（地址与对账参数一起改）后对账器确实被创建', async () => {
    const engine = new Engine({})
    await engine.start()

    // 模拟用户在连接页一次性填完所有字段
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

    // 对账器必须存在——否则「立即对账」会静默失败
    const reconciler = (engine as unknown as { reconciler: unknown }).reconciler
    expect(reconciler, '握手之后必须创建对账器').not.toBeNull()

    engine.stop()
  })

  it('配置更新后握手确实跑过了（顺序是先握手）', async () => {
    const engine = new Engine({})
    await engine.start()
    login.mockClear()

    await engine.updateConfig({
      openlist: {
        baseUrl: 'http://192.168.100.10:5244',
        username: 'admin',
        password: 'secret'
      }
    })

    expect(login, '配置里改了连接信息就必须重新握手').toHaveBeenCalled()
    engine.stop()
  })

  it('连接失败时不创建对账器（没连上建了也没用）', async () => {
    login.mockRejectedValueOnce(new Error('connection refused'))

    const engine = new Engine({})
    await engine.start()

    await engine.updateConfig({
      openlist: {
        baseUrl: 'http://127.0.0.1:1',
        username: 'u',
        password: 'p'
      },
      remoteScan: { ...BASE_CONFIG.remoteScan }
    })

    const reconciler = (engine as unknown as { reconciler: unknown }).reconciler
    expect(reconciler).toBeNull()

    engine.stop()
  })

  it('触发远端对账时不会因为「对账器缺失」而静默跳过', async () => {
    const engine = new Engine({})
    await engine.start()

    const logs: string[] = []
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

    // 连上了 → 对账器在 → 触发对账不该报「尚未连接」
    const engineLogs = (engine as unknown as {
      manifest: { recentLogs: (n: number) => { message: string }[] }
    }).manifest.recentLogs(50)
    for (const l of engineLogs) logs.push(l.message)

    expect(logs.some((m) => m.includes('尚未连接 OpenList，无法执行远端对账'))).toBe(false)
    engine.stop()
  })
})
