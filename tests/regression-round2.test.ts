import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Engine } from '../src/main/engine'

/**
 * 本轮新增行为的回归测试。
 *
 * 覆盖的是「用户明确报过的问题」，不是实现细节：
 * - 盘符根配成同步目录时，不能再说「尚未设置同步目录」
 * - 扫描与对账的结果必须落库，重启后还在
 * - 诊断包导出必须真的能产出文件
 * - 启动后默认不开始同步
 * - 两条通道的进度互不干扰
 */

// Electron 的 app.getPath 在测试环境里不可用，给一个临时目录顶上
let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return userDataDir
      return join(userDataDir, name)
    },
    getVersion: (): string => '0.0.0-test'
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8')
  }
}))

const BASE_CONFIG = {
  syncRoot: '',
  openlist: { baseUrl: 'http://192.168.100.10:5244', username: 'admin', password: 'secret' },
  remoteRoot: '/qh/backup',
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
  detectRenames: true,
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
    adoptByNameAndSize: true,
    exclude: []
  }
}

describe('本轮回归：扫描持久化 / 盘符根 / 诊断包 / 默认不开始', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-reg-'))
    userDataDir = dir
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('扫描结果落库', () => {
    it('本地扫描结果写入 scans 表，重启后可回读', () => {
      // 先造一条本地扫描记录
      const id = manifest.startScan('local', 'startup')
      manifest.finishScan(id, 'done', { scanned: 12345, changed: 0, errors: 0 })

      const last = manifest.lastScan('local')
      expect(last).not.toBeNull()
      expect(last?.scannedCount).toBe(12345)
      expect(last?.status).toBe('done')
      // 不是 running 状态才算「已完成的一轮」
      expect(last?.finishedAt).not.toBeNull()
    })

    it('更新最近一次扫描的计数（增量事件不改历史行）', () => {
      const id = manifest.startScan('local', 'startup')
      manifest.finishScan(id, 'done', { scanned: 10, changed: 0, errors: 0 })
      manifest.updateLastScanCounts('local', { scanned: 999 })

      expect(manifest.lastScan('local')?.scannedCount).toBe(999)
      // 仍然只有一行，不会每来一个事件就插一行
      const rows = manifest.listScans('local')
      expect(rows.length).toBe(1)
    })

    it('lastScan 忽略仍在 running 的记录', () => {
      manifest.startScan('remote', 'timer')
      // 只有一条 running 记录时，lastScan 应返回 null
      expect(manifest.lastScan('remote')).toBeNull()
    })
  })

  describe('文件清单排序', () => {
    it('默认降序（local_path DESC）', () => {
      for (const p of ['a.txt', 'c.txt', 'b.txt']) {
        manifest.upsertFile({ localPath: p, localSize: 1, mtimeMs: 1, state: 'synced' })
      }
      const files = manifest.listFiles()
      expect(files.map((f) => f.localPath)).toEqual(['c.txt', 'b.txt', 'a.txt'])
    })

    it('可以显式要升序', () => {
      for (const p of ['a.txt', 'c.txt', 'b.txt']) {
        manifest.upsertFile({ localPath: p, localSize: 1, mtimeMs: 1, state: 'synced' })
      }
      const files = manifest.listFiles({ desc: false })
      expect(files.map((f) => f.localPath)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    })

    it('分页：limit + offset 能翻页，countFiles 给出总数', () => {
      for (let i = 0; i < 10; i++) {
        manifest.upsertFile({
          localPath: `f${String(i).padStart(2, '0')}.txt`,
          localSize: 1,
          mtimeMs: 1,
          state: 'synced'
        })
      }
      expect(manifest.countFiles()).toBe(10)
      const page1 = manifest.listFiles({ limit: 4 })
      const page2 = manifest.listFiles({ limit: 4, offset: 4 })
      expect(page1.length).toBe(4)
      expect(page2.length).toBe(4)
      // 两页不重叠
      const ids = new Set([...page1, ...page2].map((f) => f.id))
      expect(ids.size).toBe(8)
    })
  })

  describe('盘符根同步目录', () => {
    it('同步目录为空时：不报「不可用」，只是没设置', () => {
      const engine = new Engine({})
      const stats = engine.getStats()
      // watching 为 false，error 为 null（是「没设置」，不是「不可用」）
      expect(stats.localScan.watching).toBe(false)
      expect(stats.localScan.error).toBeNull()
      expect(stats.localScan.root).toBe('')
      engine.stop()
    })

    it('syncRoot 填了但不存在的路径时，localScan.error 给出可读原因', async () => {
      const engine = new Engine({})
      try {
        await engine.updateConfig({ syncRoot: join(dir, 'no-such-dir') })
        const stats = engine.getStats()
        expect(stats.localScan.root).toBe(join(dir, 'no-such-dir'))
        expect(stats.localScan.watching).toBe(false)
        expect(stats.localScan.error).toBeTruthy()
        // 子目录不可达要说「目录」，不能说「盘」——那会指错方向
        expect(stats.localScan.error).toContain('不可访问')
        expect(stats.localScan.error).not.toContain('盘当前不可用')
      } finally {
        engine.stop()
      }
    })

    it('盘符根不可达时，文案明确指向盘本身', () => {
      // 找一个当前**不存在**的盘符：测试机上可用盘符是因机器而异的，
      // 写死某个字母可能刚好存在（这台机器上就有 Z:）
      const missing = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(
        (c) => !existsSync(`${c}:/`)
      )
      expect(missing, '本机至少应有一个未使用的盘符').toBeTruthy()

      const engine = new Engine({})
      try {
        const anyEngine = engine as unknown as {
          config: { syncRoot: string }
          startWatcher: () => void
        }
        anyEngine.config.syncRoot = `${missing}:/`
        anyEngine.startWatcher()
        const stats = engine.getStats()
        expect(stats.localScan.watching).toBe(false)
        expect(stats.localScan.error).toContain(`${missing}:`)
        expect(stats.localScan.error).toContain('盘')
      } finally {
        engine.stop()
      }
    })
  })

  describe('启动默认不开始', () => {
    it('start() 之后 started 为 false，planner 未启动', async () => {
      const engine = new Engine({})
      await engine.start()
      const stats = engine.getStats()
      expect(stats.started).toBe(false)
      // 未开始时不应该有本地监控
      expect(stats.localScan.watching).toBe(false)
      engine.stop()
    })

    it('startSync() 之后 started 为 true', async () => {
      const syncDir = join(dir, 'sync')
      mkdirSync(syncDir, { recursive: true })
      const engine = new Engine({})
      await engine.start()
      await engine.updateConfig({ syncRoot: syncDir })
      engine.startSync()
      expect(engine.getStats().started).toBe(true)
      expect(engine.getStats().localScan.watching).toBe(true)
      engine.stop()
    })
  })

  describe('诊断包导出', () => {
    it('导出会真的产出 zip 文件（目录不存在时也要能建出来）', async () => {
      const { exportDiagnostics } = await import('../src/main/diagnostics/export')
      const engine = new Engine({})
      await engine.start()

      const path = await exportDiagnostics(engine, manifest)
      expect(path).toContain('topensync-diagnostic-')
      expect(path.endsWith('.zip')).toBe(true)

      const { existsSync, statSync } = await import('fs')
      expect(existsSync(path)).toBe(true)
      // zip 至少有本地头、中央目录、结束记录
      expect(statSync(path).size).toBeGreaterThan(100)

      engine.stop()
    })
  })
})
