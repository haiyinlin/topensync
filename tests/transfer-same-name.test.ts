import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Transfer } from '../src/main/transfer/transfer'
import { isSameNameDownloading } from '../src/main/openlist/client'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 「远端同名文件正在下载」的自愈。
 *
 * OpenList 在远端同名文件正被下载时会拒绝覆盖，PUT 报
 * `file is doloading[存在同名文件]`（服务端把 downloading 拼错了）。
 *
 * 关键在于：**重试多少次都没用**。
 * 只要那个同名文件还在被下载，每次 PUT 都是同一个错，
 * 用户看到的就是「这个文件怎么传不上去」。
 *
 * 自愈办法：删掉远端那份同名文件，等它消失，再重传一次。
 */

/** 校验环节单独 mock：这里只关心「重传」的行为 */
const verifyRemote = vi.fn().mockResolvedValue({ ok: true, detail: null })
vi.mock('../src/main/verify/verifier', () => ({
  verifyRemote: (...args: unknown[]) => verifyRemote(...args)
}))


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

describe('同名下载中的错误识别', () => {
  it('能认出 OpenList 的 doloading 报错', () => {
    expect(
      isSameNameDownloading(new Error('file is doloading[存在同名文件]'))
    ).toBe(true)
  })

  it('能认出中文提示', () => {
    expect(isSameNameDownloading(new Error('存在同名文件'))).toBe(true)
  })

  it('普通错误不误判', () => {
    expect(isSameNameDownloading(new Error('HTTP 500'))).toBe(false)
    expect(isSameNameDownloading(new Error('object not found'))).toBe(false)
    expect(isSameNameDownloading(undefined)).toBe(false)
  })
})

describe('上传遇到同名下载中时的自愈', () => {
  let dir: string
  let manifest: Manifest
  let putFile: ReturnType<typeof vi.fn>
  let remove: ReturnType<typeof vi.fn>
  let waitForGone: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-doloading-'))
    manifest = new Manifest(join(dir, 'manifest.db'))

    putFile = vi.fn()
    remove = vi.fn().mockResolvedValue(undefined)
    waitForGone = vi.fn().mockResolvedValue(true)
    verifyRemote.mockClear()
    verifyRemote.mockResolvedValue({ ok: true, detail: null })
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeTransfer(): Transfer {
    const client = {
      putFile,
      remove,
      waitForGone,
      probeMultipart: vi.fn().mockResolvedValue(false)
    } as unknown as OpenListClient

    return new Transfer({ client, manifest, config: CONFIG })
  }

  it('首次上传被同名下载中拒绝 → 删远端同名文件后重传成功', async () => {
    putFile
      .mockRejectedValueOnce(new Error('file is doloading[存在同名文件]'))
      .mockResolvedValueOnce(undefined)

    const abs = join(dir, 'a.txt')
    writeFileSync(abs, 'hello')

    const transfer = makeTransfer()
    const res = await transfer.upload({
      fileId: 1,
      relPath: 'a.txt',
      absPath: abs,
      remotePath: '/quark-backup/a.txt'
    })

    expect(res.ok).toBe(true)
    // 传了两次：第一次被拒，第二次成功
    expect(putFile).toHaveBeenCalledTimes(2)
    // 关键：删掉了远端那份同名文件
    expect(remove).toHaveBeenCalledWith(['/quark-backup/a.txt'])
    // 删完等它真的消失
    expect(waitForGone).toHaveBeenCalledWith('/quark-backup/a.txt', 10_000)
  })

  it('不是同名下载中的错误 → 不删远端文件，原样报错', async () => {
    putFile.mockRejectedValue(new Error('HTTP 500 internal error'))

    const abs = join(dir, 'b.txt')
    writeFileSync(abs, 'hello')

    const transfer = makeTransfer()
    const res = await transfer.upload({
      fileId: 1,
      relPath: 'b.txt',
      absPath: abs,
      remotePath: '/quark-backup/b.txt'
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('500')
    // 不该乱删远端
    expect(remove).not.toHaveBeenCalled()
    expect(putFile).toHaveBeenCalledTimes(1)
  })

  it('重传后仍失败 → 报失败，不无限重试', async () => {
    putFile.mockRejectedValue(new Error('file is doloading[存在同名文件]'))

    const abs = join(dir, 'c.txt')
    writeFileSync(abs, 'hello')

    const transfer = makeTransfer()
    const res = await transfer.upload({
      fileId: 1,
      relPath: 'c.txt',
      absPath: abs,
      remotePath: '/quark-backup/c.txt'
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('doloading')
    // 只重传一次（总共两次 PUT），不能无限循环
    expect(putFile).toHaveBeenCalledTimes(2)
  })

  it('删除远端同名文件失败 → 仍然尝试重传', async () => {
    putFile
      .mockRejectedValueOnce(new Error('file is doloading[存在同名文件]'))
      .mockResolvedValueOnce(undefined)
    remove.mockRejectedValue(new Error('remove failed'))

    const abs = join(dir, 'd.txt')
    writeFileSync(abs, 'hello')

    const transfer = makeTransfer()
    const res = await transfer.upload({
      fileId: 1,
      relPath: 'd.txt',
      absPath: abs,
      remotePath: '/quark-backup/d.txt'
    })

    expect(res.ok).toBe(true)
    expect(putFile).toHaveBeenCalledTimes(2)
  })
})
