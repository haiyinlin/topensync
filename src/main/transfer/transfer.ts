import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import type { OpenListClient } from '../openlist/client'
import type { Manifest } from '../db/manifest'
import { hashFile, verifyUnchanged } from '../hash/hashes'
import type { AppConfig } from '@shared/types'

/**
 * 传输执行器（计划书 §8）。
 *
 * 两档路径：
 * - ≤ singlePutMaxBytes（默认 8MB）：单次 PUT /api/fs/put
 * - >  singlePutMaxBytes：multipart 分片，可断点续传
 *
 * 阈值取 8MB 而非 128KB，因为分片的真正价值是**失败重传代价小**：
 * 8MB 重传无所谓，20GB 重传不可接受。
 */

export interface TransferOptions {
  client: OpenListClient
  manifest: Manifest
  config: AppConfig
  onProgress?: (info: {
    fileId: number
    sent: number
    total: number
    chunksDone: number
    chunksTotal: number
    speed: number
  }) => void
}

export interface TransferResult {
  ok: boolean
  error?: string
  /** 是否命中服务端秒传（远端已存在同样内容） */
  rapidUpload?: boolean
}

export class Transfer {
  constructor(private readonly opts: TransferOptions) {}

  /**
   * 上传一个文件。调用方需已确保该文件需要上传
   * （L1 去重命中时不要走这里）。
   */
  async upload(fileId: number, localPath: string, remotePath: string): Promise<TransferResult> {
    const { manifest, config } = this.opts

    const st = await stat(localPath)
    const mtimeMs = st.mtimeMs
    const size = st.size

    // 双哈希（夸克秒传的硬性要求）
    const hashes = await hashFile(localPath)

    // 竞态复核：哈希期间文件可能已被改写
    const unchanged = await verifyUnchanged(localPath, { size: st.size, mtimeMs })
    if (!unchanged) {
      manifest.setState(localPath, 'stale', { errorMsg: '哈希期间文件已变更' })
      return { ok: false, error: '哈希期间文件已变更，需重新计算' }
    }

    manifest.setState(localPath, 'hashed', { md5: hashes.md5, sha1: hashes.sha1 })

    const useMultipart = size > config.singlePutMaxBytes
    return useMultipart
      ? this.uploadMultipart(fileId, localPath, remotePath, hashes.md5, hashes.sha1, size, mtimeMs)
      : this.uploadSingle(fileId, localPath, remotePath, hashes.md5, hashes.sha1, size, mtimeMs)
  }

  /** 小/中文件：单次流式 PUT（计划书 §8.2） */
  private async uploadSingle(
    fileId: number,
    localPath: string,
    remotePath: string,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<TransferResult> {
    const { client, manifest } = this.opts
    manifest.setState(localPath, 'uploading')

    try {
      const stream = createReadStream(localPath)
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>

      await client.putFile(remotePath, body, {
        size,
        md5,
        sha1,
        lastModifiedMs: Math.floor(mtimeMs)
      })

      manifest.setState(localPath, 'synced', { remoteSize: size })
      this.opts.onProgress?.({
        fileId,
        sent: size,
        total: size,
        chunksDone: 1,
        chunksTotal: 1,
        speed: 0
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.setState(localPath, 'error', { errorMsg: message })
      manifest.log('error', `上传失败：${localPath}（${message}）`, fileId, remotePath)
      return { ok: false, error: message }
    }
  }

  /** 大文件：分片上传（计划书 §8.3） */
  private async uploadMultipart(
    fileId: number,
    localPath: string,
    remotePath: string,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<TransferResult> {
    const { client, manifest } = this.opts
    manifest.setState(localPath, 'uploading')

    try {
      const init = await client.multipartInit(remotePath, {
        size,
        md5,
        sha1,
        lastModifiedMs: Math.floor(mtimeMs),
        chunkSize: undefined // 用服务端默认值（默认 10MB）
      })

      const uploadId = init.upload_id

      // 断点续传：查询已收分片，只补缺失的
      const status = await client.multipartStatus(uploadId).catch(() => ({ parts: [] as number[] }))
      const received = new Set(status.parts ?? [])

      const chunkSize = 10 * 1024 * 1024 // 与服务端默认一致
      const total = Math.ceil(size / chunkSize)
      const startedAt = Date.now()
      let sent = 0

      for (let i = 0; i < total; i++) {
        if (received.has(i)) {
          sent += chunkSize
          continue
        }

        const offset = i * chunkSize
        const length = Math.min(chunkSize, size - offset)

        await this.sendChunkWithRetry(uploadId, i, localPath, offset, length)

        sent += length
        const elapsed = (Date.now() - startedAt) / 1000
        this.opts.onProgress?.({
          fileId,
          sent,
          total: size,
          chunksDone: i + 1,
          chunksTotal: total,
          speed: elapsed > 0 ? sent / elapsed : 0
        })
      }

      await client.multipartComplete(uploadId)

      manifest.setState(localPath, 'synced', { remoteSize: size })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.setState(localPath, 'error', { errorMsg: message })
      manifest.log('error', `分片上传失败：${localPath}（${message}）`, fileId, remotePath)
      return { ok: false, error: message }
    }
  }

  /**
   * 发送单个分片，处理服务端的两类特殊状态码：
   * - 429：接收窗口已满 → 退避后重试（不计入失败次数上限）
   * - 409：同一分片正在传输中 → 等待后用 status 确认
   */
  private async sendChunkWithRetry(
    uploadId: string,
    index: number,
    localPath: string,
    offset: number,
    length: number
  ): Promise<void> {
    const { client, config } = this.opts
    const maxAttempts = config.retry.maxAttempts

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const stream = createReadStream(localPath, { start: offset, end: offset + length - 1 })
        const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
        await client.multipartChunk(uploadId, index, body)
        return
      } catch (err) {
        const status = (err as { status?: number }).status

        if (status === 429) {
          // 窗口满：退避后重试，不计入失败上限
          await sleep(backoff(config.retry.baseDelayMs, attempt))
          continue
        }
        if (status === 409) {
          // 同片在途：等待后确认
          await sleep(backoff(config.retry.baseDelayMs, attempt))
          const st = await client.multipartStatus(uploadId).catch(() => ({ parts: [] as number[] }))
          if ((st.parts ?? []).includes(index)) return
          continue
        }

        // 其他错误：可重试则重试
        if (attempt < maxAttempts - 1) {
          await sleep(backoff(config.retry.baseDelayMs, attempt))
          continue
        }
        throw err
      }
    }
    throw new Error(`分片 ${index} 重试耗尽`)
  }
}

function backoff(base: number, attempt: number): number {
  // 指数退避 + 抖动，避免多客户端同步重试撞在一起
  const exp = base * 2 ** attempt
  return exp + Math.random() * base
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
