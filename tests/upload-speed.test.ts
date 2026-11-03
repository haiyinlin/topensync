import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Transfer } from '../src/main/transfer/transfer'
import { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 上传速率的统计口径。
 *
 * 用户反馈：列表里几行速率加起来 54 MB/s，顶栏总速率只有 20 MB/s。
 * 根因在分片上传的续传分支——`sent` 里包含了「服务端已有、直接跳过」
 * 的分片，而分母是「从开始到现在」。断点续传时几毫秒就把 sent 加到几 GB，
 * 速率瞬间爆表，之后按「几 GB ÷ 已耗时」缓慢回落，几百秒后仍显示十几 MB/s。
 *
 * 这里用限速的本地服务端做真值：上报的速率必须贴近「真实上传的字节 ÷ 真实耗时」，
 * 不能被续传进度顶高。
 */
const CONFIG: AppConfig = {
  syncRoot: '',
  openlist: { baseUrl: 'http://127.0.0.1:0', username: '', password: '' },
  remoteRoot: '/r',
  hashConcurrency: 2,
  uploadConcurrency: 1,
  singlePutMaxBytes: 8 * 1024 * 1024,
  chunkConcurrency: 2,
  deletePolicy: 'trash',
  trashRoot: '_trash',
  maxDeletesPerRun: 200,
  maxDeleteBytesPerRun: 1,
  retry: { maxAttempts: 1, baseDelayMs: 10 },
  exclude: [],
  verifyMode: 'size',
  verifyHashMaxBytes: 0,
  quarkMaxFileBytes: 0,
  syncEmptyDirs: false,
  detectRenames: false,
  renameWindowMs: 5000,
  remoteScan: {
    enabled: false,
    intervalHours: 6,
    onStartup: false,
    refresh: false,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20,
    exclude: []
  }
}

const MB = 1024 * 1024

describe('分片上传的速率口径', () => {
  let dir = ''
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('续传跳过的分片不该计入速率', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-mp-speed-'))
    const size = 25 * MB // 10MB 分片 → 3 片，最后一片 5MB
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(size, 7))

    server = createServer((req, res) => {
      const url = req.url ?? ''
      const json = (o: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      if (url.startsWith('/multipart/status')) {
        // 第一个分片「已经传过」——模拟上次中断后的续传
        json({ code: 200, data: { parts: [0] } })
        return
      }
      if (url.startsWith('/multipart/init')) {
        json({ code: 200, data: { upload_id: 'u1', resumed: true } })
        return
      }
      if (url.startsWith('/multipart/complete')) {
        json({ code: 200, data: {} })
        return
      }
      if (url.startsWith('/multipart/chunk')) {
        // 每个分片限速约 1 秒
        let n = 0
        req.on('data', (chunk: Buffer) => {
          n += chunk.length
          if (n > 2 * MB) {
            req.pause()
            setTimeout(() => req.resume(), 8)
          }
        })
        req.on('end', () => json({ code: 200, data: {} }))
        return
      }
      json({ code: 200, data: {} })
    })

    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server!.address() as { port: number }).port

    const manifest = new Manifest(join(dir, 'manifest.db'))
    const client = new OpenListClient({
      baseUrl: `http://127.0.0.1:${port}`,
      username: '',
      password: '',
      timeoutMs: 60_000
    })

    const samples: { ts: number; sent: number; speed: number; delta: number }[] = []
    const started = Date.now()
    const transfer = new Transfer({
      client,
      manifest,
      getConfig: () => ({ ...CONFIG, syncRoot: dir }),
      onProgress: (i) => {
        samples.push({ ts: Date.now(), sent: i.sent, speed: i.speed, delta: i.delta })
      }
    })

    await transfer.upload({
      fileId: 1,
      relPath: 'big.bin',
      absPath: join(dir, 'big.bin'),
      remotePath: '/r/big.bin'
    })

    const wallSec = (Date.now() - started) / 1000
    const last = samples[samples.length - 1]
    const netBytes = samples.reduce((a, s) => a + s.delta, 0)
    const netSec = samples.length > 1 ? (last.ts - samples[0].ts) / 1000 : wallSec

    const reported = last.speed / MB
    // 真值：相邻两次上报之间的「真实字节 ÷ 真实间隔」
    const segs: number[] = []
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].ts - samples[i - 1].ts) / 1000
      if (dt > 0.3) segs.push(samples[i].delta / MB / dt)
    }
    const truth = segs.length > 0 ? segs.reduce((a, b) => a + b, 0) / segs.length : 0

    manifest.close()
    console.log(
      'SPEED',
      JSON.stringify({ reportedMB: +reported.toFixed(2), truthMB: +truth.toFixed(2), netDeltaMB: +(netBytes / MB).toFixed(2), wallSec: +wallSec.toFixed(1) })
    )

    // 旧实现会把「续传跳过的 20MB」折进分子，最后一帧仍是真实值的两倍
    expect(reported).toBeLessThan(truth * 1.6)
    expect(reported).toBeGreaterThan(truth * 0.6)
    // 流量统计只算真正上传的字节
    expect(netBytes).toBe(size - 10 * MB)
  }, 180_000)
})
