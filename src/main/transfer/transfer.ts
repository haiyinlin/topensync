import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import type { OpenListClient } from '../openlist/client'
import { describeError, isSameNameDownloading } from '../openlist/client'
import type { Manifest } from '../db/manifest'
import { hashFile, verifyUnchanged, type FileHashes } from '../hash/hashes'
import { ioGovernor } from '../io/governor'
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

/**
 * 进度上报的最小间隔（毫秒）。
 *
 * 单次 PUT 的流式进度是按块回调的（64KB 一块），1GB 文件就是一万六千次。
 * 每次都推一次任务更新没有意义——渲染层根本来不及画，中间那些会被
 * 下一批覆盖掉。120ms 一次，视觉上仍然是连续滚动的。
 */
const PROGRESS_EMIT_MS = 120

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
    /**
     * 本次新增的字节数（增量）。
     *
     * `sent` 是累计值，想统计「总体速率」需要增量——
     * 否则每个并发任务都会把总量重复累加一遍，速率直接虚高。
     */
    delta: number
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
   * 入队时观测到的文件修改时间（毫秒）。
   *
   * 用来判断「哈希之后、上传之前文件是不是被改过」。
   * 不传（或传 0）就只做大小校验——重试路径拿不到可靠值。
   */
  mtimeMs?: number
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
  /**
   * 「服务端没有 /multipart 路由」这件事只值得说一次。
   *
   * 以前每个大文件都写一条 warn，08:07 那一分钟里连刷十几条——
   * 用户看到满屏「不支持 multipart」会以为出错了，其实只是这个
   * OpenList 构建没实现该路由，功能上已自动退化为单次 PUT。
   */
  private multipartDowngradeLogged = false

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
      manifest.log('error', `跳过超限文件：${req.relPath}（${message}）`, req.fileId, req.remotePath, {
        category: 'upload',
        filePath: req.relPath
      })
      return { ok: false, error: message, retryable: false }
    }

    // 双哈希（夸克秒传的硬性要求）。Planner 阶段已算过就复用，不重复读盘。
    const hashes = req.hashes ?? (await hashFile(req.absPath))

    // 哈希可能耗时较久，期间用户可能点了取消
    if (req.isCanceled?.()) {
      return { ok: false, error: '已取消', retryable: false }
    }

    /*
     * 竞态复核：拿「哈希那一刻的字节数」跟现在要发的比。
     *
     * 以前这里传的是**刚取的** `st.size` —— 等于自己跟自己比，
     * 恒为真，形同虚设。真正的风险窗口是「哈希阶段 → 上传阶段」：
     * 这中间文件被改写的话，我们会带着旧 MD5/SHA1 发新内容。
     * 夸克驱动的秒传判据就是 MD5+SHA1，服务端会直接链到**旧 blob**，
     * 远端留下旧内容；而默认校验只比大小，一样大就通过 →
     * `setState('synced')` 写上旧哈希 → 下一轮 L1 命中 → 永远不再传。
     *
     * 判据：
     * - `hashes.size` 是哈希时**真正读到的**字节数，与现在的 size 不等
     *   就说明内容换了（最可靠的一条）；
     * - `mtimeMs` 兜同尺寸改写。入队时可能传 0（重试路径），不能用它判。
     */
    const hashedSize = hashes.size
    const drifted =
      (hashedSize > 0 && st.size !== hashedSize) ||
      ((req.mtimeMs ?? 0) > 0 && Math.abs(st.mtimeMs - (req.mtimeMs ?? 0)) > 1)
    const unchanged = drifted ? false : await verifyUnchanged(req.absPath, { size: st.size, mtimeMs })
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
    if (wantMultipart && !multipartOk && !this.multipartDowngradeLogged) {
      this.multipartDowngradeLogged = true
      manifest.log(
        'warn',
        `服务端没有分片上传路由（/multipart），所有大于 ${Math.round(
          config.singlePutMaxBytes / 1024 / 1024
        )}MB 的文件都改用单次 PUT，中断后需要从头重传。本条只提示一次。`,
        req.fileId,
        req.remotePath,
        { category: 'system', filePath: req.relPath }
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
      manifest.log('error', `校验失败：${req.relPath}（${message}）`, req.fileId, req.remotePath, {
        category: 'upload',
        filePath: req.relPath
      })
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
      manifest.log('warn', `校验说明：${req.relPath}（${verdict.detail}）`, req.fileId, req.remotePath, {
        category: 'upload',
        filePath: req.relPath
      })
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

    const startedAt = Date.now()
    try {
      await this.putWithRecovery(req, md5, sha1, size, mtimeMs)
      const elapsedMs = Date.now() - startedAt

      /*
       * 单次 PUT 的速率。
       *
       * 以前这里写死 0，于是**所有小文件的速度都是 0**——
       * 而小文件恰恰是绝大多数。界面上「速度 0 B/s」看着像卡住了。
       *
       * 用「整个 PUT 的耗时」算：包含建连与服务端处理，
       * 小文件会低估（几 KB 除以几十毫秒没有参考价值），
       * 但大文件足够准。而总体速率另有窗口统计兜底（见 Engine.recordSpeed）。
       */
      const speed = elapsedMs > 0 ? Math.round((size * 1000) / elapsedMs) : 0

      // synced 状态由 upload() 在校验通过后统一写入
      //
      // 注意 delta: 0：字节增量已经由 putFile 的流式 onProgress 实时上报了，
      // 这里再报一次 delta: size 会把整份文件重复计入总体速率（totalBytes 翻倍、
      // 速率虚高）。收尾只补一个完成态（sent=size），不再计流量。
      this.opts.onProgress?.({
        fileId: req.fileId,
        relPath: req.relPath,
        sent: size,
        total: size,
        delta: 0,
        chunksDone: 1,
        chunksTotal: 1,
        speed
      })
      return { ok: true }
    } catch (err) {
      const message = describeError(err)
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      /*
       * 这里**不写日志**。
       *
       * Planner.handleUploadResult 拿到 !ok 之后会写一条带 category 的
       * error 日志；从前这里再写一条（`manifest.log` 不带 category，
       * 于是落成 system），同一次失败在日志页出现两遍、类别还各是
       * 一个——用户翻了 200 条以为有 200 个问题，其实只有 100 个。
       * 错误原因的持久化交给 errorMsg，展示交给 Planner 那一条。
       */
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
        req.remotePath,
        { category: 'upload', filePath: req.relPath }
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
          req.remotePath,
          { category: 'upload', filePath: req.relPath }
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
    /*
     * 读流必须与请求同生共死。
     *
     * 这里以前没有 finally：`client.putFile` 抛出时（网络断开、HTTP 500、
     * 服务端拒绝），读流还开着，没人 destroy 它。失败一次漏一个句柄，
     * 而失败恰恰是常态——真实用户的一次扫描里 556 个文件失败，
     * 句柄漏光之后连 `stat` 都开始报 EMFILE，
     * 整块 Z: 盘被拖到需要重启才能恢复。
     *
     * fetch 失败时 undici 不保证会把 body 读完或销毁，
     * 所以释放的责任在创建流的一方，不能指望下游。
     */
    await ioGovernor.run(async () => {
      const stream = createReadStream(req.absPath)
      /*
       * 兜住 open 阶段的异步错误（文件在上传前被删、盘掉线等）。
       *
       * createReadStream 的 open 是惰性的：直接传流给 undici 时，open 被
       * 推迟到真正消费才发生。如果文件那时已经没了，open 的 ENOENT 会以
       * unhandled 'error' 事件冒出来（没有监听器会崩主进程）。这里挂一个
       * no-op 监听器把错误收住，真正的失败由 putFile 的 fetch 抛错来报告。
       */
      stream.on('error', () => {})
      try {
        /*
         * 直接传 Node 流，**不转 Readable.toWeb**。
         *
         * 单次 PUT 的大文件（服务端不支持分片时）走这里。以前把 Node 流
         * 转成 Web ReadableStream 再喂给 fetch，undici 内部会缓冲 body
         * （chunk 缓冲 + Buffer/ArrayBuffer 拷贝），external 内存涨到约
         * 3.5 倍文件大小——1GB 的 mkv 直接吃掉 3GB+（实测内存 5GB 的根因）。
         * 直接传 Node 原生流，undici 走 async iterable 路径，背压正确、
         * 零缓冲，内存只留一个 64KB chunk。
         *
         * 字节计数在 putFile 里用 `data` 事件做（不进流转换层），
         * 这里的 onProgress 只是把累计字节换算成速率喂给上层。
         */
        const startedAt = Date.now()
        /*
         * 速率的算法：**滑动窗口的瞬时速率**，不是「累计字节 ÷ 总耗时」。
         *
         * 以前用后者，界面上显示的其实是「从开始到现在的平均速率」：
         * 传一个大文件时它会被前面的慢速（握手、首包）拖住，越传越"爬"，
         * 而用户此刻想知道的正是「现在有多快」。尤其在
         * 开始几十秒内数字明显偏低，看起来就像速率算错了。
         *
         * 现在每次上报都用「距上次上报的字节增量 ÷ 这段时长」，
         * 再做指数平滑（0.6/0.4）滤掉单块抖动。
         */
        let lastEmitAt = startedAt
        let lastEmitSent = 0
        let prevSent = 0
        let smooth = 0
        let pendingDelta = 0
        /** 第一次回调立刻上报：进度条要马上动起来，不能等 120ms */
        let firstEmit = true
        await this.opts.client.putFile(req.remotePath, stream, {
          size,
          md5,
          sha1,
          lastModifiedMs: Math.floor(mtimeMs),
          onProgress: (sent) => {
            const now = Date.now()
            pendingDelta += sent - prevSent
            prevSent = sent

            /*
             * 节流到 120ms 一次（第一次例外）。
             *
             * 64KB 一块的话，1GB 文件会产生一万六千次回调；每次都推一次
             * 任务更新纯属浪费（任务批处理窗口才 80ms，中间那些全被覆盖）。
             * 但**第一次和最后一块必须上报**：前者让进度条立刻动起来，
             * 后者避免进度停在 99%。
             */
            const elapsed = now - lastEmitAt
            if (!firstEmit && elapsed < PROGRESS_EMIT_MS && sent < size) return

            /*
             * 分母兜底 100ms。
             *
             * 第一次回调可能在开传后几毫秒就来了（64KB 从页缓存读出来），
             * 那时 64KB / 3ms 会算出 20 MB/s 的假速度，再经平滑要一秒多
             * 才回落——刚点开始同步的头两秒，每行都顶着一个离谱的数字。
             */
            const instant =
              elapsed > 0 ? (sent - lastEmitSent) / Math.max(0.1, elapsed / 1000) : 0
            smooth = smooth > 0 ? smooth * 0.6 + instant * 0.4 : instant
            this.opts.onProgress?.({
              fileId: req.fileId,
              relPath: req.relPath,
              sent,
              total: size,
              delta: pendingDelta,
              chunksDone: 0,
              chunksTotal: 0,
              speed: smooth
            })
            pendingDelta = 0
            lastEmitAt = now
            lastEmitSent = sent
            firstEmit = false
          }
        })
      } finally {
        if (!stream.destroyed) stream.destroy()
      }
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

      /*
       * 速率必须按**这一次真正上传的字节**算，不能让续传的进度顶上来。
       *
       * 以前这里是 `sent / (now - startedAt)`：`sent` 里包含了「服务端已有、
       * 直接跳过」的分片。一个断点续传的 6.5GB 文件，若前 4GB 已经传过，
       * 循环开头几毫秒就把 sent 加到 4GB——速率瞬间变成几百 MB/s，
       * 之后一路按「4GB ÷ 已耗时」缓慢回落，几百秒后仍显示十几 MB/s。
       * 结果就是列表里四行加起来 54 MB/s，顶栏总共只有 20 MB/s。
       *
       * 改成与单次 PUT 同一套：以上一次上报为基准算增量速率，
       * 跳过续传分片时把基准一起上移（那批字节没有产生流量）。
       */
      let lastEmitAt = startedAt
      let lastEmitSent = 0
      let smooth = 0

      for (let i = 0; i < total; i++) {
        const offset = i * chunkSize
        const length = Math.min(chunkSize, size - offset)

        if (received.has(i)) {
          sent += length
          // 续传：不计流量，采样基准跟着走，否则「0 秒传了 4GB」
          lastEmitSent = sent
          lastEmitAt = Date.now()
          continue
        }

        await this.sendChunkWithRetry(uploadId, i, req.absPath, offset, length)

        sent += length
        const now = Date.now()
        const elapsed = now - lastEmitAt
        const instant = elapsed > 0 ? (sent - lastEmitSent) / (elapsed / 1000) : 0
        smooth = smooth > 0 ? smooth * 0.6 + instant * 0.4 : instant
        this.opts.onProgress?.({
          fileId: req.fileId,
          relPath: req.relPath,
          sent,
          total: size,
          delta: length,
          chunksDone: i + 1,
          chunksTotal: total,
          speed: smooth
        })
        lastEmitAt = now
        lastEmitSent = sent
      }

      await client.multipartComplete(uploadId)

      // synced 状态由 upload() 在校验通过后统一写入
      return { ok: true }
    } catch (err) {
      const message = describeError(err)
      manifest.setState(req.relPath, 'error', { errorMsg: message })
      // 同上：日志由 Planner 统一写一条，这里不重复
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
        req.remotePath,
        { category: 'upload', filePath: req.relPath }
      )
      try {
        await client.remove([req.remotePath])
      } catch (removeErr) {
        manifest.log(
          'warn',
          `删除远端同名文件失败，仍尝试重传：${req.remotePath}（${describeError(removeErr)}）`,
          req.fileId,
          req.remotePath,
          { category: 'upload', filePath: req.relPath }
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
        /*
         * 每次尝试都新建读流，且必须保证这一次失败/取消时它被销毁。
         * 分片上传的重试次数是「分片数 × 重试上限」量级，
         * 漏一个就是漏几百个句柄。
         */
        await ioGovernor.run(async () => {
          const stream = createReadStream(localPath, { start: offset, end: offset + length - 1 })
          try {
            const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
            await client.multipartChunk(uploadId, index, body)
          } finally {
            if (!stream.destroyed) stream.destroy()
          }
        })
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
