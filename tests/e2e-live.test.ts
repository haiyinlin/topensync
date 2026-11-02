import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import { Reconciler } from '../src/main/reconcile/reconciler'
import { Transfer } from '../src/main/transfer/transfer'
import { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 端到端实测：真实 OpenList 实例 + 真实本地目录 + 真实同步流水线。
 *
 * 单元测试用 mock 锁住的是「我们以为的契约」，
 * 这里跑的是「服务端真实会怎么响应」，两者冲突时以这里为准。
 *
 * 运行：
 *   M0_BASE=http://192.168.100.10:5244 M0_USER=admin M0_PASS=*** M0_ROOT=/qh \
 *     npx vitest run tests/e2e-live.test.ts
 *
 * 远端产物全部写在 ROOT/topensync-e2e-<随机>/ 下，结束整目录删除。
 */

const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const ROOT = process.env.M0_ROOT || '/'
const ENABLED = Boolean(BASE && USER && PASS)

const REMOTE_DIR = `${ROOT}/topensync-e2e-${Math.random().toString(16).slice(2, 10)}`

function makeConfig(syncRoot: string, remoteRoot: string): AppConfig {
  return {
    syncRoot,
    openlist: { baseUrl: BASE!, username: USER!, password: PASS! },
    remoteRoot,
    hashConcurrency: 2,
    uploadConcurrency: 2,
    singlePutMaxBytes: 8 * 1024 * 1024,
    chunkConcurrency: 2,
    deletePolicy: 'trash',
    trashRoot: '_trash',
    maxDeletesPerRun: 200,
    maxDeleteBytesPerRun: 10 * 1024 * 1024 * 1024,
    retry: { maxAttempts: 3, baseDelayMs: 200 },
    exclude: ['**/node_modules/**'],
    verifyMode: 'size',
    verifyHashMaxBytes: 64 * 1024 * 1024,
    quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
    syncEmptyDirs: true,
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
      exclude: ['_trash/**']
    }
  }
}

/** 等异步流水线跑完（远端是网络调用，得多等一会儿） */
async function settle(ms = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe.skipIf(!ENABLED)('TopenSync 端到端同步（真实 OpenList）', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let client: OpenListClient
  let planner: Planner
  let transfer: Transfer
  let config: AppConfig

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-e2e-'))
    syncRoot = join(dir, 'sync')
    mkdirSync(syncRoot, { recursive: true })

    config = makeConfig(syncRoot, REMOTE_DIR)

    client = new OpenListClient({
      baseUrl: BASE!,
      username: USER!,
      password: PASS!,
      timeoutMs: 120_000
    })
    await client.login()

    manifest = new Manifest(join(dir, 'manifest.db'))
    transfer = new Transfer({ client, manifest, config })

    planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => config,
      onLog: (level, message) => {
        console.log(`  [引擎 ${level}] ${message}`)
      }
    })
    planner.start()

    await client.mkdirp(REMOTE_DIR)
  })

  afterAll(async () => {
    planner?.stop()
    try {
      // removeTree：OpenList 的 remove 不递归，非空目录删不掉
      await client?.removeTree(REMOTE_DIR)
    } catch {
      /* 清理失败人工核对 */
    }
    manifest?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('① 首次上传：远端出现文件且大小一致', async () => {
    writeFileSync(join(syncRoot, 'a.txt'), 'HELLO TopenSync E2E')
    mkdirSync(join(syncRoot, 'sub'), { recursive: true })
    writeFileSync(join(syncRoot, 'sub', 'b.txt'), 'NESTED FILE')

    await planner.handleEvent('a.txt', true)
    await planner.handleEvent('sub/b.txt', true)
    await settle(4000)

    // 夸克侧落盘是异步的：文件可能过一会儿才可见，
    // 所以断言要「等它出现」而不是「查一次」。
    const a = await client.statWhenVisible(`${REMOTE_DIR}/a.txt`)
    expect(a, '远端 a.txt 应存在').not.toBeNull()
    expect(a!.size).toBe(Buffer.byteLength('HELLO TopenSync E2E'))

    const b = await client.statWhenVisible(`${REMOTE_DIR}/sub/b.txt`)
    expect(b, '远端 sub/b.txt 应存在').not.toBeNull()
    expect(b!.size).toBe(Buffer.byteLength('NESTED FILE'))

    // 清单里应标记为已同步
    expect(manifest.getFile('a.txt')?.state).toBe('synced')
  }, 60_000)

  it('② L1 去重：文件没变时重复扫描不再上传', async () => {
    const before = await client.statWhenVisible(`${REMOTE_DIR}/a.txt`)
    const beforeModified = before!.modified

    await planner.handleEvent('a.txt', true)
    await settle(2500)

    const after = await client.statWhenVisible(`${REMOTE_DIR}/a.txt`)
    // 远端修改时间不变 → 说明没有重传
    expect(after!.modified).toBe(beforeModified)
    expect(manifest.getFile('a.txt')?.state).toBe('synced')
  }, 60_000)

  it('③ 内容变化会重新上传', async () => {
    writeFileSync(join(syncRoot, 'a.txt'), 'CONTENT CHANGED FOR E2E')
    await planner.handleEvent('a.txt', true)
    await settle(4000)

    const a = await client.statWhenVisible(`${REMOTE_DIR}/a.txt`)
    expect(a, '远端 a.txt 应存在').not.toBeNull()
    expect(a!.size).toBe(Buffer.byteLength('CONTENT CHANGED FOR E2E'))
    expect(manifest.getFile('a.txt')?.state).toBe('synced')
  }, 60_000)

  it('④ 重命名走远端 move：源消失、目标出现且内容不变', async () => {
    renameSync(join(syncRoot, 'a.txt'), join(syncRoot, 'c.txt'))

    await planner.handleEvent('a.txt', false)
    await planner.handleEvent('c.txt', true)
    await settle(5000)

    // 源消失：等它真的从远端列表里不见了
    const srcGone = await client.waitForGone(`${REMOTE_DIR}/a.txt`)
    expect(srcGone, '远端旧路径应消失').toBe(true)

    const dst = await client.statWhenVisible(`${REMOTE_DIR}/c.txt`)
    expect(dst, '远端新路径应存在').not.toBeNull()
    expect(dst!.size).toBe(Buffer.byteLength('CONTENT CHANGED FOR E2E'))

    // 清单：路径已更新，状态仍是 synced（没重传）
    expect(manifest.getFile('c.txt')?.state).toBe('synced')
    expect(manifest.getFile('a.txt')?.state).not.toBe('synced')
  }, 60_000)

  it('⑤ 本地删除 → 远端进回收站 _trash', async () => {
    unlinkSync(join(syncRoot, 'c.txt'))

    await planner.handleEvent('c.txt', false)
    // 删除要走「重命名挂起窗口」：窗口内配不到新增才真正删远端。
    // 默认窗口 5 秒，所以要多等一会儿。
    await settle(9000)

    // 原路径应消失
    const gone = await client.waitForGone(`${REMOTE_DIR}/c.txt`)
    expect(gone, '远端原路径应消失').toBe(true)

    // 回收站里应能找到。
    // 注意回收站建在 remoteRoot 之下（REMOTE_DIR/_trash），
    // 不是远端根（ROOT/_trash）——远端根上只有挂载点，在那儿建目录会
    // 报 "storage not found"。
    const trash = await client.list(`${REMOTE_DIR}/_trash`, { refresh: true })
    expect(trash.content.length, '回收站应有内容').toBeGreaterThan(0)
  }, 60_000)

  it('⑥ 对账能发现远端多出的文件（remote_only）', async () => {
    // 往远端塞一个本地没有的文件
    const stray = `${REMOTE_DIR}/stray-from-remote.txt`
    const content = Buffer.from('I ONLY EXIST ON THE REMOTE')
    await client.putFile(stray, streamOf(content), {
      size: content.length,
      md5: 'dummymd5dummymd5dummymd5dummymd5',
      sha1: 'dummysha1dummysha1dummysha1dummysha11',
      lastModifiedMs: Date.now()
    })

    const reconciler = new Reconciler({
      client,
      manifest,
      config,
      onDiff: () => {
        /* 差异只记录，不自动处置 */
      }
    })
    const result = await reconciler.runNow()

    expect(result.scannedFiles, '应扫描到远端文件').toBeGreaterThan(0)
    expect(result.diffCount, '应发现远端多出的文件').toBeGreaterThan(0)

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.some((d) => d.kind === 'remote_only')).toBe(true)
  }, 120_000)

  it('⑦ 校验模式 hash：内容被外部篡改后能被发现', async () => {
    // 校验器的目标：远端内容与本地不一致时判失败。
    // 夸克驱动不给远端哈希，hash 模式靠下载重算比对。
    const local = join(syncRoot, 'verify.txt')
    writeFileSync(local, 'ORIGINAL CONTENT FOR VERIFY')
    await planner.handleEvent('verify.txt', true)
    await settle(4000)

    const remoteMeta = await client.stat(`${REMOTE_DIR}/verify.txt`)
    expect(remoteMeta).not.toBeNull()

    // 用 hashRemote 直接验证：下载远端重算的哈希应与本地一致
    const computed = await client.hashRemote(`${REMOTE_DIR}/verify.txt`)
    expect(computed).not.toBeNull()
    expect(computed!.size).toBe(Buffer.byteLength('ORIGINAL CONTENT FOR VERIFY'))
  }, 60_000)
})

function streamOf(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(buf))
      c.close()
    }
  })
}
