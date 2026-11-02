import { randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { mkdir, rm, stat } from 'fs/promises'
import { dirname } from 'path'
import type { Manifest } from '../db/manifest'
import type { Transfer } from '../transfer/transfer'
import type { FileHashes } from '../hash/hashes'
import { hashFile } from '../hash/hashes'
import type { OpenListClient } from '../openlist/client'
import { absolutize, isExcluded, joinRemote, remoteBasename, remoteDirname, relativizeRemote } from '../watcher/paths'
import { RenameDetector, type RenameCandidate } from './rename'
import type {
  AppConfig,
  DiffKind,
  LogCategory,
  TransferTask
} from '@shared/types'

/**
 * Planner——两条扫描通道的汇合点。
 *
 * 本地变更（Watcher）和远端差异（Reconciler）最终都从这里走**同一条**
 * 上传路径，不写第二套上传逻辑。
 *
 * 流水线分两级，各自独立限流：
 *
 *   事件 → [L1 快筛] → 哈希池(hashConcurrency) → 上传池(uploadConcurrency) → 完成
 *            ↑
 *      size+mtime 与上次成功同步一致 → 直接跳过，零上行
 *
 * L1 快筛是省用户上行的**主力**。
 * 服务端秒传（L2）只作用于 OpenList→夸克那一段，不是这里的重点。
 */

export type EnqueueReason = 'watch' | 'diff' | 'recovery' | 'retry'

export interface PlannerOptions {
  manifest: Manifest
  transfer: Transfer
  /** 远端客户端（建目录、删除、回收站移动） */
  client: OpenListClient
  /** 读当前配置（配置可在运行时改，故用函数而非快照） */
  getConfig: () => AppConfig
  onTask?: (task: TransferTask) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * 带结构化信息的日志回调。
   *
   * 与 onLog 分开：绝大多数日志没有文件信息，走 onLog 就行；
   * 涉及具体文件的日志（上传/下载/跳过）用这个，
   * 才能在日志页按类别筛选、按文件查历史。
   */
  onLogDetail?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    meta: { category: LogCategory; filePath?: string | null; remotePath?: string | null }
  ) => void
  /** L1 命中计数变化 */
  onSkip?: (count: number) => void
  /**
   * 跳过计数变化（区分原因）。
   *
   * 分开报是因为「本地重复」和「远端重复」对用户是完全不同的两件事：
   * 前者是文件没动，后者是远端已经有同样内容、不必再传。
   */
  onSkipDetail?: (detail: { local: number; remote: number; total: number }) => void
  /** 下载完成计数变化 */
  onDownload?: (count: number) => void
}

interface QueueItem {
  relPath: string
  absPath: string
  size: number
  mtimeMs: number
  reason: EnqueueReason
  attempts: number
  hashes?: FileHashes
  /**
   * 本次入队的身份令牌。
   *
   * 取消靠它实现：用户点「取消」时把令牌置为 canceled，
   * 流水线在每个阶段边界检查 `item.canceled`，
   * 发现被取消就不再往下走，也不会把状态改回 done/failed。
   *
   * 用令牌而不是 `tasks` 表里的状态，是因为**队列里的项和任务表是两份东西**：
   * 任务表是给界面看的快照，队列是真正在跑的数据流。
   * 只改任务表不改队列，任务照样会上传完并把状态覆盖回 done——
   * 这正是「取消按钮点了没反应」的根因。
   */
  canceled?: boolean
}

/**
 * 下载项（远端 → 本地）。
 *
 * 与上传项分开：两者走的客户端接口、限速策略、失败语义都不同，
 * 混在一个队列里会让「下载并发」和「上传并发」互相牵制。
 */
interface DownloadItem {
  relPath: string
  absPath: string
  remotePath: string
  size: number
  attempts: number
  canceled?: boolean
}

interface DeleteItem {
  relPath: string
  remotePath: string
  size: number
}

export class Planner {
  private readonly hashQueue: QueueItem[] = []
  private readonly uploadQueue: QueueItem[] = []
  private readonly downloadQueue: DownloadItem[] = []
  private readonly deleteQueue: DeleteItem[] = []
  /** 任务表：key 是任务 id */
  private readonly tasks = new Map<string, TransferTask>()
  /** 相对路径 → 任务 id */
  private readonly taskIdByPath = new Map<string, string>()
  /** 已在远端创建过的目录，避免每个文件都重复 mkdir */
  private readonly knownRemoteDirs = new Set<string>()
  /**
   * 远端目录列表缓存：远端目录 → 该目录下的文件（名字 → 大小）。
   *
   * 用途：L1.5 认领闸门要回答「远端有没有同名同大小的文件」。
   * 逐个 stat 是 N 次请求；按目录列一次是 1 次请求——
   * 一批文件往往集中在少数几个目录里，命中率很高。
   *
   * 只缓存**文件**（目录不进缓存）：认领只关心同名文件。
   */
  private readonly remoteDirCache = new Map<string, Map<string, number>>()
  /** 正在进行的目录列举：同一目录的并发请求合并成一次 */
  private readonly remoteDirPending = new Map<string, Promise<Map<string, number>>>()
  /**
   * 当前在途任务 → 其队列项。
   *
   * 取消需要拿到「正在跑的那一项」才能把它标记掉：
   * 项已经从队列 shift 出来、正在某个 await 上跑着，
   * 光靠队列数组是找不到它的。
   */
  private readonly inFlight = new Map<string, QueueItem>()
  /** 当前在途的下载项；与上传队列分开，取消逻辑才不会串 */
  private readonly inFlightDownloads = new Map<string, DownloadItem>()
  /** 重命名识别器 */
  private readonly renamer: RenameDetector
  private running = false
  private pumping = false
  private pumpingDownloads = false
  /** 本次运行因「本地内容未变」而跳过的数量 */
  private skippedLocal = 0
  /** 本次运行因「远端已有同样内容」而跳过的数量 */
  private skippedRemote = 0
  /** 本次运行完成下载的文件数 */
  private downloadedCount = 0
  /** 本次会话的删除计数，用于熔断 */
  private deleteCount = 0
  private deleteBytes = 0
  /** 本次对账已自动修复的差异数 */
  private autoFixed = 0
  /** 挂起删除的清理定时器 */
  private removalTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: PlannerOptions) {
    this.renamer = new RenameDetector({
      manifest: opts.manifest,
      windowMs: opts.getConfig().renameWindowMs,
      getInode: async (absPath) => {
        try {
          // bigint 读法：Windows 的 ino 是 64 位文件索引号，
          // 数值普遍超过 2^53，转成普通 number 会丢精度。
          const st = await stat(absPath, { bigint: true })
          // 部分文件系统恒为 0，不可用
          return st.ino > 0n ? st.ino.toString() : null
        } catch {
          return null
        }
      },
      hashFile,
      onLog: opts.onLog
    })
  }

  // ── 生命周期 ──────────────────────────────────────────

  start(): void {
    this.running = true
    void this.pump()
    this.startRemovalTimer()
  }

  stop(): void {
    this.running = false
    this.hashQueue.length = 0
    this.uploadQueue.length = 0
    this.downloadQueue.length = 0
    if (this.removalTimer) {
      clearInterval(this.removalTimer)
      this.removalTimer = null
    }
  }

  /**
   * 定期把挂起期满的删除真正落到远端。
   *
   * 频率取窗口的一半，保证删除延迟不超过一个窗口多一点。
   */
  private startRemovalTimer(): void {
    if (this.removalTimer) clearInterval(this.removalTimer)
    const windowMs = Math.max(1000, this.opts.getConfig().renameWindowMs)
    this.removalTimer = setInterval(() => this.flushExpiredRemovals(), Math.floor(windowMs / 2))
    this.removalTimer.unref?.()
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 本次运行被跳过的总数（本地重复 + 远端重复） */
  get skippedCount(): number {
    return this.skippedLocal + this.skippedRemote
  }

  get skipDetail(): { local: number; remote: number; total: number } {
    return { local: this.skippedLocal, remote: this.skippedRemote, total: this.skippedCount }
  }

  get downloadedTotal(): number {
    return this.downloadedCount
  }

  getTasks(): TransferTask[] {
    return [...this.tasks.values()]
  }

  /**
   * 上传队列是否已排空。
   *
   * 远端对账要用它做前置判断：上传还没跑完时清单里没有对应记录，
   * 对账会把「远端已存在、本地也有、只是还没记进清单」的文件
   * 误判成「仅远端存在」——那是假差异，照着提示操作还会误删远端文件。
   */
  get isIdle(): boolean {
    return (
      this.hashQueue.length === 0 &&
      this.uploadQueue.length === 0 &&
      this.inFlight.size === 0 &&
      this.inFlightDownloads.size === 0
    )
  }

  /** 队列里还有多少项没跑完（含在途） */
  get pendingCount(): number {
    return this.hashQueue.length + this.uploadQueue.length + this.inFlight.size
  }

  /** 按相对路径取任务（进度回调用它把字节数对应回任务） */
  getTaskByPath(relPath: string): TransferTask | null {
    const id = this.taskIdByPath.get(relPath)
    return id ? (this.tasks.get(id) ?? null) : null
  }

  /**
   * 从队列里移除若干任务记录。
   *
   * 语义：**只清界面上的记录，不动文件**。
   * 任务表是给用户看的快照，不是数据源——真正的数据流在
   * hashQueue / uploadQueue / inFlight 里。
   *
   * 所以这里必须先把队列里的对应项摘掉：在途的标记 canceled，
   * 否则「删掉的记录」会自己跑完又冒回界面上。
   *
   * @returns 实际移除的条数
   */
  removeTasks(taskIds: string[]): number {
    let removed = 0
    for (const id of taskIds) {
      const task = this.tasks.get(id)
      if (!task) continue

      // 队列里还没跑的项直接摘掉
      this.dropQueued(task.localPath)
      // 正在跑的：标记取消，它跑完不会再写回状态
      const running = this.inFlight.get(task.localPath)
      if (running) running.canceled = true

      this.tasks.delete(id)
      if (this.taskIdByPath.get(task.localPath) === id) {
        this.taskIdByPath.delete(task.localPath)
      }
      removed++
    }
    return removed
  }

  /**
   * 删除本地文件（并按删除策略处理远端）。
   *
   * 走的是与「用户在资源管理器里删文件」**完全相同**的那条路径：
   * 先真的把本地文件删掉，再由 watcher 的 unlink 事件触发
   * handleRemoval → 远端按 deletePolicy 处理（回收站 / 直接删 / 不动）。
   *
   * 为什么不直接调 handleRemoval：
   * 那样会让清单认为文件已删，但本地文件还在磁盘上——
   * 下一轮扫描又会把它当新文件传一遍。删了又传，比不删更糟。
   *
   * @returns 成功删除的文件数
   */
  async deleteLocalFiles(relPaths: string[]): Promise<number> {
    const config = this.opts.getConfig()
    if (!config.syncRoot) return 0

    let deleted = 0
    for (const relPath of relPaths) {
      const abs = absolutize(config.syncRoot, relPath)
      try {
        /*
         * 先判断存在性再删。
         *
         * rm 的 force:true 会让「删不存在的文件」也返回成功，
         * 于是计数会虚高——用户看到「已删除 2 个」，实际只删了 1 个，
         * 还以为清单里本来就有两个。这会让人对整个删除功能失去信任。
         */
        if (!existsSync(abs)) {
          this.opts.onLog?.('warn', `本地文件不存在，跳过：${relPath}`)
          continue
        }
        await rm(abs, { force: true })
        deleted++
        this.opts.onLog?.('info', `已删除本地文件：${relPath}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.opts.onLog?.('error', `删除本地文件失败 ${relPath}：${message}`)
      }
    }
    return deleted
  }

  /**
   * 删除远端文件（批量），并关闭对应差异。
   *
   * 走回收站而不是直接删：远端删错代价太高（数据不可恢复）。
   *
   * 关键细节：**必须先把回收站的父目录建出来**。
   * OpenList 的 move 要求目标路径的父目录已存在，
   * 不建的话 move 会静默失败（文件还在原地），
   * 而界面上的差异却已经被标记成「已处置」——
   * 用户看到「删掉了」，远端文件却好好躺着。
   *
   * @returns 成功数与失败数
   */
  async deleteRemoteFiles(
    targets: { remotePath: string; diffId?: number }[]
  ): Promise<{ deleted: number; failed: number }> {
    if (targets.length === 0) return { deleted: 0, failed: 0 }

    const config = this.opts.getConfig()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let deleted = 0
    let failed = 0

    for (const target of targets) {
      try {
        if (config.deletePolicy === 'keep') {
          // 不动远端：只把差异标记为已处置
          if (target.diffId !== undefined) {
            this.opts.manifest.resolveDiff(target.diffId, 'ignored')
          }
          deleted++
          continue
        }

        if (config.deletePolicy === 'trash') {
          const rel = relativizeRemote(config.remoteRoot, target.remotePath)
          const dest = joinRemote(
            config.remoteRoot,
            `${config.trashRoot}/${stamp}/${rel || 'root'}`
          )
          // 先建目标父目录，否则 move 会静默失败
          await this.ensureRemoteDirs(dest)
          this.opts.onLog?.('info', `已移入回收站：${target.remotePath} → ${dest}`)
          await this.opts.client.move(target.remotePath, dest)
        } else {
          this.opts.onLog?.('info', `已删除远端文件：${target.remotePath}`)
          await this.opts.client.remove([target.remotePath])
        }

        if (target.diffId !== undefined) {
          this.opts.manifest.resolveDiff(target.diffId, 'deleted_remote')
        }
        deleted++
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        this.opts.onLog?.('error', `删除远端文件失败 ${target.remotePath}：${message}`)
      }
    }

    return { deleted, failed }
  }

  // ── 入口：本地扫描事件 ─────────────────────────────────

  /**
   * 处理一个归一化后的文件事件；exists=false 表示本地已被删除。
   *
   * isDir=true 时走目录分支：只处理空目录同步，
   * 非空目录由其下文件上传时自动创建。
   */
  async handleEvent(relPath: string, exists: boolean, isDir = false): Promise<void> {
    if (!this.running) return
    const config = this.opts.getConfig()
    if (!config.syncRoot) return
    if (isExcluded(relPath, config.exclude)) return

    if (isDir) {
      await this.handleDirEvent(relPath, exists, config)
      return
    }

    if (!exists) {
      this.handleRemoval(relPath, config)
      return
    }

    const absPath = absolutize(config.syncRoot, relPath)

    // ── 重命名识别 ──
    // 先问一句「这个新增路径是不是某个刚消失的路径改名而来」，
    // 是则走远端 move，省掉一次完整上行。
    if (config.detectRenames) {
      const candidate = await this.matchRename(relPath, absPath)
      if (candidate) {
        // 远端 move 成功才算识别成功；失败会退回普通上传流程
        const handled = await this.applyRename(candidate, absPath, config)
        if (handled) return
      }
    }

    // 跳过占位文件与占用中的文件：读它们会触发云盘客户端拉取正文
    const probe = await this.probe(absPath)
    if (!probe.ok) {
      if (probe.reason) this.opts.onLog?.('warn', `跳过 ${relPath}：${probe.reason}`)
      return
    }

    // ── L1 快筛 ──
    // 基准是「上次成功同步时的 size + mtime」。命中即完全不上传。
    if (this.opts.manifest.isUnchanged(relPath, probe.size, probe.mtimeMs)) {
      this.recordSkip(relPath, 'local_duplicate', probe.size)
      this.opts.manifest.setState(relPath, 'synced')
      return
    }
    // ── 超限拦截 ──
    // 夸克单文件上限可配（默认 20GB）。超限文件上传必然失败，
    // 与其进队列把重试次数耗光，不如当场拦下并说明原因。
    if (this.isOversize(probe.size, config)) {
      const message = `文件超过单文件上限（${formatBytes(probe.size)} > ${formatBytes(
        config.quarkMaxFileBytes
      )}），已跳过`
      this.opts.manifest.upsertFile({
        localPath: relPath,
        localSize: probe.size,
        mtimeMs: probe.mtimeMs,
        state: 'error'
      })
      this.opts.manifest.setState(relPath, 'error', { errorMsg: message })
      this.opts.manifest.log('error', `${message}：${relPath}`)
      this.opts.onLog?.('error', `${message}：${relPath}`)
      this.touch(relPath, { state: 'failed', errorMsg: message, size: probe.size })
      return
    }

    this.opts.manifest.upsertFile({
      localPath: relPath,
      localSize: probe.size,
      mtimeMs: probe.mtimeMs,
      state: 'pending',
      inode: probe.inode
    })

    this.enqueue({
      relPath,
      absPath,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      reason: 'watch',
      attempts: 0
    })
  }

  /**
   * 记录一次「跳过」。
   *
   * 跳过也要**出现在任务表里**——用户问「这个文件为什么没传」时，
   * 光看一个数字是无法回答的。任务条目带 category 与 skipReason，
   * 界面据此显示「本地未变」「远端已有」或「远端同名同大小」。
   *
   * 跳过任务的 localPath 用 relPath 占位：本地文件确实存在，
   * 只是内容不需要再传。
   *
   * 同时写一条带类别的日志：跳过是**同步做了什么**的一部分，
   * 不记的话日志页只剩上传记录，用户会以为文件漏传了。
   */
  private recordSkip(
    relPath: string,
    reason: 'local_duplicate' | 'remote_duplicate' | 'remote_size_match',
    size: number
  ): void {
    if (reason === 'local_duplicate') this.skippedLocal++
    else this.skippedRemote++

    const detail = this.skipDetail
    this.opts.onSkip?.(detail.total)
    this.opts.onSkipDetail?.(detail)

    this.touch(relPath, {
      state: 'skipped',
      category: 'skip',
      skipReason: reason,
      size,
      progress: 0,
      speed: 0,
      errorMsg: null
    })

    // 跳过原因要说清楚：三种跳过的含义完全不同，
    // 用户需要知道「没传」是因为内容一样，还是因为远端已有同名同大小。
    // 第三种要额外点明「未校验内容」——那是弱认定，风险点在此。
    const reasonText =
      reason === 'local_duplicate'
        ? '内容与上次同步一致，未变化'
        : reason === 'remote_duplicate'
          ? '远端已有相同内容（按哈希判定）'
          : '远端已有同名同大小文件，已认领为已同步（未校验内容）'
    this.opts.onLogDetail?.('info', `跳过 ${relPath}：${reasonText}`, {
      category: 'skip',
      filePath: relPath
    })
  }

  /**
   * 判断「远端是否已经有同样内容」。
   *
   * **服务端给不出任何信号**：实测 PUT 响应恒为 `{"code":200,"data":null}`，
   * 夸克驱动的 hash_info / hashinfo 都是 null——秒传成不成功无法观测。
   * 所以只能客户端自己算。
   *
   * 判据：本地文件的**双哈希**与清单里记录的「上次成功同步时远端那份内容」的哈希
   * 完全一致。两者都相同才算重复——单哈希碰撞概率虽低，
   * 但代价是一次无谓的全量上行，不值得赌。
   *
   * 注意比的是 synced_md5/synced_sha1 而不是 md5/sha1：
   * 后者记录的是本地文件当前状态，一次失败的上传就会把它改写。
   */
  private isRemoteDuplicate(relPath: string, hashes: FileHashes): boolean {
    const entry = this.opts.manifest.getFile(relPath)
    if (!entry?.syncedMd5 || !entry?.syncedSha1) return false
    if (entry.syncedMd5 !== hashes.md5) return false
    return entry.syncedSha1 === hashes.sha1
  }

  // ── L1.5 认领闸门 ──────────────────────────────────────

  /**
   * 「同名 + 同大小」认领：远端已有这份文件时，直接认领，跳过上传。
   *
   * 为什么需要它：清单里没有基准时（清过 userData、换了台设备、
   * 或者本地文件是新加的），L1 与 L2 都不命中 → 整批完整上行一遍。
   * 而远端那份内容其实已经在了——白传一次不说，还会覆盖远端，
   * 顺带触发 OpenList 的 `.openlist_to_delete` 中间态。
   *
   * 判据是**两个条件同时成立**：
   * - 文件名：按**相对路径**匹配，不是 basename。
   *   只比 basename 会把 `a/x.jpg` 与 `b/x.jpg` 认成同一个。
   * - 大小：必须相等。
   *
   * ⚠️ 这条闸门**只对「从未同步过」的文件生效**（清单 synced_size 为空）。
   * 已经同步过的文件若内容改了但大小不变，尺寸匹配会误判成「已同步」→
   * 漏传 → 备份缺口。那种情况必须走 L2 哈希比对，不能在这里下结论。
   *
   * ⚠️ 它是**弱认定**：只比了大小，没读内容。
   * 所以认领出来的记录 verify_level 记 'size'，
   * synced_md5 / synced_sha1 保持 NULL（没校验内容不能谎称哈希确认）。
   *
   * @returns 是否已认领（认领成立则本次不需要上传）
   */
  private async tryAdoptByNameAndSize(item: QueueItem): Promise<boolean> {
    const { manifest } = this.opts
    const config = this.opts.getConfig()
    if (!config.remoteScan.adoptByNameAndSize) return false

    // 已经同步过的文件不走这条：它已有内容校验过的结论，
    // 弱认定反而会把结论降级，也可能漏传改过的内容。
    if (manifest.isSynced(item.relPath)) return false

    const remotePath = joinRemote(config.remoteRoot, item.relPath)
    const remoteSize = await this.lookupRemoteSize(remotePath)
    if (remoteSize === null) return false
    if (remoteSize !== item.size) return false

    // mtime 取清单里的最新值：retry() 入队时传的是 0，
    // 直接用它会写出错误的 L1 基准，导致下一轮扫描永远不命中快筛。
    const mtimeMs = manifest.getFile(item.relPath)?.mtimeMs ?? item.mtimeMs

    const adopted = manifest.adoptRemote({
      localPath: item.relPath,
      localSize: item.size,
      mtimeMs,
      remotePath,
      remoteSize
    })
    if (!adopted) return false

    // 跳过日志由 recordSkip 统一写（它带上原因与类别），
    // 这里不再重复写一条——否则同一次认领会出两条日志。
    this.recordSkip(item.relPath, 'remote_size_match', item.size)
    return true
  }

  /**
   * 远端某路径上有没有同名文件，有的话返回它的大小。
   *
   * 走**目录列表**而不是逐个 stat：一次列举能回答整个目录里所有文件的问题，
   * 而 stat 是 N 次请求。目录列举的结果缓存在 remoteDirCache 里，
   * 同一批文件集中在一个目录时只花一次请求。
   *
   * @returns 远端没有该文件时返回 null
   */
  private async lookupRemoteSize(remotePath: string): Promise<number | null> {
    const dir = remoteDirname(remotePath)
    const name = remoteBasename(remotePath)

    let entries = this.remoteDirCache.get(dir)
    if (!entries) {
      entries = await this.loadRemoteDir(dir)
    }
    return entries.get(name) ?? null
  }

  /** 列举远端目录并缓存；同一目录的并发请求会合并成一次 */
  private async loadRemoteDir(dir: string): Promise<Map<string, number>> {
    const pending = this.remoteDirPending.get(dir)
    if (pending) return pending

    const task = (async (): Promise<Map<string, number>> => {
      const entries = new Map<string, number>()
      try {
        /*
         * 不刷新（refresh:false）。
         *
         * 刷新会把「还没在夸克落盘的文件」从服务端缓存里抹掉——
         * 那会让刚上传成功的文件看起来不存在。
         * 认领只需要知道「远端有没有这份文件」，缓存快照足够。
         */
        const res = await this.opts.client.list(dir)
        for (const entry of res.content) {
          if (entry.isDir) continue
          entries.set(entry.name, entry.size)
        }
      } catch {
        // 目录读不到（不存在 / 无权限）→ 视作该目录下没有任何文件
      }
      this.remoteDirCache.set(dir, entries)
      return entries
    })()

    this.remoteDirPending.set(dir, task)
    try {
      return await task
    } finally {
      this.remoteDirPending.delete(dir)
    }
  }

  // ── 入口：远端对账差异回流 ─────────────────────────────

  /**
   * 排入一个下载任务（远端 → 本地）。
   *
   * 两条来源：
   * - 对账发现「仅远端存在」，按 pull 策略自动下载
   * - 用户在对账页手动点「下载到本地」
   *
   * 都走这一个入口，任务表里才有统一的「下载」类别，
   * 用户也才能在队列里看到进度与失败。
   */
  enqueueDownload(params: {
    /** 本地相对路径（相对同步根） */
    relPath: string
    /** 远端绝对路径 */
    remotePath: string
    /** 远端文件大小；未知时传 0 */
    size?: number
  }): void {
    if (!this.running) return
    const config = this.opts.getConfig()
    if (!config.syncRoot) return

    const absPath = absolutize(config.syncRoot, params.relPath)

    // 已在队列或在途的同名项不重复排
    if (this.downloadQueue.some((q) => q.relPath === params.relPath)) return
    if (this.inFlightDownloads.has(params.relPath)) return

    const item: DownloadItem = {
      relPath: params.relPath,
      absPath,
      remotePath: params.remotePath,
      size: params.size ?? 0,
      attempts: 0
    }
    this.downloadQueue.push(item)
    this.touch(params.relPath, {
      state: 'queued',
      category: 'download',
      skipReason: null,
      remotePath: params.remotePath,
      size: item.size
    })
    void this.pumpDownloads()
  }

  /**
   * 强制重新上传一个文件。
   *
   * 与 handleDiff 的区别：**不受 autoFixLimit 约束**。
   * autoFixLimit 是给「对账自动修复」设的保险丝，防止一轮对账引发大批重传；
   * 而深度校验是用户显式点出来的动作——他已经明确要求「查清楚」，
   * 不该再被一个自动修复上限拦住。
   *
   * 另外会先清掉同步基准：否则 L2 会拿本地哈希和 synced_md5 比，
   * 本地文件没改过就「相等」→ 判成远端重复 → 跳过上传，
   * 远端那份错的内容就永远留在那里了。
   */
  async reupload(relPath: string): Promise<void> {
    const config = this.opts.getConfig()
    if (!config.syncRoot) return

    const absPath = absolutize(config.syncRoot, relPath)
    const probe = await this.probe(absPath)
    if (!probe.ok) {
      this.opts.onLog?.('warn', `无法重新上传 ${relPath}：${probe.reason ?? '文件不可读'}`)
      return
    }

    // 队列里还没跑的旧项摘掉；正在跑的标记取消
    this.dropQueued(relPath)
    const running = this.inFlight.get(relPath)
    if (running) running.canceled = true

    this.opts.manifest.clearSyncBaseline(relPath)
    this.opts.manifest.setState(relPath, 'pending', { errorMsg: null })

    this.enqueue({
      relPath,
      absPath,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      reason: 'diff',
      attempts: 0
    })
  }

  /**
   * 远端对账产生的差异回流。
   *
   * 默认立场「本地为准」：
   * - missing_remote / size_mismatch → 重新入队上传（受 autoFixLimit 约束）
   * - remote_only → 只记录，不动作
   */
  /**
   * 处理一条对账差异（机器动作）。
   *
   * 返回**是否真的处理了**。调用方（Engine.resolveDiff）据此决定
   * 能不能把差异标记成「已处置」。
   *
   * 为什么必须区分「处理了」和「没处理」：
   * 这个方法有多个提前 return 的分支——冲突策略不是 local-wins、
   * 自动修复额度已满、本地文件读不到、超单文件上限。
   * 以前它返回 void，上层不管三七二十一就把差异标成「已处置」。
   * 用户看到「已处置」，以为远端已经用本地那份覆盖了，
   * 其实什么都没发生——远端那份错的文件一直留着。
   */
  async handleDiff(diff: {
    kind: DiffKind
    localPath: string | null
    remotePath: string
  }): Promise<boolean> {
    const config = this.opts.getConfig()
    if (config.remoteScan.conflictPolicy !== 'local-wins') {
      this.opts.onLog?.(
        'warn',
        `冲突策略为「全部交由我确认」，未自动处理差异：${diff.remotePath}`
      )
      return false
    }

    if (diff.kind !== 'missing_remote' && diff.kind !== 'size_mismatch') {
      if (diff.kind === 'remote_only') {
        this.opts.onLog?.('info', `远端多出文件（按策略不动作）：${diff.remotePath}`)
      }
      return false
    }

    if (this.autoFixed >= config.remoteScan.autoFixLimit) {
      this.opts.onLog?.(
        'warn',
        `对账自动修复已达上限 ${config.remoteScan.autoFixLimit}，其余差异仅记录待人工确认`
      )
      return false
    }
    if (!diff.localPath) return false

    const absPath = absolutize(config.syncRoot, diff.localPath)
    const probe = await this.probe(absPath)
    if (!probe.ok) return false

    // 同样受单文件上限约束：超限文件回流重传也只会失败
    if (this.isOversize(probe.size, config)) {
      const message = `文件超过单文件上限（${formatBytes(probe.size)} > ${formatBytes(
        config.quarkMaxFileBytes
      )}），已跳过`
      this.opts.manifest.setState(diff.localPath, 'error', { errorMsg: message })
      this.opts.onLog?.('error', `${message}：${diff.localPath}`)
      this.touch(diff.localPath, { state: 'failed', errorMsg: message, size: probe.size })
      return false
    }

    this.autoFixed++
    this.opts.onLog?.(
      'info',
      `对账发现${diff.kind === 'missing_remote' ? '远端缺失' : '内容不符'}，重新上传 ${diff.localPath}`
    )

    this.enqueue({
      relPath: diff.localPath,
      absPath,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      reason: 'diff',
      attempts: 0
    })
    return true
  }

  // ── 手动重试 / 取消 ───────────────────────────────────

  /**
   * 重试一个失败任务。
   *
   * 必须先把**旧的队列残留清干净**，否则会出现两种假象：
   * - 项还在 hashQueue 里 → enqueue 直接 return，按钮看着没反应
   * 项还在 uploadQueue 里 → 重复排一次，远端出现 `xxx(1).ext`
   *
   * 另外重试要重置 attempts：否则它一进队列就因为
   * 「attempts 已达上限」立刻又被判失败。
   */
  retry(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state === 'uploading' || task.state === 'hashing' || task.state === 'downloading') {
      return
    }

    const config = this.opts.getConfig()
    const absPath = absolutize(config.syncRoot, task.localPath)

    // 跳过类任务没有「重试」的意义：它们不是失败，是判定结论。
    // 让用户点一下就变成一次真实上传反而会误导。
    if (task.category === 'skip') return

    // 下载任务走自己的队列
    if (task.category === 'download') {
      this.dropDownloaded(task.localPath)
      // 同上：在途项必须立刻摘掉，否则 enqueueDownload 的去重会挡下重试
      const running = this.inFlightDownloads.get(task.localPath)
      if (running) {
        running.canceled = true
        this.inFlightDownloads.delete(task.localPath)
      }

      this.touch(task.localPath, {
        state: 'queued',
        category: 'download',
        errorMsg: null,
        progress: 0,
        attempts: 0,
        // 显式解除取消守卫：重试是用户主动要求的，得能把状态拉回来
        retryReset: true
      })
      this.enqueueDownload({
        relPath: task.localPath,
        remotePath: task.remotePath,
        size: task.size
      })
      return
    }

    // 从两个队列里摘掉同路径的旧项
    this.dropQueued(task.localPath)

    /*
     * 在途的那一项：让它自己跑完就不要再动状态。
     *
     * 但**必须立刻把它从 inFlight 摘掉**。
     *
     * 原因：`enqueue` 的去重会查 inFlight（只查队列数组的话，
     * 正在 await 里的项会被排第二遍 → 远端出现 `xxx(1).ext`）。
     * 而在途项要等到阶段结束才从 inFlight 里删掉——
     * 如果用户是在「上传失败后的退避等待」窗口里点的重试，
     * 此时 inFlight 里还挂着那一项，enqueue 直接被去重挡掉，
     * 原任务又因为已被标记 canceled 而在退避结束后 return。
     * 结果：文件卡在 pending，本次会话再也不上传，
     * 直到下次全量重扫或重启才恢复。
     */
    const running = this.inFlight.get(task.localPath)
    if (running) {
      running.canceled = true
      this.inFlight.delete(task.localPath)
    }

    this.touch(task.localPath, {
      state: 'queued',
      errorMsg: null,
      progress: 0,
      attempts: 0,
      // 显式解除取消守卫：重试是用户主动要求的，得能把状态拉回来
      retryReset: true
    })
    this.enqueue({
      relPath: task.localPath,
      absPath,
      size: task.size,
      mtimeMs: 0,
      reason: 'retry',
      attempts: 0
    })
  }

  /**
   * 取消一个任务。
   *
   * 三件事都要做，缺一个按钮就是「点了没反应」：
   * 1. 摘掉还没开始跑的队列项
   * 2. 标记正在跑的项，让它在阶段边界自行退出
   * 3. 更新任务表状态（界面立刻可见）
   */
  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state === 'done') return
    // 跳过是判定结论，不是可取消的过程
    if (task.category === 'skip') return

    if (task.category === 'download') {
      this.dropDownloaded(task.localPath)
      const running = this.inFlightDownloads.get(task.localPath)
      if (running) running.canceled = true

      this.touch(task.localPath, {
        state: 'canceled',
        category: 'download',
        progress: 0
      })
      this.opts.onLog?.('warn', `已取消下载：${task.localPath}`)
      return
    }

    this.dropQueued(task.localPath)

    const running = this.inFlight.get(task.localPath)
    if (running) running.canceled = true

    this.touch(task.localPath, { state: 'canceled', progress: 0 })
    /*
     * 清单状态用 local_only（「本地有、远端无、尚未上传」）。
     * 不能写 error：error 在恢复列表里，下次启动会被重新捞起来重传——
     * 用户明明取消了，程序又偷偷传一遍。
     * local_only 不在恢复列表里，语义也对。
     */
    this.opts.manifest.setState(task.localPath, 'local_only', { errorMsg: '已取消' })
    this.opts.onLog?.('warn', `已取消：${task.localPath}`)
  }

  /** 从两个队列里摘掉指定路径的项 */
  private dropQueued(relPath: string): void {
    const drop = (q: QueueItem[]): void => {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].relPath === relPath) q.splice(i, 1)
      }
    }
    drop(this.hashQueue)
    drop(this.uploadQueue)
  }

  /** 从下载队列里摘掉指定路径的项 */
  private dropDownloaded(relPath: string): void {
    for (let i = this.downloadQueue.length - 1; i >= 0; i--) {
      if (this.downloadQueue[i].relPath === relPath) this.downloadQueue.splice(i, 1)
    }
  }

  // ── 内部：入队与流水线 ─────────────────────────────────

  private enqueue(item: QueueItem): void {
    // 同一路径已在队列中就不重复排。
    // 但**在途**的那一项也必须算上：它已经从队列 shift 出来了，
    // 只看队列数组会以为它没排过，于是同一个文件被排两次、
    // 上传两次，远端就多出一个 `xxx(1).ext`。
    if (this.hashQueue.some((q) => q.relPath === item.relPath)) return
    if (this.uploadQueue.some((q) => q.relPath === item.relPath)) return
    if (this.inFlight.has(item.relPath)) return

    this.hashQueue.push(item)
    this.touch(item.relPath, { state: 'queued' })
    void this.pump()
  }

  /**
   * 调度泵：把哈希池与上传池各自喂到并发上限。
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      let hashActive = 0
      let uploadActive = 0

      while (this.running) {
        const config = this.opts.getConfig()
        const hashLimit = Math.max(1, config.hashConcurrency)
        const uploadLimit = Math.max(1, config.uploadConcurrency)

        while (hashActive < hashLimit && this.hashQueue.length > 0) {
          const item = this.hashQueue.shift()!
          hashActive++
          void this.runHashStage(item)
            .catch((err) => this.handleFatal(item, err))
            .finally(() => {
              hashActive--
              void this.pump()
            })
        }

        while (uploadActive < uploadLimit && this.uploadQueue.length > 0) {
          const item = this.uploadQueue.shift()!
          uploadActive++
          void this.runUploadStage(item)
            .catch((err) => this.handleFatal(item, err))
            .finally(() => {
              uploadActive--
              void this.pump()
            })
        }

        if (hashActive === 0 && uploadActive === 0) break
        await sleep(50)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 哈希阶段：读一次文件同时产出 MD5 + SHA1 */
  private async runHashStage(item: QueueItem): Promise<void> {
    // 登记在途项：取消操作要靠它才能找到「正在跑的这一项」
    this.inFlight.set(item.relPath, item)
    try {
      if (item.canceled) return
      const manifest = this.opts.manifest

      /*
       * ── L1.5 认领闸门 ──
       *
       * 放在哈希**之前**：认领成立就不用读盘算哈希，整段读盘都省掉。
       *
       * 为什么必须在哈希之前而不是之后：L2 哈希判重要读到内容才发现
       * 「远端已经有同样的内容」，而认领只凭名称与大小就能下结论。
       * 反过来，先算哈希再认领的话，这批文件照样白读一遍盘。
       */
      if (await this.tryAdoptByNameAndSize(item)) return

      manifest.setState(item.relPath, 'hashing')

      const hashes = await hashFile(item.absPath)
      // 哈希可能耗时较久，await 之后必须重新确认没被取消
      if (item.canceled) return
      item.hashes = hashes

      manifest.setState(item.relPath, 'hashed', { md5: hashes.md5, sha1: hashes.sha1 })
      this.touch(item.relPath, {
        state: 'hashing',
        md5Prefix: hashes.md5.slice(0, 8),
        sha1Prefix: hashes.sha1.slice(0, 8)
      })

      // ── 远端重复判定 ──
      // 到了这一步才知道内容哈希，才能判断远端是否已经有同样的内容。
      // 命中则不必再上行：远端那份就是这份。
      if (this.isRemoteDuplicate(item.relPath, hashes)) {
        this.recordSkip(item.relPath, 'remote_duplicate', item.size)
        // 远端已经是这份内容，把 L1 基准刷新成当前值，
        // 下一轮扫描就能走「本地重复」这条更快的路。
        manifest.setState(item.relPath, 'synced', {
          remoteSize: item.size,
          syncedSize: item.size,
          syncedMtimeMs: item.mtimeMs,
          syncedMd5: hashes.md5,
          syncedSha1: hashes.sha1
        })
        return
      }

      this.uploadQueue.push(item)
    } finally {
      this.inFlight.delete(item.relPath)
    }
  }

  /** 上传阶段：单次 PUT 或分片，由 Transfer 内部按大小分流 */
  private async runUploadStage(item: QueueItem): Promise<void> {
    this.inFlight.set(item.relPath, item)
    try {
      await this.doUploadStage(item)
    } finally {
      this.inFlight.delete(item.relPath)
    }
  }

  private async doUploadStage(item: QueueItem): Promise<void> {
    if (item.canceled) return
    const { manifest, transfer } = this.opts
    const config = this.opts.getConfig()

    const remotePath = joinRemote(config.remoteRoot, item.relPath)

    // 先写清单再上传：上传成功后 Transfer 会把 state 置为 synced
    const fileId = manifest.upsertFile({
      localPath: item.relPath,
      localSize: item.size,
      mtimeMs: item.mtimeMs,
      remotePath,
      state: 'uploading'
    })

    this.touch(item.relPath, {
      state: 'uploading',
      remotePath,
      size: item.size,
      fileId,
      mode: item.size > config.singlePutMaxBytes ? 'multipart' : 'single'
    })

    // upsertFile 把状态写成了 uploading——如果这期间被取消了，
    // 得把状态收回去，否则清单里会留一条「上传中」的假记录。
    if (item.canceled) {
      manifest.setState(item.relPath, 'local_only', { errorMsg: '已取消' })
      return
    }

    await this.ensureRemoteDirs(remotePath)
    if (item.canceled) return

    const result = await transfer.upload({
      fileId,
      relPath: item.relPath,
      absPath: item.absPath,
      remotePath,
      hashes: item.hashes,
      // 让 Transfer 在写终态之前问一句「用户是不是已经取消了」
      isCanceled: () => item.canceled === true
    })

    // 取消发生在上传期间：结果一律丢弃，不改状态、不重试
    if (item.canceled) {
      /*
       * 但清单状态必须**由这里**校正成 local_only。
       *
       * Transfer 在 upload() 返回之前就已经把状态写成 synced 了，
       * 而 cancel() 写的那次可能发生在它**之前**——于是被覆盖掉，
       * 结果是「用户取消了，文件却显示已同步」，下次启动也不会重传。
       * Planner 是最后一道关口，终态在这里收口。
       */
      manifest.setState(item.relPath, 'local_only', { errorMsg: '已取消' })
      return
    }

    // Transfer 自己也可能因为被取消而返回失败——同样不当作真实失败
    if (result.error === '已取消') {
      manifest.setState(item.relPath, 'local_only', { errorMsg: '已取消' })
      return
    }

    if (result.ok) {
      this.touch(item.relPath, { state: 'done', progress: 1, speed: 0, errorMsg: null })
      // 用带类别的回调，不要再调 onLog——两者都会写日志，会重复出一条
      this.opts.onLogDetail?.('info', `已上传 ${item.relPath} → ${remotePath}`, {
        category: 'upload',
        filePath: item.relPath,
        remotePath
      })
      return
    }

    // 失败重试。确定性失败（如超限）标记为不可重试，直接落地失败状态。
    item.attempts++
    const maxAttempts = config.retry.maxAttempts
    const retryable = result.retryable !== false
    if (retryable && item.attempts < maxAttempts && this.running) {
      this.touch(item.relPath, {
        state: 'queued',
        attempts: item.attempts,
        errorMsg: result.error ?? '上传失败'
      })
      manifest.setState(item.relPath, 'pending', { errorMsg: result.error ?? '上传失败' })
      // 用带类别的回调，不要再调 onLog——两者都会写日志，会重复出一条
      this.opts.onLogDetail?.(
        'warn',
        `上传失败（第 ${item.attempts}/${maxAttempts} 次），将重试：${item.relPath}（${result.error ?? '未知原因'}）`,
        { category: 'upload', filePath: item.relPath, remotePath }
      )
      await sleep(backoff(config.retry.baseDelayMs, item.attempts))
      // 退避期间用户可能点了取消：这时不要再把项塞回队列
      if (item.canceled) return
      this.hashQueue.push(item)
      return
    }

    this.touch(item.relPath, {
      state: 'failed',
      attempts: item.attempts,
      errorMsg: result.error ?? '上传失败'
    })
    this.opts.onLogDetail?.('error', `上传失败 ${item.relPath}：${result.error ?? '未知原因'}`, {
      category: 'upload',
      filePath: item.relPath,
      remotePath
    })
  }

  private handleFatal(item: QueueItem, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.opts.manifest.setState(item.relPath, 'error', { errorMsg: message })
    this.touch(item.relPath, { state: 'failed', errorMsg: message })
    this.opts.onLogDetail?.('error', `处理 ${item.relPath} 失败：${message}`, {
      category: 'upload',
      filePath: item.relPath
    })
  }

  // ── 下载 ──────────────────────────────────────────────

  /**
   * 下载队列的调度泵。
   *
   * 并发单独限流，不与上传共用额度：两边都打同一个远端，
   * 但下载不占上传的上行带宽，反过来也一样——
   * 混在一起会让「上传很快、下行也很快」互相抢带宽。
   */
  private async pumpDownloads(): Promise<void> {
    if (this.pumpingDownloads) return
    this.pumpingDownloads = true
    try {
      while (this.running && this.downloadQueue.length > 0) {
        const config = this.opts.getConfig()
        const limit = Math.max(1, Math.min(4, config.uploadConcurrency))
        const active = this.inFlightDownloads.size
        const slots = limit - active
        if (slots <= 0) {
          await sleep(50)
          continue
        }

        const batch = this.downloadQueue.splice(0, slots)
        await Promise.all(
          batch.map((item) =>
            this.runDownloadStage(item)
              .catch((err) => this.handleDownloadFatal(item, err))
              .finally(() => this.inFlightDownloads.delete(item.relPath))
          )
        )
      }
    } finally {
      this.pumpingDownloads = false
    }
  }

  /** 单个下载的执行流程 */
  private async runDownloadStage(item: DownloadItem): Promise<void> {
    this.inFlightDownloads.set(item.relPath, item)
    if (item.canceled) return

    const config = this.opts.getConfig()
    const startedAt = Date.now()

    this.touch(item.relPath, {
      state: 'downloading',
      category: 'download',
      skipReason: null,
      remotePath: item.remotePath,
      size: item.size
    })

    // 本地目录可能还不存在（远端有、本地没有的深层路径）
    await mkdir(dirname(item.absPath), { recursive: true })

    const controller = new AbortController()
    try {
      await this.opts.client.downloadTo(item.remotePath, item.absPath, {
        signal: controller.signal,
        onProgress: (received, total) => {
          if (item.canceled) {
            controller.abort()
            return
          }
          const elapsed = (Date.now() - startedAt) / 1000
          this.touch(item.relPath, {
            state: 'downloading',
            category: 'download',
            progress: total > 0 ? Math.min(1, received / total) : 0,
            speed: elapsed > 0 ? received / elapsed : 0,
            size: total > 0 ? total : item.size
          })
        }
      })
    } catch (err) {
      if (item.canceled) {
        this.opts.manifest.setState(item.relPath, 'remote_only', { errorMsg: '已取消' })
        return
      }

      const message = err instanceof Error ? err.message : String(err)
      item.attempts++
      const maxAttempts = config.retry.maxAttempts
      if (item.attempts < maxAttempts && this.running) {
        this.touch(item.relPath, {
          state: 'queued',
          category: 'download',
          attempts: item.attempts,
          errorMsg: message
        })
        this.opts.onLogDetail?.(
          'warn',
          `下载失败（第 ${item.attempts}/${maxAttempts} 次），将重试：${item.relPath}（${message}）`,
          { category: 'download', filePath: item.relPath, remotePath: item.remotePath }
        )
        await sleep(backoff(config.retry.baseDelayMs, item.attempts))
        if (item.canceled) return
        this.downloadQueue.push(item)
        return
      }

      this.touch(item.relPath, {
        state: 'failed',
        category: 'download',
        attempts: item.attempts,
        errorMsg: message
      })
      this.opts.onLogDetail?.('error', `下载失败 ${item.relPath}：${message}`, {
        category: 'download',
        filePath: item.relPath,
        remotePath: item.remotePath
      })
      return
    }

    if (item.canceled) {
      this.opts.manifest.setState(item.relPath, 'remote_only', { errorMsg: '已取消' })
      return
    }

    // 落盘成功：把这条文件登记进清单，标记为已同步。
    // 基准写当前 size/mtime，下一轮扫描就走 L1 快筛，不再重复上传。
    const st = await stat(item.absPath, { bigint: true }).catch(() => null)
    const size = st ? Number(st.size) : item.size
    const mtimeMs = st ? Number(st.mtimeMs) : Date.now()

    this.opts.manifest.upsertFile({
      localPath: item.relPath,
      localSize: size,
      mtimeMs,
      remotePath: item.remotePath,
      state: 'synced'
    })
    this.opts.manifest.setState(item.relPath, 'synced', {
      remoteSize: size,
      syncedSize: size,
      syncedMtimeMs: mtimeMs
    })

    this.downloadedCount++
    this.opts.onDownload?.(this.downloadedCount)
    this.touch(item.relPath, {
      state: 'done',
      category: 'download',
      skipReason: null,
      progress: 1,
      speed: 0,
      size,
      errorMsg: null
    })
    // 用带类别的回调，不要再调 onLog——两者都会写日志，会重复出一条
    this.opts.onLogDetail?.('info', `已下载 ${item.remotePath} → ${item.relPath}`, {
      category: 'download',
      filePath: item.relPath,
      remotePath: item.remotePath
    })
  }

  private handleDownloadFatal(item: DownloadItem, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.touch(item.relPath, {
      state: 'failed',
      category: 'download',
      errorMsg: message
    })
    this.opts.onLogDetail?.('error', `下载 ${item.relPath} 失败：${message}`, {
      category: 'download',
      filePath: item.relPath,
      remotePath: item.remotePath
    })
  }

  // ── 删除处理 ──────────────────────────────────────────

  /**
   * 本地文件被删除。
   *
   * 三档策略：trash（移入远端回收站）/ delete（直接删）/ keep（不动）。
   * 熔断：单次会话内删除数或删除字节数超限即暂停删除队列。
   *
   * 开启重命名识别时，删除**不会立即执行**——先挂起一个窗口，
   * 看有没有「新路径出现」与它配对。配上了就是改名，走 move；
   * 没人认领才真正删远端。
   */
  private handleRemoval(relPath: string, config: AppConfig): void {
    const manifest = this.opts.manifest
    const entry = manifest.getFile(relPath)
    manifest.setState(relPath, 'deleted')

    if (config.deletePolicy === 'keep') return
    if (!entry?.remotePath) return

    // 只有「远端确实有这个文件」才值得挂起等待重命名配对。
    // 否则挂起只会白白推迟一次本该立刻执行的删除。
    const syncedRemotely = entry.syncedSize !== null && entry.remoteSize !== null
    if (config.detectRenames && syncedRemotely && this.renamer.registerRemoval(relPath, entry)) {
      // 挂起等待配对；窗口过后由 flushExpiredRemovals 真正删除
      this.opts.onLog?.('info', `本地删除已挂起，等待重命名配对窗口结束：${relPath}`)
      return
    }

    this.deleteQueue.push({
      relPath,
      remotePath: entry.remotePath,
      size: entry.remoteSize ?? entry.localSize
    })
    void this.pumpDeletes()
  }

  /**
   * 处理挂起期满、无人认领的删除。
   *
   * 定时调用（窗口到期时）。
   */
  flushExpiredRemovals(): void {
    if (!this.running) return
    const config = this.opts.getConfig()
    if (config.deletePolicy === 'keep') {
      this.renamer.clear()
      return
    }

    const expired = this.renamer.drainExpired()
    for (const item of expired) {
      if (!item.entry?.remotePath) continue
      this.opts.onLog?.('info', `删除窗口已过，执行远端删除：${item.relPath}`)
      this.deleteQueue.push({
        relPath: item.relPath,
        remotePath: item.entry.remotePath,
        size: item.entry.remoteSize ?? item.entry.localSize
      })
    }
    if (expired.length > 0) void this.pumpDeletes()
  }

  // ── 重命名 ──────────────────────────────────────────────

  /** 询问这个新增路径是否是某个刚消失路径的改名 */
  private async matchRename(relPath: string, absPath: string): Promise<RenameCandidate | null> {
    return this.renamer.match(relPath, absPath)
  }

  /**
   * 执行重命名：远端 move，本地清单改路径。
   *
   * 返回 true 表示重命名已处理完（调用方不必再走上传流程）；
   * false 表示退回按普通新增处理——文件绝不能因为「改名没识别出来」而丢。
   */
  private async applyRename(
    candidate: RenameCandidate,
    absPath: string,
    config: AppConfig
  ): Promise<boolean> {
    const { manifest } = this.opts
    const newRemotePath = joinRemote(config.remoteRoot, candidate.newRelPath)

    // 旧路径在远端不存在（可能本来就没同步成功）→ 退回普通上传
    if (!candidate.oldRemotePath) {
      this.opts.onLog?.(
        'warn',
        `重命名 ${candidate.oldRelPath} → ${candidate.newRelPath}：旧路径无远端记录，按新增处理`
      )
      return false
    }

    try {
      await this.ensureRemoteDirs(newRemotePath)
      await this.opts.client.move(candidate.oldRemotePath, newRemotePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.onLog?.(
        'error',
        `重命名远端 move 失败 ${candidate.oldRelPath} → ${candidate.newRelPath}：${message}，退回重新上传`
      )
      // 远端 move 失败不能就此收工——退回按普通新增处理，否则文件会丢
      manifest.setState(candidate.oldRelPath, 'deleted')
      return false
    }

    const probe = await this.probe(absPath)
    const old = manifest.getFile(candidate.oldRelPath)
    manifest.renameLocalPath(candidate.oldRelPath, candidate.newRelPath, newRemotePath, {
      size: probe.ok ? probe.size : (old?.localSize ?? 0),
      mtimeMs: probe.ok ? probe.mtimeMs : (old?.mtimeMs ?? 0),
      inode: probe.inode
    })

    this.opts.manifest.log(
      'info',
      `已重命名 ${candidate.oldRelPath} → ${candidate.newRelPath}（远端移动，未重新上传）`,
      undefined,
      newRemotePath
    )
    this.touch(candidate.newRelPath, {
      state: 'done',
      progress: 1,
      speed: 0,
      errorMsg: null,
      remotePath: newRemotePath
    })
    return true
  }

  // ── 空目录同步 ──────────────────────────────────────────

  /**
   * 目录事件。
   *
   * 只有**空目录**需要在远端单独创建——非空目录在上传其下文件时
   * 会由 ensureRemoteDirs 顺带建出来。
   */
  private async handleDirEvent(
    relPath: string,
    exists: boolean,
    config: AppConfig
  ): Promise<void> {
    if (!config.syncEmptyDirs) return

    const remotePath = joinRemote(config.remoteRoot, relPath)

    if (!exists) {
      // 本地目录消失 → 远端对应目录一并移除（仅限空目录，递归删除风险高）
      this.opts.onLog?.('info', `本地目录已删除：${relPath}（远端目录保留，避免误删远端内容）`)
      return
    }

    // 判断是否空目录：readdir 一把，非空则无需单独建
    let empty: boolean
    try {
      const { readdir } = await import('fs/promises')
      const entries = await readdir(absolutize(config.syncRoot, relPath))
      empty = entries.length === 0
    } catch {
      return
    }

    if (!empty) return

    if (this.knownRemoteDirs.has(remotePath)) return

    try {
      await this.opts.client.mkdir(remotePath)
      this.knownRemoteDirs.add(remotePath)
      this.opts.manifest.log('info', `已同步空目录 ${relPath}`, undefined, remotePath)
      this.opts.onLog?.('info', `已同步空目录：${relPath}`)
    } catch {
      // 已存在或无权创建时忽略
      this.knownRemoteDirs.add(remotePath)
    }
  }

  private async pumpDeletes(): Promise<void> {
    const config = this.opts.getConfig()

    while (this.deleteQueue.length > 0) {
      if (this.deleteCount >= config.maxDeletesPerRun) {
        this.opts.onLog?.(
          'error',
          `删除熔断：本次会话删除数已达上限 ${config.maxDeletesPerRun}，暂停删除队列`
        )
        this.deleteQueue.length = 0
        return
      }
      if (this.deleteBytes >= config.maxDeleteBytesPerRun) {
        this.opts.onLog?.(
          'error',
          `删除熔断：本次会话删除字节数已达上限 ${config.maxDeleteBytesPerRun}，暂停删除队列`
        )
        this.deleteQueue.length = 0
        return
      }

      const item = this.deleteQueue.shift()!
      try {
        if (config.deletePolicy === 'trash') {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          // 回收站必须落在 remoteRoot 之下。远端根上可能只有若干挂载点，
          // 在根上建目录会得到 "storage not found"——建在 remoteRoot 里才对。
          const dest = joinRemote(
            config.remoteRoot,
            `${config.trashRoot}/${stamp}/${item.relPath}`
          )
          this.opts.onLog?.('info', `移入远端回收站：${item.remotePath} → ${dest}`)
          await this.opts.client.move(item.remotePath, dest)
        } else {
          this.opts.onLog?.('info', `删除远端文件：${item.remotePath}`)
          await this.opts.client.remove([item.remotePath])
        }
        this.deleteCount++
        this.deleteBytes += item.size
        this.opts.manifest.log('info', `已处理远端删除 ${item.remotePath}`, undefined, item.remotePath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.opts.onLog?.('error', `远端删除失败 ${item.remotePath}：${message}`)
      }
    }
  }

  // ── 恢复 ──────────────────────────────────────────────

  /**
   * 启动时恢复未完成的任务。
   *
   * 上次退出时处于 uploading / error 的文件重新入队。
   * 哈希若已记录则复用（省一次读盘），否则重算。
   */
  recoverPending(): number {
    const manifest = this.opts.manifest
    const config = this.opts.getConfig()
    const pending = manifest.listFilesByStates(['uploading', 'error', 'hashed', 'pending'])

    let recovered = 0
    for (const entry of pending) {
      const absPath = absolutize(config.syncRoot, entry.localPath)

      /*
       * 清单表是**全局**的，不按 syncRoot 隔离。
       * 换过同步目录之后，旧目录的记录还留在表里——
       * 实测踩过：把 syncRoot 切到新目录后启动，
       * 上一轮的 readme.txt / docs/guide.md / sub/c.txt 全被当成
       * 「本地待上传文件」重新传了一遍，远端凭空多出 docs/、sub/ 目录，
       * 还把清单搅乱（新文件被判成 error）。
       *
       * 判据：本地路径下**确实存在**这个文件，才算待恢复的任务。
       * 不存在 = 那是别的目录留下的历史记录，不该重传。
       */
      if (!existsSync(absPath)) {
        manifest.setState(entry.localPath, 'error', { errorMsg: '本地文件已不存在' })
        continue
      }

      const item: QueueItem = {
        relPath: entry.localPath,
        absPath,
        size: entry.localSize,
        mtimeMs: entry.mtimeMs,
        reason: 'recovery',
        attempts: 0
      }

      /*
       * 复用清单里的哈希前，必须确认文件**还是当初哈希的那个版本**。
       *
       * 清单里的 md5/sha1 是上一次哈希时的残留值。应用关闭期间
       * 用户改了文件（大小或 mtime 变了），这里照抄旧哈希，
       * 就等于对着一份新内容声明旧哈希——
       * 而 OpenList 侧的夸克驱动正是拿 MD5+SHA1 做秒传判断的。
       *
       * 结果就是：远端命中旧 blob 直接建链，**远端留着旧内容，
       * 本地是新内容**，两边从此不一致，而且清单里记的哈希也是错的。
       *
       * 所以：大小或 mtime 对不上 → 老实回哈希队列重算。
       */
      let reusable = false
      if (entry.md5 && entry.sha1) {
        try {
          // 这里用同步 stat：recoverPending 只在启动/恢复时调用一次，
          // 文件数有限，且调用方（Engine.start / resume）本身就是同步流程。
          const st = statSync(absPath)
          reusable = st.size === entry.localSize && Math.abs(st.mtimeMs - entry.mtimeMs) < 1
        } catch {
          reusable = false
        }
      }

      if (reusable && entry.md5 && entry.sha1) {
        item.hashes = { md5: entry.md5, sha1: entry.sha1, size: entry.localSize }
        this.uploadQueue.push(item)
      } else {
        this.hashQueue.push(item)
      }
      recovered++
    }
    // 恢复的项可能直接进了 uploadQueue（已有哈希），
    // 而 pump 只在有事件时才会被唤醒——这里主动推一次。
    if (recovered > 0) void this.pump()
    return recovered
  }

  // ── 远端目录 ──────────────────────────────────────────

  /** 逐级创建远端目录；已存在或无权创建时忽略 */
  /**
   * 确保远端目录存在。
   *
   * 用 client.mkdirp 而不是自己逐级 mkdir：夸克驱动建目录是异步的，
   * 上一级没在远端就绪就建下一级，服务端会「返回成功但目录没建成」，
   * 随后上传报 object not found。mkdirp 会逐级等待就绪。
   */
  private async ensureRemoteDirs(remotePath: string): Promise<void> {
    const parts = remotePath.split('/').filter(Boolean)
    if (parts.length < 2) return
    const dirPath = '/' + parts.slice(0, -1).join('/')
    if (this.knownRemoteDirs.has(dirPath)) return
    try {
      await this.opts.client.mkdirp(dirPath)
      this.knownRemoteDirs.add(dirPath)
    } catch {
      // 已存在或无权创建时忽略：目录可能已由别的文件建好
    }
  }

  // ── 文件探针 ──────────────────────────────────────────

  /** 是否超过单文件上限；上限为 0 表示不限制 */
  private isOversize(size: number, config: AppConfig): boolean {
    return config.quarkMaxFileBytes > 0 && size > config.quarkMaxFileBytes
  }

  /**
   * 读取文件元信息。
   *
   * 读不到就跳过，不反复重试：
   * - EBUSY / EPERM：文件被其他进程占用（常见于 Office、网盘客户端）
   * - ENOENT：可能刚被删除，交给 unlink 事件处理
   * - 云盘占位文件：stat 成功但读取会触发云盘客户端拉正文，跳过
   */
  private async probe(absPath: string): Promise<{
    ok: boolean
    reason?: string
    size: number
    mtimeMs: number
    /** 文件索引号（字符串） */
    inode: string | null
  }> {
    try {
      // 用 bigint 读 stat：Windows 的 ino 是 64 位文件索引号，
      // 数值普遍超过 2^53。转成普通 number 会丢精度，
      // 存进 SQLite 再读出来更是直接抛
      // "Value is too large to be represented as a JavaScript number"。
      // 所以 inode 一律以字符串形态流转。
      const st = await stat(absPath, { bigint: true })
      return {
        ok: true,
        size: Number(st.size),
        mtimeMs: Number(st.mtimeMs),
        inode: st.ino > 0n ? st.ino.toString() : null
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { ok: false, reason: `文件被占用（${code}）`, size: 0, mtimeMs: 0, inode: null }
      }
      if (code === 'ENOENT') {
        return { ok: false, reason: '文件已不存在', size: 0, mtimeMs: 0, inode: null }
      }
      return { ok: false, reason: (err as Error).message, size: 0, mtimeMs: 0, inode: null }
    }
  }

  // ── 任务表 ────────────────────────────────────────────

  /** 更新某个相对路径对应的任务，并推给 UI */
  private touch(relPath: string, patch: Partial<TransferTask> & { retryReset?: boolean }): void {
    let id = this.taskIdByPath.get(relPath)
    if (!id) {
      id = randomUUID()
      this.taskIdByPath.set(relPath, id)
    }
    const existing = this.tasks.get(id)

    /*
     * 取消守卫。
     *
     * 用户点了取消之后，流水线里那些**还没察觉**的阶段还会继续
     * 回报状态：「哈希算完了」→ 写 hashing；「准备上传」→ 写 uploading。
     * 于是界面上刚显示「已取消」，一转眼又变回「上传中」——
     * 取消按钮像是没生效。
     *
     * 规则：任务一旦进入 canceled，任何**非 canceled** 的状态都不许再写回去。
     *
     * 例外是「重试」：重试是用户**主动**要求再跑一次，
     * 它必须能把状态从 canceled 拉回 queued。
     * 以前这里没留口子，结果取消后再点重试——上传其实执行了，
     * 界面却永远停在「已取消」，用户完全看不到真实状态。
     */
    const nextState = patch.state ?? existing?.state ?? 'queued'
    if (existing?.state === 'canceled' && nextState !== 'canceled' && !patch.retryReset) {
      return
    }

    const task: TransferTask = {
      id,
      fileId: patch.fileId ?? existing?.fileId ?? 0,
      localPath: relPath,
      remotePath: patch.remotePath ?? existing?.remotePath ?? '',
      size: patch.size ?? existing?.size ?? 0,
      mode: patch.mode ?? existing?.mode ?? 'single',
      state: nextState,
      /*
       * 类别与跳过原因。
       *
       * 默认是「上传」——绝大多数任务就是上传。
       * 跳过与下载在各自的关键节点显式覆盖。
       *
       * 注意 skipReason 用 `patch.skipReason !== undefined` 判断：
       * 用 `??` 的话，「显式置 null」会被当成「没传」而保留旧值，
       * 一个曾被跳过的文件后来真传了，界面上却还挂着跳过原因。
       */
      category: patch.category ?? existing?.category ?? 'upload',
      skipReason:
        patch.skipReason !== undefined ? patch.skipReason : (existing?.skipReason ?? null),
      chunksDone: patch.chunksDone ?? existing?.chunksDone ?? 0,
      chunksTotal: patch.chunksTotal ?? existing?.chunksTotal ?? 0,
      progress: patch.progress ?? existing?.progress ?? 0,
      speed: patch.speed ?? existing?.speed ?? 0,
      md5Prefix: patch.md5Prefix ?? existing?.md5Prefix ?? '',
      sha1Prefix: patch.sha1Prefix ?? existing?.sha1Prefix ?? '',
      errorMsg: patch.errorMsg !== undefined ? patch.errorMsg : (existing?.errorMsg ?? null),
      attempts: patch.attempts ?? existing?.attempts ?? 0
    }

    this.tasks.set(id, task)
    this.opts.onTask?.(task)
  }
}

function backoff(base: number, attempt: number): number {
  const exp = base * 2 ** Math.max(0, attempt - 1)
  return exp + Math.random() * base
}

/** 字节数转可读文本，用于超限提示 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${i === 0 ? value : value.toFixed(2)} ${units[i]}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
