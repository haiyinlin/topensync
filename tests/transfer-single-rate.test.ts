import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 单次 PUT 的流式速率。
 *
 * 锁住一个真实反馈：「文件在上传，但没有显示上传速率」。
 *
 * 根因：大文件在服务端不支持分片时走单次 PUT（putFile），
 * 而 putFile 是一次性把整个 ReadableStream 送出去，中间**没有任何
 * 进度回调**。于是整个传输期间（几十秒到几分钟）上层收不到任何
 * delta，`Engine.recordSpeed` 一次都没被调用 → 当前速率归零，
 * 界面显示「0 B/s」——而峰值/平均因为之前的小文件还有值。
 *
 * 修复：putFile 用 TransformStream 包一层字节计数，每读出一块
 * 就回调累计字节，上层换算成增量实时喂给速率统计。
 */

/** 校验环节 mock：这里只关心「流式进度」的行为 */
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

describe('单次 PUT 的流式速率', () => {
  let dir: string
  let manifest: Manifest
  let putFile: ReturnType<typeof vi.fn>
  let remove: ReturnType<typeof vi.fn>
  let waitForGone: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-single-rate-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
    putFile = vi.fn().mockResolvedValue(undefined)
    remove = vi.fn().mockResolvedValue(undefined)
    waitForGone = vi.fn().mockResolvedValue(true)
    verifyRemote.mockClear()
    verifyRemote.mockResolvedValue({ ok: true, detail: null })
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('单次 PUT 会把 onProgress 传给 putFile，并据此流式上报增量', async () => {
    // 一个会流式回调进度的 putFile：模拟真实网络把文件分两块送出
    putFile.mockImplementation(
      async (_remotePath: string, _body: unknown, opts: { onProgress?: (n: number) => void }) => {
        // 分两块「送出」，每块都触发一次进度
        opts.onProgress?.(512 * 1024)
        opts.onProgress?.(1024 * 1024)
      }
    )

    const abs = join(dir, 'big.bin')
    writeFileSync(abs, Buffer.alloc(1024 * 1024)) // 1 MB

    const progress: Array<{ sent: number; total: number; delta: number }> = []
    const client = {
      putFile,
      remove,
      waitForGone,
      probeMultipart: vi.fn().mockResolvedValue(false) // 不支持分片 → 走单次 PUT
    } as unknown as OpenListClient

    const transfer = new Transfer({
      client,
      manifest,
      config: CONFIG,
      onProgress: (info) => progress.push({ sent: info.sent, total: info.total, delta: info.delta })
    })

    const res = await transfer.upload({
      fileId: 1,
      relPath: 'big.bin',
      absPath: abs,
      remotePath: '/quark-backup/big.bin'
    })

    expect(res.ok).toBe(true)

    // putFile 确实收到了 onProgress 回调（这是修复的核心：以前根本没这个参数）
    expect(putFile).toHaveBeenCalledTimes(1)
    const putOpts = putFile.mock.calls[0][2] as { onProgress?: (n: number) => void }
    expect(putOpts.onProgress).toBeTypeOf('function')

    // 上层收到了流式增量：两次 onProgress（512KB + 512KB），加上收尾的完成态
    // 关键：中间那两次的 delta 是增量（各 512KB），不是 0
    const deltas = progress.map((p) => p.delta)
    expect(deltas).toContain(512 * 1024)

    // 增量总和 = 文件大小（512KB + 512KB），不会被收尾那次重复计成 2 倍
    const totalDelta = progress.reduce((sum, p) => sum + p.delta, 0)
    expect(totalDelta).toBe(1024 * 1024)
  })

  it('收尾的完成态不再重复计一次全量 delta（否则 totalBytes 翻倍）', async () => {
    putFile.mockImplementation(
      async (_remotePath: string, _body: unknown, opts: { onProgress?: (n: number) => void }) => {
        opts.onProgress?.(1024 * 1024) // 流式只报一次全量
      }
    )

    const abs = join(dir, 'big.bin')
    writeFileSync(abs, Buffer.alloc(1024 * 1024))

    const progress: Array<{ delta: number }> = []
    const client = {
      putFile,
      remove,
      waitForGone,
      probeMultipart: vi.fn().mockResolvedValue(false)
    } as unknown as OpenListClient

    const transfer = new Transfer({
      client,
      manifest,
      config: CONFIG,
      onProgress: (info) => progress.push({ delta: info.delta })
    })

    await transfer.upload({
      fileId: 1,
      relPath: 'big.bin',
      absPath: abs,
      remotePath: '/quark-backup/big.bin'
    })

    // 总增量 = 1 MB（流式报一次 1MB + 收尾报 0），而不是 2 MB
    const totalDelta = progress.reduce((sum, p) => sum + p.delta, 0)
    expect(totalDelta).toBe(1024 * 1024)
  })
})
