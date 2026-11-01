import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import type { OpenListClient } from '../openlist/client'
import type { Manifest } from '../db/manifest'
import { hashFile, verifyUnchanged, type FileHashes } from '../hash/hashes'
import type { AppConfig } from '@shared/types'

/**
 * 传输执行器。
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
    /** 相对同步根的路径，用于把进度对应回 UI 上的任务 */
    relPath: string
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
  /**
   * 是否值得重试。
   *
   * 缺省视为可重试（网络抖动、限流等）。确定性失败（文件超限）置 false，
   * 让上层直接标记失败，不再消耗重试次数。
   */
  retryable?: boolean
}

export interface UploadRequest {
  fileId: number
  /** 清单键：相对同步根的路径。清单的状态更新都用它。 */
  relPath: string
  /** 实际读盘路径（绝对路径，可能带 \\?\ 长路径前缀） */
  absPath: string
  /** 远端路径 */
  remotePath: string
  /** 预计算的双哈希；有则跳过重复读盘 */
  hashes?: FileHashes
}

export class Transfer {
  constructor(private readonly opts: TransferOptions) {}

  /**
   * 上传一个文件。调用方需已确保该文件需要上传
   * （L1 去重命中时不要走这里）。
   */
  async upload(req: UploadRequest): Promise<TransferResult> {
    const { manifest, config } = this.opts

    const st = await stat(req.absPath)
    const mtimeMs = st.mtimeMs
    const size = st.size

    // 超限拦截（兜底）：夸克单文件上限可配，超限文件上传必然失败。
    // 正常路径上 Planner 已在入队前拦下，这里防的是其他调用方绕过 Planner。
    const limit = config.quarkMaxFileBytes
    if (limit > 0 && size > limit) {
      const message = `文件大小 ${size} 字节超过单文件上限 ${limit} 字节`
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      manifest.log('error', `跳过超限文件：${req.relPath}（${message}）`, req.fileId, req.remotePath)
      return { ok: false, error: message, retryable: false }
    }

    // 双哈希（夸克秒传的硬性要求）。Planner 阶段已算过就复用，不重复读盘。
    const hashes = req.hashes ?? (await hashFile(req.absPath))

    // 竞态复核：哈希期间文件可能已被改写
    const unchanged = await verifyUnchanged(req.absPath, { size: st.size, mtimeMs })
    if (!unchanged) {
      manifest.setState(req.relPath, 'stale', { errorMsg: '哈希期间文件已变更' })
      return { ok: false, error: '哈希期间文件已变更，需重新计算' }
    }

    manifest.setState(req.relPath, 'hashed', { md5: hashes.md5, sha1: hashes.sha1 })

    const useMultipart = size > config.singlePutMaxBytes
    return useMultipart
      ? this.uploadMultipart(req, hashes.md5, hashes.sha1, size, mtimeMs)
      : this.uploadSingle(req, hashes.md5, hashes.sha1, size, mtimeMs)
  }

  /** 小/中文件：单次流式 PUT */
  private async uploadSingle(
    req: UploadRequest,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<TransferResult> {
    const { client, manifest } = this.opts
    manifest.setState(req.relPath, 'uploading')

    try {
      const stream = createReadStream(req.absPath)
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>

      await client.putFile(req.remotePath, body, {
        size,
        md5,
        sha1,
        lastModifiedMs: Math.floor(mtimeMs)
      })

      // syncedSize / syncedMtimeMs 是 L1 去重的基准，必须写实际传输的那组值。
      // mtime 存原始浮点值，不取整——取整会让后续比较对不上，去重永远不命中。
      manifest.setState(req.relPath, 'synced', {
        remoteSize: size,
        syncedSize: size,
        syncedMtimeMs: mtimeMs
      })
      this.opts.onProgress?.({
        fileId: req.fileId,
        relPath: req.relPath,
        sent: size,
        total: size,
        chunksDone: 1,
        chunksTotal: 1,
        speed: 0
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      manifest.log('error', `上传失败：${req.relPath}（${message}）`, req.fileId, req.remotePath)
      return { ok: false, error: message }
    }
  }

  /** 大文件：分片上传 */
  private async uploadMultipart(
    req: UploadRequest,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<TransferResult> {
    const { client, manifest } = this.opts
    manifest.setState(req.relPath, 'uploading')

    try {
      const init = await client.multipartInit(req.remotePath, {
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

        await this.sendChunkWithRetry(uploadId, i, req.absPath, offset, length)

        sent += length
        const elapsed = (Date.now() - startedAt) / 1000
        this.opts.onProgress?.({
          fileId: req.fileId,
          relPath: req.relPath,
          sent,
          total: size,
          chunksDone: i + 1,
          chunksTotal: total,
          speed: elapsed > 0 ? sent / elapsed : 0
        })
      }

      await client.multipartComplete(uploadId)

      manifest.setState(req.relPath, 'synced', {
        remoteSize: size,
        syncedSize: size,
        syncedMtimeMs: mtimeMs
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      manifest.log('error', `分片上传失败：${req.relPath}（${message}）`, req.fileId, req.remotePath)
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
