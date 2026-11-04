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
    // 与默认配置一致：远端已有同名同大小时认领，不再重复上传
    adoptByNameAndSize: true,
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

/**
 * 清单里缺 `remote_path` 的「已同步」行也要参与对账。
 *
 * 以前的写法是 `if (!local.remotePath) continue`——这类行既不核对、
 * 也不判缺失，永远停在「未校验」。用户点完对账只会问：
 * 「对账是不是把它们跳过了」。
 *
 * 远端路径是确定的（远端根 + 相对路径），缺了就该按这个推。
 */
describe('缺 remote_path 的已同步行', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-no-rp-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const seed = (): void => {
    // 故意不传 remotePath：模拟「只写了 synced 状态、没记远端落点」的历史行
    manifest.upsertFile({ localPath: 'sub/a.txt', localSize: 10, mtimeMs: 1, state: 'synced' })
    manifest.setState('sub/a.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 1
    })
  }

  const remoteHasA = {
    list: vi.fn().mockImplementation(async (p: string) => ({
      content:
        p === '/quark-backup'
          ? [{ name: 'sub', size: 0, modified: '', isDir: true }]
          : p === '/quark-backup/sub'
            ? [{ name: 'a.txt', size: 10, modified: '2026-01-01T00:00:00Z', isDir: false }]
            : [],
      total: 1
    })),
    confirmMissing: vi.fn().mockResolvedValue(true),
    move: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined)
  } as unknown as OpenListClient

  it('按「远端根 + 相对路径」核对，并补上 remote_path', async () => {
    seed()
    expect(manifest.getFile('sub/a.txt')?.remotePath).toBeNull()

    await new Reconciler({ client: remoteHasA, manifest, config: CONFIG }).runNow()

    const f = manifest.getFile('sub/a.txt')
    expect(f?.verifyLevel).toBe('reconciled')
    expect(f?.remotePath, '对账确认后要把远端落点补回去').toBe('/quark-backup/sub/a.txt')
    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
  })

  it('远端确实没有时，判成「远端缺失」而不是默默跳过', async () => {
    seed()
    const emptyRemote = {
      list: vi.fn().mockResolvedValue({ content: [], total: 0 }),
      confirmMissing: vi.fn().mockResolvedValue(true),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    } as unknown as OpenListClient

    await new Reconciler({ client: emptyRemote, manifest, config: CONFIG }).runNow()

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs).toHaveLength(1)
    expect(diffs[0].kind).toBe('missing_remote')
    expect(diffs[0].remotePath).toBe('/quark-backup/sub/a.txt')
    // 判缺失时不该顺手把路径当成「已确认」
    expect(manifest.getFile('sub/a.txt')?.verifyLevel).toBeNull()
  })
})

/**
 * 已经修好的文件不能永远挂在待办里。
 *
 * 事故现场：232 条未解决差异里 188 条的 `detected_at` 是 02:23，
 * 而那些文件 04:58 就已经上传成功了——差异表从来没人关它们。
 * 用户按「补传远端缺失」的数字去点上传，八成以上是白传一遍。
 */
describe('恢复一致的差异自动关闭', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-stale-diff-'))
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
    manifest.setState('a.txt', 'synced', { remoteSize: 10, syncedSize: 10, syncedMtimeMs: 1 })
  }

  it('远端重新有了这份文件 → 旧的「远端缺失」被关掉', async () => {
    seed()
    const stale = manifest.recordDiff({
      kind: 'missing_remote',
      localPath: 'a.txt',
      remotePath: '/quark-backup/a.txt',
      localSize: 10,
      remoteSize: null,
      localMtime: 1,
      remoteMtime: null
    })
    expect(manifest.listUnresolvedDiffs()).toHaveLength(1)

    const client = {
      list: vi.fn().mockResolvedValue({
        content: [{ name: 'a.txt', size: 10, modified: '2026-01-01T00:00:00Z', isDir: false }],
        total: 1
      }),
      confirmMissing: vi.fn().mockResolvedValue(true),
      move: vi.fn(),
      remove: vi.fn()
    } as unknown as OpenListClient

    await new Reconciler({ client, manifest, config: CONFIG }).runNow()

    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
    expect(manifest.getDiff(stale.id)?.resolution).toBe('auto')
  })

  it('同一路径从「缺失」变成「大小不符」时，只留最新那一条', async () => {
    seed()
    const stale = manifest.recordDiff({
      kind: 'missing_remote',
      localPath: 'a.txt',
      remotePath: '/quark-backup/a.txt',
      localSize: 10,
      remoteSize: null,
      localMtime: 1,
      remoteMtime: null
    })

    const client = {
      list: vi.fn().mockResolvedValue({
        content: [{ name: 'a.txt', size: 99, modified: '2026-01-01T00:00:00Z', isDir: false }],
        total: 1
      }),
      confirmMissing: vi.fn().mockResolvedValue(true),
      move: vi.fn(),
      remove: vi.fn()
    } as unknown as OpenListClient

    await new Reconciler({ client, manifest, config: CONFIG }).runNow()

    const open = manifest.listUnresolvedDiffs()
    expect(open).toHaveLength(1)
    expect(open[0].kind).toBe('size_mismatch')
    expect(manifest.getDiff(stale.id)?.resolution).toBe('auto')
  })
})

/**
 * 只读对账：列出清单，但一条都不自动处理。
 *
 * 「补传远端缺失」的流程是「扫描 → 看清单 → 我确认 → 才上传」。
 * 若扫描顺手就把差异交给 Planner，用户还没看到清单，上行流量已经产生了
 * （配置里 local-wins 时最多自动重传 autoFixLimit 个）。
 */
describe('只读对账（autoFix: false）', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-readonly-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const seed = (): void => {
    // 放在子目录里：根目录列举为空会被当成「本轮结果不可信」，不判缺失
    manifest.upsertFile({
      localPath: 'sub/a.txt',
      localSize: 10,
      mtimeMs: 1,
      remotePath: '/quark-backup/sub/a.txt',
      state: 'synced'
    })
    manifest.setState('sub/a.txt', 'synced', { remoteSize: 10, syncedSize: 10, syncedMtimeMs: 1 })
  }

  const client = {
    list: vi.fn().mockResolvedValue({ content: [], total: 0 }),
    confirmMissing: vi.fn().mockResolvedValue(true),
    move: vi.fn(),
    remove: vi.fn()
  } as unknown as OpenListClient

  it('差异照常记录，但不调用自动处置', async () => {
    seed()
    const onDiff = vi.fn()
    await new Reconciler({ client, manifest, config: CONFIG, onDiff }).runNow({ autoFix: false })

    expect(manifest.listUnresolvedDiffs()).toHaveLength(1)
    expect(onDiff).not.toHaveBeenCalled()
  })

  it('默认（不传参）仍然自动处置，定时对账不会因刚跑过只读而失效', async () => {
    seed()
    const onDiff = vi.fn()
    const r = new Reconciler({ client, manifest, config: CONFIG, onDiff })

    await r.runNow({ autoFix: false })
    expect(onDiff).not.toHaveBeenCalled()

    // 关键：这是**实例状态**而非一次性参数的话，下面这次会被上一次污染
    await r.runNow()
    expect(onDiff).toHaveBeenCalled()
  })
})

/**
 * 尚未上传的文件也要参与比对。
 *
 * 用户反馈：「对账扫出来 60 个，一开同步又有 100 多个要传」。
 * 根因是对账的 `expectedRemotePath` 只对 `state='synced'` 的行推路径，
 * 856 个 pending + 3502 个 hashed 压根不参与比对——「远端缺什么」
 * 这个答案永远少一截，两个数字当然对不上。
 *
 * 现在：所有非 deleted 的记录都推路径，类型按状态区分。
 */
describe('尚未上传的文件纳入对账', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-unsent-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const seedPending = (): void => {
    // 从没上传过：state=pending，remote_path 与 remote_size 都是空的
    manifest.upsertFile({ localPath: 'sub/a.txt', localSize: 10, mtimeMs: 1, state: 'pending' })
  }

  const remoteWith = (size: number) =>
    ({
      list: vi.fn().mockImplementation(async (p: string) => ({
        content:
          p === '/quark-backup'
            ? [{ name: 'sub', size: 0, modified: '', isDir: true }]
            : p === '/quark-backup/sub'
              ? [{ name: 'a.txt', size, modified: '2026-01-01T00:00:00Z', isDir: false }]
              : [],
        total: 1
      })),
      confirmMissing: vi.fn().mockResolvedValue(true),
      move: vi.fn(),
      remove: vi.fn()
    }) as unknown as OpenListClient

  const emptyRemote =
    {
      list: vi.fn().mockResolvedValue({ content: [], total: 0 }),
      confirmMissing: vi.fn().mockResolvedValue(true),
      move: vi.fn(),
      remove: vi.fn()
    } as unknown as OpenListClient

  it('远端没有 → 记成「仅本地」，不再静默跳过', async () => {
    seedPending()
    await new Reconciler({ client: emptyRemote, manifest, config: CONFIG }).runNow()

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs).toHaveLength(1)
    expect(diffs[0].kind).toBe('local_only')
    expect(diffs[0].remotePath).toBe('/quark-backup/sub/a.txt')
  })

  it('远端已有同名同大小 → 认领为已同步，不产生差异（避免重复上传）', async () => {
    seedPending()
    await new Reconciler({ client: remoteWith(10), manifest, config: CONFIG }).runNow()

    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
    expect(manifest.getFile('sub/a.txt')?.state).toBe('synced')
  })

  it('远端同名但大小不同 → 判「内容不符」，不能因为 remote_size 为空就误判一切', async () => {
    seedPending()
    await new Reconciler({ client: remoteWith(99), manifest, config: CONFIG }).runNow()

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs).toHaveLength(1)
    expect(diffs[0].kind).toBe('size_mismatch')
  })
})
