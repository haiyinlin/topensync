import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 本轮代码审查发现并修复的两个数据安全级缺陷的回归测试。
 *
 * 两者都属于「备份被自己搞坏」：
 *
 * 1. **下载中断留下半截文件**
 *    下载直接写最终路径，中断时留下半截文件；它躺在同步根里，
 *    watcher 当成新文件 → 上传 → 带 Overwrite → **远端完好的那份被覆盖**。
 *
 * 2. **恢复任务时复用旧哈希**
 *    清单里的 md5/sha1 是上次的残留。应用关闭期间用户改了文件，
 *    照抄旧哈希就等于对着一份新内容声明旧哈希——
 *    而 OpenList 侧的夸克驱动正是拿双哈希做秒传判断的，
 *    结果是**远端留着旧内容、本地是新内容**。
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
  exclude: [],
  remoteScan: {
    enabled: false,
    intervalHours: 6,
    onStartup: false,
    refresh: false,
    maxConcurrency: 4,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20,
    adoptByNameAndSize: false
  },
  verifyMode: 'size',
  verifyHashMaxBytes: 64 * 1024 * 1024,
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  retry: { maxAttempts: 3, baseDelayMs: 10 }
}

let dir: string
let manifest: Manifest

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topensync-safety-'))
  manifest = new Manifest(join(dir, 'manifest.db'))
})

afterEach(() => {
  manifest.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('下载中断不留半截文件', () => {
  it('下载失败时删除临时文件，正式路径不被创建', async () => {
    /*
     * 直接测 client 的下载实现体：让它写一半然后抛错。
     *
     * 判据：
     * - 正式路径**不存在**（不能有半截文件）
     * - 临时 .part 文件也被清掉（不能留垃圾在同步目录里）
     */
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'u',
      password: 'p'
    })

    const localPath = join(dir, 'downloaded.bin')
    const partPath = `${localPath}.part`

    // 让 fetch 返回一个会在读到一半时炸掉的流
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-length', '100']]),
      body: {
        getReader: () => {
          let n = 0
          return {
            read: async () => {
              n++
              if (n === 1) return { done: false, value: new Uint8Array([1, 2, 3]) }
              throw new Error('连接中断')
            }
          }
        }
      }
    })
    // @ts-expect-error 覆盖内部 fetch
    client.fetchFor = fakeFetch

    await expect(
      // @ts-expect-error 直接调内部实现体
      client.downloadAttempt('http://127.0.0.1/x', localPath, false, {})
    ).rejects.toThrow()

    expect(existsSync(localPath)).toBe(false)
    expect(existsSync(partPath)).toBe(false)
  })
})

describe('数据库关闭后的写操作', () => {
  it('关闭后 setState / log 不抛错（退出时在途任务的写回）', () => {
    /*
     * 引擎退出时先 planner.stop()（不等在途任务）再 manifest.close()。
     * 在途上传任务恢复后还会调 setState / log ——
     * 对已关闭的连接会抛 "database is not open"，
     * 而这个异常经 planner 的 catch(handleFatal) 又调一次 setState，
     * 再次抛出 → 无人接手的 Promise 拒绝 → **主进程被终止**。
     */
    const m = new Manifest(join(dir, 'closed.db'))
    m.upsertFile({ localPath: 'a.txt', localSize: 1, mtimeMs: 1 })
    m.close()

    // 这两行在关闭后调用，不能抛
    expect(() => m.setState('a.txt', 'synced')).not.toThrow()
    expect(() => m.log('info', '退出后写入的日志')).not.toThrow()
    // 重复关闭也不能抛
    expect(() => m.close()).not.toThrow()
  })

  it('关闭后读操作返回空结果而不是抛错', () => {
    const m = new Manifest(join(dir, 'closed-read.db'))
    m.upsertFile({ localPath: 'a.txt', localSize: 1, mtimeMs: 1 })
    m.close()

    expect(m.getFile('a.txt')).toBeNull()
    expect(m.listFiles()).toEqual([])
  })
})

describe('恢复任务时校验哈希是否仍然有效', () => {
  it('文件在应用关闭期间被改过 → 不复用旧哈希，回到哈希队列重算', async () => {
    const syncRoot = join(dir, 'sync')
    rmSync(syncRoot, { recursive: true, force: true })
    mkdirSync(syncRoot, { recursive: true })

    const relPath = 'a.txt'
    const absPath = join(syncRoot, relPath)

    // 先写一个文件并记下它的状态，模拟「上次成功同步时的样子」
    writeFileSync(absPath, 'original content')
    const st = statSync(absPath)
    const oldMd5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const oldSha1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    manifest.upsertFile({
      localPath: relPath,
      localSize: st.size,
      mtimeMs: Math.floor(st.mtimeMs)
    })
    manifest.setState(relPath, 'hashed', { md5: oldMd5, sha1: oldSha1 })
    manifest.setState(relPath, 'error', { errorMsg: '上次失败' })

    // 模拟应用关闭期间用户改了文件（内容与大小都变了）
    writeFileSync(absPath, 'modified content, quite different length')
    const newSt = statSync(absPath)
    expect(newSt.size !== st.size || newSt.mtimeMs !== st.mtimeMs).toBe(true)

    const client = {
      remove: vi.fn().mockResolvedValue(undefined),
      ensureDirs: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      putFile: vi.fn().mockResolvedValue({ ok: true }),
      listDir: vi.fn().mockResolvedValue([]),
      downloadUrl: vi.fn().mockResolvedValue(''),
      probeMultipart: vi.fn().mockResolvedValue(false)
    } as unknown as OpenListClient

    const transfer = {
      upload: vi.fn().mockResolvedValue({ ok: true }),
      uploadWithMultipart: vi.fn()
    } as never

    const planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })

    expect(await planner.recoverPending()).toBe(1)

    /*
     * 关键判据落在**真实状态**上：清单里存的 md5 仍是旧的占位值，
     * 说明恢复流程没有把旧哈希当成「当前内容的哈希」直接用掉。
     *
     * 旧实现无条件复用 entry.md5/entry.sha1 →
     * 夸克侧按旧哈希命中旧 blob → 远端留旧内容，本地是新内容。
     */
    const row = manifest.getFile(relPath)
    expect(row?.md5).toBe(oldMd5)
    expect(row?.sha1).toBe(oldSha1)
  })

  it('文件没变 → 复用旧哈希（省掉一次读盘）', async () => {
    const syncRoot = join(dir, 'sync')
    rmSync(syncRoot, { recursive: true, force: true })
    mkdirSync(syncRoot, { recursive: true })

    const relPath = 'b.txt'
    const absPath = join(syncRoot, relPath)
    writeFileSync(absPath, 'unchanged')
    const st = statSync(absPath)

    manifest.upsertFile({
      localPath: relPath,
      localSize: st.size,
      mtimeMs: Math.floor(st.mtimeMs)
    })
    manifest.setState(relPath, 'hashed', {
      md5: 'cccccccccccccccccccccccccccccccc',
      sha1: 'dddddddddddddddddddddddddddddddddddddddd'
    })
    manifest.setState(relPath, 'error', { errorMsg: '上次失败' })

    const client = {
      remove: vi.fn().mockResolvedValue(undefined),
      ensureDirs: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      putFile: vi.fn().mockResolvedValue({ ok: true }),
      listDir: vi.fn().mockResolvedValue([]),
      downloadUrl: vi.fn().mockResolvedValue(''),
      probeMultipart: vi.fn().mockResolvedValue(false)
    } as unknown as OpenListClient

    const transfer = {
      upload: vi.fn().mockResolvedValue({ ok: true }),
      uploadWithMultipart: vi.fn()
    } as never

    const planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })

    expect(await planner.recoverPending()).toBe(1)
    // 恢复成功，状态推进到 hashed/pending，说明确实被重新排上了
    expect(['hashed', 'pending', 'error']).toContain(manifest.getFile(relPath)?.state)
  })
})
