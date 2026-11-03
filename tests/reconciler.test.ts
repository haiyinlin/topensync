import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Reconciler } from '../src/main/reconcile/reconciler'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 远端对账器的测试。
 *
 * 重点是**排除项**：远端排除与本地排除语义不同——
 * 本地排除是「不上传」，远端排除是「不参与比对」。
 * 两者混在一起会制造出「本地没有、远端有」的噪声差异。
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

describe('Reconciler 远端排除项', () => {
  let dir: string
  let manifest: Manifest
  let list: ReturnType<typeof vi.fn>

  /** 构造一个按路径返回不同内容的假远端 */
  function makeClient(tree: Record<string, { name: string; isDir: boolean; size?: number }[]>): OpenListClient {
    list = vi.fn().mockImplementation(async (path: string) => {
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
    dir = mkdtempSync(join(tmpdir(), 'topensync-recon-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('命中排除规则的目录不会被遍历', async () => {
    const client = makeClient({
      '/quark-backup': [
        { name: 'keep', isDir: true },
        { name: 'skipme', isDir: true }
      ],
      '/quark-backup/keep': [{ name: 'a.txt', isDir: false }],
      '/quark-backup/skipme': [{ name: 'b.txt', isDir: false }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: {
        ...CONFIG,
        remoteScan: { ...CONFIG.remoteScan, exclude: ['skipme/**', 'skipme'] }
      }
    })

    const res = await rec.runNow()

    // 被排除目录下的文件不该被计入
    expect(res.scannedFiles).toBe(1)
    const listed = list.mock.calls.map((c) => c[0])
    expect(listed).not.toContain('/quark-backup/skipme')
  })

  it('命中排除规则的文件不参与比对', async () => {
    const client = makeClient({
      '/quark-backup': [
        { name: 'a.txt', isDir: false },
        { name: '.DS_Store', isDir: false }
      ]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: {
        ...CONFIG,
        remoteScan: { ...CONFIG.remoteScan, exclude: ['**/.DS_Store'] }
      }
    })

    const res = await rec.runNow()

    expect(res.scannedFiles).toBe(1)
    // 被排除的文件不该产生 remote_only 差异
    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.every((d) => !d.remotePath.includes('.DS_Store'))).toBe(true)
  })

  it('回收站目录始终不参与比对', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: '_trash', isDir: true }],
      '/quark-backup/_trash': [{ name: 'old.txt', isDir: false }]
    })

    const rec = new Reconciler({ client, manifest, config: CONFIG })
    const res = await rec.runNow()

    expect(res.scannedFiles).toBe(0)
    expect(list.mock.calls.map((c) => c[0])).not.toContain('/quark-backup/_trash')
  })

  it('无排除项时远端文件全部参与比对', async () => {
    const client = makeClient({
      '/quark-backup': [
        { name: 'a.txt', isDir: false },
        { name: 'b.txt', isDir: false }
      ]
    })

    const rec = new Reconciler({ client, manifest, config: CONFIG })
    const res = await rec.runNow()

    expect(res.scannedFiles).toBe(2)
  })
})

describe('Reconciler 远端多出文件的处置策略', () => {
  let dir: string
  let manifest: Manifest
  let move: ReturnType<typeof vi.fn>
  let downloadTo: ReturnType<typeof vi.fn>

  function buildClient(): OpenListClient {
    move = vi.fn().mockResolvedValue(undefined)
    downloadTo = vi.fn().mockResolvedValue(undefined)
    return {
      list: vi.fn().mockResolvedValue({
        content: [{ name: 'extra.txt', size: 10, modified: '2026-01-01T00:00:00Z', isDir: false }],
        total: 1,
        provider: 'mock'
      }),
      move,
      downloadTo
    } as unknown as OpenListClient
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-rop-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('record-only（默认）只记录，不做任何动作', async () => {
    const rec = new Reconciler({ client: buildClient(), manifest, config: CONFIG })
    await rec.runNow()

    expect(downloadTo).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
    expect(manifest.listUnresolvedDiffs()).toHaveLength(1)
  })

  it('pull 策略把远端文件下载到本地', async () => {
    const rec = new Reconciler({
      client: buildClient(),
      manifest,
      config: {
        ...CONFIG,
        syncRoot: join(dir, 'sync'),
        remoteScan: { ...CONFIG.remoteScan, remoteOnlyPolicy: 'pull' }
      }
    })
    await rec.runNow()

    expect(downloadTo).toHaveBeenCalledTimes(1)
    expect(downloadTo.mock.calls[0][0]).toBe('/quark-backup/extra.txt')
    expect(downloadTo.mock.calls[0][1]).toContain('extra.txt')
  })

  it('delete 策略把远端文件移入回收站', async () => {
    const rec = new Reconciler({
      client: buildClient(),
      manifest,
      config: {
        ...CONFIG,
        remoteScan: { ...CONFIG.remoteScan, remoteOnlyPolicy: 'delete' }
      }
    })
    await rec.runNow()

    expect(move).toHaveBeenCalledTimes(1)
    const [src, dst] = move.mock.calls[0]
    expect(src).toBe('/quark-backup/extra.txt')
    expect(dst).toContain('/_trash/')
  })

  it('超过自动修复上限后不再动作', async () => {
    const rec = new Reconciler({
      client: buildClient(),
      manifest,
      config: {
        ...CONFIG,
        remoteScan: { ...CONFIG.remoteScan, remoteOnlyPolicy: 'delete', autoFixLimit: 0 }
      }
    })
    await rec.runNow()

    expect(move).not.toHaveBeenCalled()
  })
})

describe('Reconciler 对「远端列举不出来」的容错', () => {
  // 实机背景（2026-11-01 实测）：
  // OpenList 的目录列表是快照缓存，`refresh:true` 会用夸克侧当时的真实列表
  // **整体替换**缓存。夸克驱动建目录是异步的，新建目录要过约 3 秒才进父目录列表；
  // 这段窗口里刷新父目录，缓存会被替换成「还没有它」的旧列表——
  // 新目录连同整棵子树从 OpenList 视野里消失（list 抛 object not found）。
  //
  // 若对账器把「列不出来」当成「文件没了」，就会把整棵树判成远端缺失并触发
  // 全量重传——白白再上行一遍，是最坏的一类误判。
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-recon-err-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 造一个「本地已同步、远端子目录列举失败」的场景 */
  function buildFailingClient(listImpl: (path: string) => Promise<unknown>): OpenListClient {
    return {
      list: vi.fn(listImpl),
      // 客户端层面的复核也认为「确实缺失」
      confirmMissing: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue(null)
    } as unknown as OpenListClient
  }

  it('子目录列举抛错时，其下的文件不判「远端缺失」', async () => {
    manifest.upsertFile({
      localPath: 'sub/a.txt',
      localSize: 10,
      mtimeMs: 1,
      remotePath: '/quark-backup/sub/a.txt',
      state: 'synced'
    })
    manifest.setState('sub/a.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 1
    })

    const client = buildFailingClient(async (path: string) => {
      if (path === '/quark-backup') {
        return { content: [{ name: 'sub', size: 0, modified: '', isDir: true }], total: 1 }
      }
      // 子目录列举失败：缓存被刷新抹掉，目录暂时不可见
      throw new Error('failed get objs: failed get dir: object not found')
    })

    const rec = new Reconciler({ client, manifest, config: CONFIG })
    const res = await rec.runNow()

    const missing = manifest
      .listUnresolvedDiffs()
      .filter((d) => d.kind === 'missing_remote')
    expect(missing, '列举失败的目录下的文件不能判为远端缺失').toHaveLength(0)
    expect(res.diffCount).toBe(0)
  })

  it('子目录列举返回空列表时，其下的文件不判「远端缺失」', async () => {
    manifest.upsertFile({
      localPath: 'sub/a.txt',
      localSize: 10,
      mtimeMs: 1,
      remotePath: '/quark-backup/sub/a.txt',
      state: 'synced'
    })
    manifest.setState('sub/a.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 1
    })

    const client = buildFailingClient(async (path: string) => {
      if (path === '/quark-backup') {
        return { content: [{ name: 'sub', size: 0, modified: '', isDir: true }], total: 1 }
      }
      // 空列表：可能是刷新拿到旧列表后的结果，不足以说明文件没了
      return { content: [], total: 0 }
    })

    const rec = new Reconciler({ client, manifest, config: CONFIG })
    await rec.runNow()

    const missing = manifest
      .listUnresolvedDiffs()
      .filter((d) => d.kind === 'missing_remote')
    expect(missing, '空列表不能直接判定远端缺失').toHaveLength(0)
  })
})

/**
 * 对账确认「远端在、大小对」之后，可信度要跟着升级。
 *
 * 用户反馈：「我重新对账，可信度也是未校验」。当时对账只盖了一个
 * last_verify_at 时间戳，`verify_level` 一个都不动——四千多条仍然写着
 * 「未校验」，看着像对账什么都没做。
 *
 * 升级目标是 `reconciled`（已核对）而不是 `size`（仅大小）：
 * 后者是「认领」专用——我们从没真正上传过那份文件，风险不同，界面用黄色提醒。
 */
describe('对账后可信度的升级', () => {
  let dir: string
  let manifest: Manifest

  const client = {
    list: vi.fn().mockResolvedValue({
      content: [{ name: 'a.txt', size: 10, modified: '2026-01-01T00:00:00Z', isDir: false }],
      total: 1
    }),
    move: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined)
  } as unknown as OpenListClient

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-verify-level-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const seed = (): void => {
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: 10,
      mtimeMs: 1,
      remotePath: '/quark-backup/a.txt',
      state: 'synced'
    })
    manifest.setState('a.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 1
    })
  }

  it('未校验 → 已核对（这一轮确实核对过远端）', async () => {
    seed()
    expect(manifest.getFile('a.txt')?.verifyLevel).toBeNull()

    await new Reconciler({ client, manifest, config: CONFIG }).runNow()

    expect(manifest.getFile('a.txt')?.verifyLevel).toBe('reconciled')
    // 差异列表里不该多出条目——确认一致不是差异
    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
  })

  it('哈希确认不会被对账降级', async () => {
    seed()
    // 深度校验写过远端哈希 → hash
    manifest.setState('a.txt', 'synced', { syncedMd5: 'm', syncedSha1: 's' })
    expect(manifest.getFile('a.txt')?.verifyLevel).toBe('hash')

    await new Reconciler({ client, manifest, config: CONFIG }).runNow()

    expect(manifest.getFile('a.txt')?.verifyLevel).toBe('hash')
  })
})
