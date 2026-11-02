import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import type { OpenListClient } from '../openlist/client'
import { describeError, isSameNameDownloading } from '../openlist/client'
import type { Manifest } from '../db/manifest'
import { hashFile, verifyUnchanged, type FileHashes } from '../hash/hashes'
import { verifyRemote } from '../verify/verifier'
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
  /**
   * 取当前配置。
   *
   * 首选这个：**必须是函数**而不是配置对象。配置可以在运行时改
   * （用户在 UI 里调单文件上限、改校验模式、改重试次数）。
   *
   * 以前这里存的是构造那一刻的对象引用，而 `normalizeConfig()`
   * 每次都返回**新对象**——于是旧引用永远停在旧值：
   * 用户把「单文件上限」调大，Planner 放行了，Transfer 仍按旧上限
   * 报「超过单文件上限」；校验模式改成 hash，实际仍按 size 跑。
   * Planner 用新值、Transfer 用旧值，两边对同一件事给出相反判断。
   */
  getConfig?: () => AppConfig
  /**
   * 配置快照（兼容旧调用方）。
   *
   * 只在 `getConfig` 缺席时使用——那意味着配置在运行期不会变，
   * 用快照没有正确性问题。
   */
  config?: AppConfig
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
  /** 校验结论；未执行校验时为 undefined */
  verify?: {
    ok: boolean
    detail?: string
  }
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
  /**
   * 取消检查。
   *
   * 用户点「取消」时，Planner 会把对应队列项标记为 canceled。
   * Transfer 在写任何**终态**（synced / error）之前都要问一句：
   * 已经被取消了就别再改清单——否则会出现
   * 「取消 → Planner 写 local_only → Transfer 事后写 synced」的乱序，
   * 结果是文件其实传完了、状态却显示成没传。
   */
  isCanceled?: () => boolean
}

export class Transfer {
  constructor(private readonly opts: TransferOptions) {}

  /**
   * 上传一个文件。调用方需已确保该文件需要上传
   * （L1 去重命中时不要走这里）。
   */
  /**
   * 取当前配置。
   *
   * 优先用 `getConfig`（实时读）；没有它就退回 `config` 快照
   * ——那说明调用方明确表示配置在运行期不会变。
   */
  private currentConfig(): AppConfig {
    if (this.opts.getConfig) return this.opts.getConfig()
    if (this.opts.config) return this.opts.config
    throw new Error('Transfer 缺少配置来源（getConfig 或 config）')
  }

  async upload(req: UploadRequest): Promise<TransferResult> {
    const { manifest } = this.opts
    // 每次都取当前配置，不吃构造时的快照（见 TransferOptions.getConfig 的说明）
    const config = this.currentConfig()

    // 一进来就问一次：排队期间可能已被取消
    if (req.isCanceled?.()) {
      return { ok: false, error: '已取消', retryable: false }
    }

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

    // 哈希可能耗时较久，期间用户可能点了取消
    if (req.isCanceled?.()) {
      return { ok: false, error: '已取消', retryable: false }
    }

    // 竞态复核：哈希期间文件可能已被改写
    const unchanged = await verifyUnchanged(req.absPath, { size: st.size, mtimeMs })
    if (!unchanged) {
      manifest.setState(req.relPath, 'stale', { errorMsg: '哈希期间文件已变更' })
      return { ok: false, error: '哈希期间文件已变更，需重新计算' }
    }

    manifest.setState(req.relPath, 'hashed', { md5: hashes.md5, sha1: hashes.sha1 })

    // 路径选择：大文件优先走分片（失败重传代价小）。
    // 但**不是所有 OpenList 构建都有 /multipart 路由**——实测部分实例会把该请求
    // 落到前端 SPA 的 index.html 上，看起来 HTTP 200 实则没有这个路由。
    // 这类服务端退化为单次 PUT（实测 12MB 单次 PUT 可正常落地）。
    const wantMultipart = size > config.singlePutMaxBytes
    const multipartOk = wantMultipart && (await this.opts.client.probeMultipart())
    if (wantMultipart && !multipartOk) {
      manifest.log(
        'warn',
        `服务端不支持 multipart 分片上传，${req.relPath} 改用单次 PUT 上传`,
        req.fileId,
        req.remotePath
      )
    }

    const result = multipartOk
      ? await this.uploadMultipart(req, hashes.md5, hashes.sha1, size, mtimeMs)
      : await this.uploadSingle(req, hashes.md5, hashes.sha1, size, mtimeMs)

    if (!result.ok) return result

    // ── 远端一致性校验 ──
    // 「上传成功」不等于「远端内容正确」。校验不通过时不能写 synced 基准，
    // 否则下一轮扫描会因 L1 命中而永久跳过这个坏文件。
    const verdict = await verifyRemote({
      client: this.opts.client,
      remotePath: req.remotePath,
      expectedSize: size,
      expectedMd5: hashes.md5,
      expectedSha1: hashes.sha1,
      mode: config.verifyMode,
      verifyHashMaxBytes: config.verifyHashMaxBytes
    })

    if (!verdict.ok) {
      const message = `远端校验未通过：${verdict.detail ?? '内容与本地不一致'}`
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      manifest.log('error', `校验失败：${req.relPath}（${message}）`, req.fileId, req.remotePath)
      return { ok: false, error: message, retryable: true, verify: { ok: false, detail: verdict.detail } }
    }

    // syncedSize / syncedMtimeMs 是 L1 去重的基准，必须写实际传输的那组值。
    // mtime 存原始浮点值，不取整——取整会让后续比较对不上，去重永远不命中。
    //
    // syncedMd5 / syncedSha1 记的是「**远端那份内容**的哈希」——
    // 只有确认远端已存好之后才能写。服务端不给任何秒传信号，
    // 客户端要靠这两个字段自行判定「远端重复」。
    //
    // 被取消时不写终态：让 Planner 决定最终状态（它知道用户点了取消）。
    if (req.isCanceled?.()) {
      return { ok: false, error: '已取消', retryable: false }
    }
    manifest.setState(req.relPath, 'synced', {
      remoteSize: size,
      syncedSize: size,
      syncedMtimeMs: mtimeMs,
      syncedMd5: hashes.md5,
      syncedSha1: hashes.sha1
    })
    manifest.markVerified(req.relPath)

    if (verdict.detail) {
      manifest.log('warn', `校验说明：${req.relPath}（${verdict.detail}）`, req.fileId, req.remotePath)
    }

    return { ok: true, verify: { ok: true, detail: verdict.detail } }
  }

  /** 小/中文件：单次流式 PUT */
  private async uploadSingle(
    req: UploadRequest,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<TransferResult> {
    const { manifest } = this.opts
    manifest.setState(req.relPath, 'uploading')

    try {
      await this.putWithRecovery(req, md5, sha1, size, mtimeMs)

      // synced 状态由 upload() 在校验通过后统一写入
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
      const message = describeError(err)
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      manifest.log('error', `上传失败：${req.relPath}（${message}）`, req.fileId, req.remotePath)
      return { ok: false, error: message }
    }
  }

  /**
   * 上传，并在「远端同名文件正在下载」时自愈一次。
   *
   * OpenList 在远端同名文件正被下载时会拒绝覆盖，PUT 报
   * `file is doloading[存在同名文件]`。重试多少次都没用——
   * 只要那个同名文件还在被下载，每次都是同一个错。
   *
   * 自愈办法：把远端那个同名文件删掉，再重传。
   * 远端那份要么是旧的（本地更新，要覆盖），要么是重复的（删了重传即可），
   * 两种情况删掉都不亏。
   */
  private async putWithRecovery(
    req: UploadRequest,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<void> {
    const { client, manifest } = this.opts
    try {
      await this.putOnce(req, md5, sha1, size, mtimeMs)
    } catch (err) {
      if (!isSameNameDownloading(err)) throw err

      manifest.log(
        'warn',
        `远端同名文件正在下载，删除后重传：${req.remotePath}`,
        req.fileId,
        req.remotePath
      )

      // 删掉远端那份同名文件（remove 接受完整路径，内部会拆成目录+文件名）
      try {
        await client.remove([req.remotePath])
      } catch (err) {
        // 删不掉就算了：下面重传若还是撞同一个错，会照常报失败
        manifest.log(
          'warn',
          `删除远端同名文件失败，仍尝试重传：${req.remotePath}（${describeError(err)}）`,
          req.fileId,
          req.remotePath
        )
      }

      // 等它真的消失再重传，否则还是撞上同一个错
      await client.waitForGone(req.remotePath, 10_000)

      await this.putOnce(req, md5, sha1, size, mtimeMs)
    }
  }

  /** 单次 PUT */
  private async putOnce(
    req: UploadRequest,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<void> {
    const stream = createReadStream(req.absPath)
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
    await this.opts.client.putFile(req.remotePath, body, {
      size,
      md5,
      sha1,
      lastModifiedMs: Math.floor(mtimeMs)
    })
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
      const init = await this.multipartInitWithRecovery(req, md5, sha1, size, mtimeMs)

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

      // synced 状态由 upload() 在校验通过后统一写入
      return { ok: true }
    } catch (err) {
      const message = describeError(err)
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      manifest.log('error', `分片上传失败：${req.relPath}（${message}）`, req.fileId, req.remotePath)
      return { ok: false, error: message }
    }
  }

  /**
   * 分片上传初始化，同样带「同名下载中」自愈。
   *
   * 与 putWithRecovery 是同一套逻辑：远端同名文件正被下载时
   * OpenList 会拒绝创建新任务，先删掉那份再重试。
   */
  private async multipartInitWithRecovery(
    req: UploadRequest,
    md5: string,
    sha1: string,
    size: number,
    mtimeMs: number
  ): Promise<{ upload_id: string }> {
    const { client, manifest } = this.opts
    const initArgs = {
      size,
      md5,
      sha1,
      lastModifiedMs: Math.floor(mtimeMs),
      chunkSize: undefined // 用服务端默认值（默认 10MB）
    }
    try {
      return await client.multipartInit(req.remotePath, initArgs)
    } catch (err) {
      if (!isSameNameDownloading(err)) throw err

      manifest.log(
        'warn',
        `远端同名文件正在下载，删除后重传：${req.remotePath}`,
        req.fileId,
        req.remotePath
      )
      try {
        await client.remove([req.remotePath])
      } catch (removeErr) {
        manifest.log(
          'warn',
          `删除远端同名文件失败，仍尝试重传：${req.remotePath}（${describeError(removeErr)}）`,
          req.fileId,
          req.remotePath
        )
      }
      await client.waitForGone(req.remotePath, 10_000)
      return client.multipartInit(req.remotePath, initArgs)
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
    const { client } = this.opts
    const config = this.currentConfig()
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
