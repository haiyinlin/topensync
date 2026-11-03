import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, rm, stat } from 'fs/promises'
import { dirname } from 'path'
import type { Manifest } from '../db/manifest'
import type { Transfer } from '../transfer/transfer'
import type { FileHashes } from '../hash/hashes'
import { hashFile } from '../hash/hashes'
import type { OpenListClient } from '../openlist/client'
import { ioGovernor, isResourceExhausted, isResourceExhaustedMessage } from '../io/governor'
import { tick } from '../io/tick'
import {
  absolutize,
  isExcluded,
  joinRemote,
  remoteBasename,
  remoteDirname,
  relativizeRemote
} from '../watcher/paths'
import { RenameDetector, type RenameCandidate } from './rename'
import { explainError } from '@shared/errors'
import type {
  AppConfig,
  DiffKind,
  LogCategory,
  SkipReason,
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

/**
 * 任务表容量上限。
 *
 * 为什么要有上限：一次本地扫描会把**每个**文件都变成一条任务——
 * 六万个文件就是六万条。这个表无界增长的话，主进程内存跟着涨，
 * 渲染层每次收到一条更新还要遍历全表，界面必然失去响应。
 *
 * 三千条足够回答「刚才在传什么、哪个失败了」。
 * 更早的完整明细由**同步历史**承载——它永久落库、分页可查，
 * 所以任务表淘汰旧记录不再意味着「记录丢失」。
 */
export const MAX_TASKS = 3000

/**
 * 淘汰的滞后量。
 *
 * 不写成「一超上限就淘汰一条」：那会让每次插入都触发一次表扫描，
 * 又变成 O(n²)。攒够一批再一次性淘汰到位，均摊下来接近 O(1)。
 */
const TASK_EVICT_SLACK = 600

/**
 * 任务表的实际容量上限。
 *
 * 表的大小在 `MAX_TASKS` 与这个值之间浮动：超过上限 + 滞后量才动手，
 * 一次清回 `MAX_TASKS`。对外说明「上限」时用这个数更准确。
 */
export const TASK_TABLE_LIMIT = MAX_TASKS + TASK_EVICT_SLACK

/**
 * 「刚完成」的保护窗口（毫秒）。
 *
 * 任务表满到要淘汰时，完成时间在最近这个窗口内的任务暂不淘汰，
 * 让用户来得及在传输队列里看到「刚刚完成了什么」。超过窗口、且仍是
 * 终态的任务按完成时间从老到新淘汰。
 */
const EVICT_GRACE_MS = 60_000

/**
 * 本地事件处理的并发度。
 *
 * 这里定 8，但**真正同时打开的文件句柄由 IO 闸门兜底**（见 io/governor.ts）：
 * 事件处理、哈希、上传三条路都从同一把闸门取额度，
 * 所以这里调大只影响「排队等闸门的人有多少」，不会突破句柄上限。
 *
 * 为什么需要大于 1：同步根常在网络盘 / 挂载盘上，单次 stat 的
 * 往返延迟可以到几十毫秒；串行处理 5 万个文件要几十分钟，
 * 用户会以为程序卡住了。
 */
const EVENT_CONCURRENCY = 8

/**
 * 句柄不足时的重试上限。
 *
 * 40 次 × 最长 30 秒冷却 ≈ 20 分钟——足够覆盖「盘临时掉线又被重连」
 * 这类现实情况，又不至于让盘真坏掉时无限空转。
 */
const MAX_FD_RETRIES = 40

/** 闸门没在冷却（说明是别处抛的 EMFILE）时的兜底等待 */
const FD_RETRY_FALLBACK_MS = 1000

/**
 * 这个状态的任务能否被淘汰。
 *
 * 只有三种终态可以：取消、完成、跳过。
 * 进行中的（queued/hashing/uploading/downloading）正在跑，
 * 失败的（failed）是用户要处理的——丢掉等于把问题藏起来。
 */
function isEvictable(state: TransferTask['state']): boolean {
  return state === 'canceled' || state === 'done' || state === 'skipped'
}

/** 终态：任务不会再被调度，可以安全淘汰并盖「完成时间」戳 */
function isTerminal(state: TransferTask['state']): boolean {
  return state === 'done' || state === 'skipped' || state === 'canceled'
}

export interface PlannerOptions {
  manifest: Manifest
  transfer: Transfer
  /** 远端客户端（建目录、删除、回收站移动） */
  client: OpenListClient
  /** 读当前配置（配置可在运行时改，故用函数而非快照） */
  getConfig: () => AppConfig
  onTask?: (task: TransferTask) => void
  /**
   * 任务表因容量上限淘汰了一批记录。
   *
   * 渲染层必须同步删掉这些 id，否则它的数组会一直涨，
   * 而主进程早就不认这些任务了。
   */
  onTasksEvicted?: (ids: string[]) => void
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
  /**
   * 下载流量回调（字节数）。
   *
   * 上传的流量由 Transfer 的 onProgress 报；下载不走 Transfer，
   * 所以要单独开一个口子，否则「总体速率」只统计了一半——
   * 而下载往往才是备份里的主要流量。
   */
  onDownloadBytes?: (bytes: number) => void
}

interface QueueItem {
  relPath: string
  absPath: string
  size: number
  mtimeMs: number
  reason: EnqueueReason
  attempts: number
  /** 因本地盘句柄不足而重试的次数（与 attempts 分开计） */
  fdRetries?: number
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
  /**
   * 这一项是否会被重新塞回队列（失败重试 / 句柄冷却重试）。
   *
   * 流水线阶段收尾时据此决定要不要从 `queuedPaths` 里摘掉它——
   * 摘错了会漏传（项还在队列里，去重却认为它不在），
   * 不摘会永远卡住（项已经结束，去重却认为它还在排队）。
   */
  requeued?: boolean
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
  /**
   * 「已排队或已在跑」的路径索引。
   *
   * 为什么需要它：`enqueue()` 要去重，以前是
   * `hashQueue.some(...) || uploadQueue.some(...)`——队列长到几万条时，
   * 每来一个事件都要线性扫两遍，整体是 O(n²)。
   * 实测六万文件时主线程几乎全耗在这两个 `some()` 里，
   * 界面表现为「点了扫描就一直卡」。
   *
   * 用 Set 之后去重是 O(1)。它必须与三个容器保持同步：
   * hashQueue / uploadQueue / inFlight。
   */
  private readonly queuedPaths = new Set<string>()
  private readonly downloadQueue: DownloadItem[] = []
  private readonly deleteQueue: DeleteItem[] = []
  /**
   * 本地事件队列（进 planner 的入口闸门）。
   *
   * 每条事件是一次「stat + 查清单 + 可能写库」，本身不重，
   * 但数量级是「一次扫描几万条」。不限并发的话，
   * 几万个 stat 同时开着 → 驱动器句柄耗尽（EMFILE）。
   */
  private readonly eventQueue: Array<{ run: () => Promise<void>; cancel: () => void }> = []
  private eventsActive = 0
  private drainingEvents = false
  /**
   * 「因为句柄不足而探不到」的路径 → 已重试次数。
   *
   * 这类失败与文件本身无关，重放事件是对的；但要有个上限，
   * 否则盘彻底断开时会永远重试下去。
   */
  private readonly fdEventRetries = new Map<string, number>()
  /** 任务表：key 是任务 id */
  private readonly tasks = new Map<string, TransferTask>()
  /** 相对路径 → 任务 id */
  private readonly taskIdByPath = new Map<string, string>()
  /** 任务表是否因上限淘汰过记录（供界面提示） */
  private tasksTruncated = false
  /**
   * 上一次整表扫描没找到任何可淘汰的任务。
   *
   * 极端情况：表里全是失败或进行中的任务（都不可淘汰）。
   * 没有这个标记的话，此后**每一次**插入都要把整个表扫一遍却一无所获——
   * 又是一种 O(n²)。标记住，等表再长大一个滞后量才重试。
   */
  private evictBlockedAt = -1
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
   *
   * ⚠️ 必须限容量：整盘首次同步时，几万个文件分布在几万个远端目录里，
   * 每个目录的完整文件列表都缓存进来就是几百万个字符串对象——
   * 实测主进程内存被它吃到 2GB+。这个缓存是「批处理临时加速」性质，
   * 不是永久索引，超过上限直接清空、下次按需重新 list 即可，
   * 只影响一点性能，不影响正确性。
   */
  private readonly remoteDirCache = new Map<string, Map<string, number>>()
  /**
   * remoteDirCache 的目录数上限。
   *
   * 超过就整体清空：清空比 LRU 逐条踢更简单，且这个缓存的生命周期
   * 本来就应该是一轮认领批处理，而不是跨整个会话。
   */
  private static readonly REMOTE_DIR_CACHE_LIMIT = 500
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
    // 排队中的事件直接放行，别让初始扫描的 await 悬着
    this.abortEvents()
    this.hashQueue.length = 0
    this.uploadQueue.length = 0
    this.downloadQueue.length = 0
    this.queuedPaths.clear()
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

  /**
   * 任务表各状态的数量。
   *
   * 为什么单独给一个方法，而不是让上层 `getTasks()` 再 `filter`：
   * getStats() 是界面高频调用的（每次任务变更、每次进度跳变都会问一次），
   * 而任务表上限 3600 条——每次都分配 3600 个对象的数组纯属浪费，
   * 在扫描期间（每秒问几次）这笔开销会叠加成可见的卡顿。
   */
  countTaskStates(): { queued: number; active: number; failed: number } {
    let queued = 0
    let active = 0
    let failed = 0
    for (const t of this.tasks.values()) {
      if (t.state === 'failed') failed++
      else if (t.state === 'queued') queued++
      else if (t.state === 'uploading' || t.state === 'hashing' || t.state === 'downloading') {
        active++
      }
    }
    return { queued, active, failed }
  }

  /** 正在传输的数量（不含排队待传的） */
  get inFlightCount(): number {
    return this.inFlight.size + this.inFlightDownloads.size
  }

  /**
   * 积压量：入口事件队列 + 哈希队列 + 上传队列 + 在途。
   *
   * 给「后台任务让路」用（远端对账据此决定要不要多睡一会儿）。
   * 取的是**数量**而不是百分比：积压为 0 时让路毫无意义——
   * 前台根本没活，让了也省不出什么。
   */
  get backlog(): number {
    return (
      this.eventQueue.length +
      this.hashQueue.length +
      this.uploadQueue.length +
      this.inFlight.size +
      this.inFlightDownloads.size
    )
  }

  /**
   * 这个路径当前是否正在传输（上传或下载）。
   *
   * 对账必须知道这件事：一个正在上传的文件，远端还没有（或只有半截），
   * 如果拿它跟清单比，会得出「远端缺失」或「大小不符」——**假差异**。
   * 假差异会触发重传，形成「上传 → 判缺失 → 重传」的死循环。
   *
   * 以前的做法是「等整个上传队列排空再对账」，在整盘场景下等于永远等不到
   *（几万个文件排队），只能超时报一句「结果可能不完整」。
   * 现在改成**跳过在途的那几个**，其余照常比对。
   */
  isTransferInFlight(relPath: string): boolean {
    return this.inFlight.has(relPath) || this.inFlightDownloads.has(relPath)
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
    // 用户手动清掉了一批记录 → 表里有了空位，解除「无处可淘汰」的锁定
    if (removed > 0) this.evictBlockedAt = -1
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
    /*
     * 所有本地事件先排队，再有上限地并发处理。
     *
     * 为什么必须排队：Watcher 的增量事件是「一批到达」的——用户把
     * 一个文件夹拷进同步根，或者 chokidar 在初始扫描后一次性吐出几千条，
     * 每条都会被立刻 `void handleEvent()` 掉。每个事件里要 stat、
     * 查清单、写库，几万条并发就是几万个同时打开的句柄，
     * 于是 EMFILE，而主进程的事件循环也被这些微任务堵住——
     * 用户看到的就是「点暂停没反应」。
     *
     * 队列保序（FIFO），所以同一路径的连续事件不会乱序，
     * 重命名识别依赖的先后关系也还在。
     */
    return this.scheduleEvent(() => this.processEvent(relPath, exists, isDir))
  }

  private async processEvent(relPath: string, exists: boolean, isDir: boolean): Promise<void> {
    if (!this.running) return
    const config = this.opts.getConfig()
    if (!config.syncRoot) return
    if (isExcluded(relPath, config.exclude)) return

    if (isDir) {
      await this.handleDirEvent(relPath, exists, config)
      return
    }

    if (!exists) {
      await this.confirmRemoval(relPath, config)
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
      /*
       * 句柄耗尽不是「这个文件不能同步」。
       *
       * probe 失败以前一律记一句「跳过」就完了——文件既没进队列，
       * 也不在清单里留痕，用户只会看到一大片「跳过」，
       * 而那些文件其实一个都没传。盘缓过来之后也不会自动补上，
       * 除非再手动扫一遍。这里改成冷却后重新排队。
       */
      if (probe.code && isResourceExhausted({ code: probe.code })) {
        this.retryEventAfterCooldown(relPath)
        return
      }
      if (probe.reason) this.opts.onLog?.('warn', `跳过 ${relPath}：${probe.reason}`)
      return
    }
    // 探到了：把这个路径的重试计数清掉
    this.fdEventRetries.delete(relPath)

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
  private recordSkip(relPath: string, reason: SkipReason, size: number): void {
    /*
     * 计数口径。
     *
     * 只有「内容判定」类的跳过才进「已跳过」统计——
     * 那是省下来的上行。`file_gone` 是文件自己没了，
     * 记进跳过数会让用户以为「同步跳过了 1165 个文件，省了带宽」，
     * 而实际原因是文件不在了。
     */
    if (reason === 'local_duplicate') this.skippedLocal++
    else if (reason !== 'file_gone') this.skippedRemote++

    const detail = this.skipDetail
    this.opts.onSkip?.(detail.total)
    this.opts.onSkipDetail?.(detail)

    /*
     * 「本地未变」不写任务表。
     *
     * 这是「已完成的内容变到已跳过」的根因：L1 快筛命中（内容与上次
     * 同步一致）时，文件根本不需要任何处理，但以前这里照样 touch 一条
     * `state: 'skipped'` 的任务——于是传输队列里原本「已完成」的那一行
     * 被覆盖成「已跳过」，用户以为同步把文件跳过去了。
     *
     * 另外三种跳过（远端同名同大小认领 / 哈希判重 / 文件消失）才有
     * 必要在任务表里留痕：它们是「有个文件要传，但被判定不用传」，
     * 用户需要看到这个结论与原因。「本地未变」连「要传」都算不上，
     * 属于常态，记进任务表只会把队列淹没。
     */
    if (reason !== 'local_duplicate') {
      this.touch(relPath, {
        state: 'skipped',
        category: 'skip',
        skipReason: reason,
        size,
        progress: 0,
        speed: 0,
        errorMsg: null
      })
      /*
       * 有结论的跳过写进同步历史（永久落库）。
       *
       * 「本地未变」不记：那是每轮扫描都命中的常态，六万个文件每轮
       * 都写一条会让历史表无限膨胀，且它本就不在任务表里留痕。
       * 其余三种（远端哈希判重 / 远端同名同大小认领 / 文件消失）
       * 都是「有个文件要处理、被判定不用传」，值得追溯。
       */
      this.opts.manifest.recordHistory({
        kind: 'skip',
        localPath: relPath,
        size,
        skipReason: reason
      })
    }

    // 跳过原因要说清楚：四种跳过的含义完全不同，
    // 用户需要知道「没传」是因为内容一样，还是因为远端已有同名同大小，
    // 还是因为文件在他眼皮底下消失了。
    // 第三种要额外点明「未校验内容」——那是弱认定，风险点在此。
    const reasonText =
      reason === 'local_duplicate'
        ? '内容与上次同步一致，未变化'
        : reason === 'remote_duplicate'
          ? '远端已有相同内容（按哈希判定）'
          : reason === 'file_gone'
            ? '本地文件已不存在（扫描后被删除或移走）'
            : '远端已有同名同大小文件，已认领为已同步（未校验内容）'
    this.opts.onLogDetail?.(reason === 'file_gone' ? 'warn' : 'info', `跳过 ${relPath}：${reasonText}`, {
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
      // 缓存容量兜底：超过上限整体清空，防止整盘同步时缓存无限膨胀吃光内存
      if (this.remoteDirCache.size >= Planner.REMOTE_DIR_CACHE_LIMIT) {
        this.remoteDirCache.clear()
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
  }): Promise<{ handled: boolean; reason?: string }> {
    const config = this.opts.getConfig()
    if (config.remoteScan.conflictPolicy !== 'local-wins') {
      /*
       * 返回**原因**而不是光一个 false。
       *
       * 这条差异是用户点了「覆盖远端」之后才走到这里的，什么都没发生
       * 却只回一句「请检查冲突策略与文件状态」——等于让用户自己猜。
       * 每个 false 分支都写清「为什么没动手」和「下一步该做什么」。
       */
      return {
        handled: false,
        reason: '冲突策略是「全部交由我确认」，自动修复不会动手；到「对账规则」把它改成「本地优先」'
      }
    }

    if (diff.kind !== 'missing_remote' && diff.kind !== 'size_mismatch') {
      if (diff.kind === 'remote_only') {
        this.opts.onLog?.('info', `远端多出文件（按策略不动作）：${diff.remotePath}`)
        return {
          handled: false,
          reason: '远端多出的文件按策略只记录、不回传；要合并到本地请点「下载」'
        }
      }
      return { handled: false, reason: '这类差异不需要回传本地版本' }
    }

    if (this.autoFixed >= config.remoteScan.autoFixLimit) {
      this.opts.onLog?.(
        'warn',
        `对账自动修复已达上限 ${config.remoteScan.autoFixLimit}，其余差异仅记录待人工确认`
      )
      return {
        handled: false,
        reason: `本轮自动修复已达上限 ${config.remoteScan.autoFixLimit} 条；下一轮对账会继续处理，也可先调高上限`
      }
    }
    if (!diff.localPath) {
      return { handled: false, reason: '这条差异没有对应的本地文件，无从回传' }
    }

    const absPath = absolutize(config.syncRoot, diff.localPath)
    const probe = await this.probe(absPath)
    if (!probe.ok) {
      return {
        handled: false,
        reason: `本地文件当前读不到${probe.reason ? `（${probe.reason}）` : ''}；若是网络盘掉线，接好后重新对账`
      }
    }

    // 同样受单文件上限约束：超限文件回流重传也只会失败
    if (this.isOversize(probe.size, config)) {
      const message = `文件超过单文件上限（${formatBytes(probe.size)} > ${formatBytes(
        config.quarkMaxFileBytes
      )}），已跳过`
      this.opts.manifest.setState(diff.localPath, 'error', { errorMsg: message })
      this.opts.onLog?.('error', `${message}：${diff.localPath}`)
      this.touch(diff.localPath, { state: 'failed', errorMsg: message, size: probe.size })
      return { handled: false, reason: message }
    }

    this.autoFixed++
    this.opts.onLog?.(
      'info',
      `对账发现${diff.kind === 'missing_remote' ? '远端缺失' : '内容不符'}，重新上传 ${diff.localPath}`
    )

    /*
     * **必须先清掉同步基准，再入队。**
     *
     * 这是「对账说远端丢了、上传却说重复」的根因：
     * 入队后哈希阶段会走 L2 判重（`isRemoteDuplicate`），
     * 它比的是 `synced_md5/sha1` —— 而那是**上次成功同步时**
     * 远端那份内容的哈希。远端被外部删掉后，这些字段还在，
     * 本地文件又没改过 → 两边哈希相等 → 判成「远端重复」→ 跳过上传。
     *
     * 于是每轮对账都发现差异、每轮都「重新上传」、每轮都被跳过，
     * 远端那份永远补不回来，而清单里还写着 synced。
     * 用户看到的是「对账说修好了，其实什么都没发生」。
     *
     * 清掉之后 L1、L2 都不再命中，文件会真正走一次上传。
     * 「强制重传」(`reupload`) 用的是同一条路。
     */
    this.opts.manifest.clearSyncBaseline(diff.localPath)

    this.enqueue({
      relPath: diff.localPath,
      absPath,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      reason: 'diff',
      attempts: 0
    })
    return { handled: true }
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
    // 在途的那一项由它自己的阶段收尾时清索引；这里清队列部分
    if (!this.inFlight.has(relPath)) this.queuedPaths.delete(relPath)
  }

  /** 从下载队列里摘掉指定路径的项 */
  private dropDownloaded(relPath: string): void {
    for (let i = this.downloadQueue.length - 1; i >= 0; i--) {
      if (this.downloadQueue[i].relPath === relPath) this.downloadQueue.splice(i, 1)
    }
  }

  // ── 内部：入队与流水线 ─────────────────────────────────

  /**
   * 把一次事件处理排进队列，返回「处理完」的 promise。
   *
   * 返回 promise 而不是 void，是为了让 Watcher 的初始扫描能做背压——
   * 它可以一次只推进若干个，而不是把五万个事件全推上来。
   */
  private scheduleEvent(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      /*
       * 已停止（暂停）时立刻放行。
       *
       * 不能只是「不处理」——调用方正 await 着这个 promise，
       * 不 resolve 的话暂停中的初始扫描会永远卡在这里，
       * 而界面上那个「暂停」按钮看起来就是没反应。
       */
      if (!this.running) {
        resolve()
        return
      }
      this.eventQueue.push({
        run: async () => {
          try {
            await task()
            resolve()
          } catch (err) {
            reject(err)
          }
        },
        // 停止时直接放行：调用方（初始扫描）正 await 着它，
        // 不 resolve 就会一直挂着，暂停按钮永远不返回
        cancel: () => resolve()
      })
      this.drainEvents()
    })
  }

  /** 丢弃排队中的事件（不处理，但让等待方继续） */
  private abortEvents(): void {
    for (const queued of this.eventQueue.splice(0)) queued.cancel()
  }

  private drainEvents(): void {
    if (!this.running) {
      this.abortEvents()
      return
    }
    if (this.drainingEvents) return
    this.drainingEvents = true
    try {
      while (
        this.running &&
        this.eventsActive < EVENT_CONCURRENCY &&
        this.eventQueue.length > 0
      ) {
        const next = this.eventQueue.shift()
        if (!next) break
        this.eventsActive++
        void next
          .run()
          .catch(() => {
            // 事件级错误由 engine 的 onEvent 收起并写日志，这里只负责计数
          })
          .finally(() => {
            this.eventsActive--
            this.drainEvents()
          })
      }
    } finally {
      this.drainingEvents = false
    }
  }

  private enqueue(item: QueueItem): void {
    /*
     * 同一路径已在队列中（或在途）就不重复排。
     *
     * 「在途」必须算上：它已经从队列 shift 出来了，
     * 只看队列数组会以为它没排过，于是同一个文件被排两次、
     * 上传两次，远端就多出一个 `xxx(1).ext`。
     *
     * 用 Set 判定而不是遍历两个数组：六万文件时后者的累计代价是
     * O(n²)，主线程会被它吃干净。
     */
    if (this.queuedPaths.has(item.relPath)) return
    if (this.inFlight.has(item.relPath)) return

    this.queuedPaths.add(item.relPath)
    this.hashQueue.push(item)
    /*
     * 入队时就把大小带上。
     *
     * 入队前已经 probe 过一遍，大小是已知的——不带的话任务表里
     * 这条记录的大小是 0，传输队列会显示成一整列「0 B」，
     * 用户会以为这些文件都是空的（而且分不清「已知是 0」和「还没读」）。
     */
    this.touch(item.relPath, { state: 'queued', size: item.size })
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
          /*
           * 大文件**不再串行**。
           *
           * 0.2.18 之前这里有一条「同一时间只允许一个大文件上传」的限制：
           * 当时上传走 fetch，undici 会把整个 body 缓冲进 external 内存，
           * 4 个 1GB 并发就是 5GB。那条限制是为了压住内存，代价是
           * **并发数设成 4 也只跑一条**——用户看到的正是「明明 4 线程，
           * 传输队列里却永远只有一条在上传」。
           *
           * 0.2.19 起上传改成 undici.request + Node 原生流，实测 500MB
           * 文件只占 25MB 外部内存（真流式），缓冲问题不复存在，
           * 这条串行限制就成了纯粹的性能损失，删掉。
           */
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
    /** 是否交棒给上传池。没交棒的项到此为止，索引要跟着清 */
    let keptInPipeline = false
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
        size: item.size,
        md5Prefix: hashes.md5.slice(0, 8),
        sha1Prefix: hashes.sha1.slice(0, 8),
        md5: hashes.md5,
        sha1: hashes.sha1
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
      keptInPipeline = true
    } finally {
      this.inFlight.delete(item.relPath)
      // 从这里出去的项（认领成功 / 判重跳过 / 取消）不会再被调度，
      // 索引必须同步清掉，否则同一个路径以后永远被当成「已排队」
      if (!keptInPipeline && !item.requeued) this.queuedPaths.delete(item.relPath)
    }
  }

  /** 上传阶段：单次 PUT 或分片，由 Transfer 内部按大小分流 */
  private async runUploadStage(item: QueueItem): Promise<void> {
    this.inFlight.set(item.relPath, item)
    try {
      await this.doUploadStage(item)
    } finally {
      this.inFlight.delete(item.relPath)
      // 失败重试 / 句柄冷却重试会把项重新塞回队列，那时索引要保留
      if (!item.requeued) this.queuedPaths.delete(item.relPath)
      item.requeued = false
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
      mode: item.size > config.singlePutMaxBytes ? 'multipart' : 'single',
      /*
       * 带上哈希前缀。
       *
       * 正常流程（经过 runHashStage）已经在 hashing 阶段写过了，
       * 这里 `?? existing` 会保留；但 recoverPending 恢复的任务
       * **没经过哈希阶段**，existing 里 md5Prefix 是空的——不在这里补，
       * 上传完成的任务在传输队列里就永远显示「—」。
       * 这正是用户反馈「类型上传、状态已完成，哈希却显示 —」的根因。
       */
      md5Prefix: item.hashes?.md5.slice(0, 8) ?? undefined,
      sha1Prefix: item.hashes?.sha1.slice(0, 8) ?? undefined,
      md5: item.hashes?.md5 ?? undefined,
      sha1: item.hashes?.sha1 ?? undefined
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
      // 入队时观测到的 mtime：Transfer 拿它判断哈希期间文件有没有被改写
      mtimeMs: item.mtimeMs,
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
      // 持久化到同步历史：这是「这个文件确实上传成功了」的权威追溯
      this.opts.manifest.recordHistory({
        kind: 'upload',
        localPath: item.relPath,
        remotePath,
        size: item.size
      })
      // 用带类别的回调，不要再调 onLog——两者都会写日志，会重复出一条
      this.opts.onLogDetail?.('info', `已上传 ${item.relPath} → ${remotePath}`, {
        category: 'upload',
        filePath: item.relPath,
        remotePath
      })
      return
    }

    /*
     * 句柄耗尽（发生在**上传**阶段）。
     *
     * 与哈希阶段同一个道理：这不是文件的问题，也不是网络的问题，
     * 是同一时刻打开的文件太多，整块盘的句柄被吃光了。
     * 走冷却重排队，不消耗重试次数——否则三次重试全撞在同一段
     * 句柄枯竭期里，文件就被判死了，而盘其实几秒后就恢复了。
     */
    if (isResourceExhaustedMessage(result.error) && this.requeueAfterFdCooldown(item)) {
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
      item.requeued = true
      this.queuedPaths.add(item.relPath)
      this.hashQueue.push(item)
      return
    }

    this.touch(item.relPath, {
      state: 'failed',
      attempts: item.attempts,
      errorMsg: result.error ?? '上传失败'
    })
    /*
     * 日志带上人话的病因。
     *
     * `connect ECONNREFUSED 192.168.50.2:5244` 对用户等于没说；
     * 前面加一句「服务端拒绝连接」，同一批失败的 160 多条日志
     * 才有可读的共同点。原始报错照样保留在末尾，方便排查。
     */
    const brief = explainError(result.error).brief
    this.opts.onLogDetail?.(
      'error',
      `上传失败（${brief}）${item.relPath}：${result.error ?? '未知原因'}`,
      {
        category: 'upload',
        filePath: item.relPath,
        remotePath
      }
    )
  }

  private handleFatal(item: QueueItem, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as NodeJS.ErrnoException | undefined)?.code

    /*
     * ① 句柄耗尽：不是这个文件的问题。
     *
     * 真实场景（诊断包实测）：同步根是一整块盘，5.8 万个文件。
     * 一次扫描里 118 次 EMFILE，把文件一个个标成「失败」——
     * 用户看到 556 个红叉，以为是文件坏了，实际上整块盘
     * 只是被打开的文件句柄压垮了，歇一会儿、少开几个就全好了。
     */
    if (isResourceExhausted(err) && this.requeueAfterFdCooldown(item)) return

    /*
     * ② 文件已经不在：扫描之后被删掉/移走了。
     *
     * 这不是失败——文件本来就不该上传。按「跳过」记录，
     * 让用户在队列里能看见它、并且知道原因；判成失败会让
     * 几百个红叉把真正需要处理的错误淹掉。
     */
    if (code === 'ENOENT') {
      this.opts.manifest.setState(item.relPath, 'deleted')
      this.recordSkip(item.relPath, 'file_gone', item.size)
      return
    }

    this.opts.manifest.setState(item.relPath, 'error', { errorMsg: message })
    this.touch(item.relPath, { state: 'failed', errorMsg: message })
    // 同样加一句人话病因：`UNKNOWN: unknown error, open 'Z:\...'`
    // 这类 Node 原文对用户没有任何信息量，但对排查有用，所以两者都留。
    const brief = explainError(message).brief
    this.opts.onLogDetail?.('error', `处理 ${item.relPath} 失败（${brief}）：${message}`, {
      category: 'upload',
      filePath: item.relPath
    })
  }

  /**
   * 句柄耗尽后的冷却重排队。
   *
   * 返回 true 表示「已安排重试，调用方不要继续按失败处理」。
   * 超过上限返回 false，让调用方走正常失败路径——盘真坏了的时候
   * 需要一个明确的终点，无限重试只会刷屏。
   *
   * 注意这里**不动 attempts**：重试次数是给「文件/网络有问题」用的，
   * 句柄不足跟这个文件毫无关系，记进去只会让它在盘恢复前就被判死。
   */
  private requeueAfterFdCooldown(item: QueueItem): boolean {
    item.fdRetries = (item.fdRetries ?? 0) + 1

    if (item.fdRetries > MAX_FD_RETRIES || !this.running) {
      const hint =
        '本机文件句柄持续不足，已停止重试。若同步根是网络盘/挂载盘，' +
        '请在盘恢复后点「开始同步」重试，或先把该盘重新连接。'
      this.opts.manifest.setState(item.relPath, 'error', { errorMsg: hint })
      this.touch(item.relPath, { state: 'failed', errorMsg: hint })
      this.opts.onLogDetail?.('error', `文件句柄持续不足，已停止重试：${item.relPath}`, {
        category: 'system',
        filePath: item.relPath
      })
      return true
    }

    const waitMs = Math.max(ioGovernor.remainingCooldownMs, FD_RETRY_FALLBACK_MS)
    this.touch(item.relPath, {
      state: 'queued',
      errorMsg: `本地盘句柄不足，${Math.max(1, Math.round(waitMs / 1000))} 秒后重试`
    })
    this.opts.manifest.setState(item.relPath, 'pending')
    this.opts.onLogDetail?.(
      'warn',
      `本机文件句柄已用尽，暂停 ${Math.max(1, Math.round(waitMs / 1000))} 秒后重试：${item.relPath}`,
      { category: 'system', filePath: item.relPath }
    )
    item.requeued = true
    setTimeout(() => {
      if (this.running && !item.canceled) {
        this.queuedPaths.add(item.relPath)
        this.hashQueue.push(item)
        void this.pump()
      }
    }, waitMs).unref?.()
    return true
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
    // 上一次累计接收量；用来把回调里的累计值换算成增量
    let lastReceived = 0
    /*
     * 速率的算法与上传保持一致：**滑动窗口的瞬时速率**。
     *
     * 「累计 ÷ 总耗时」只会算出一个平均值，前面慢一点就一路被拖着，
     * 显示的数字跟眼前实际在跑的带宽对不上。
     */
    let lastEmitAt = startedAt
    let lastEmitReceived = 0
    let smoothSpeed = 0
    /** 第一次回调立刻上报：进度条要马上动起来 */
    let firstEmit = true
    try {
      await this.opts.client.downloadTo(item.remotePath, item.absPath, {
        signal: controller.signal,
        onProgress: (received, total) => {
          if (item.canceled) {
            controller.abort()
            return
          }
          /*
           * 报**增量**字节，不是累计值。
           *
           * 累计值直接喂给总体速率统计的话，每个进度回调都会把
           * 已传的量再累加一遍，速率成倍虚高。
           */
          const delta = Math.max(0, received - lastReceived)
          lastReceived = received
          this.opts.onDownloadBytes?.(delta)

          const now = Date.now()
          const elapsed = now - lastEmitAt
          const done = total > 0 && received >= total
          /*
           * 节流：任务更新没必要每个数据块都推。
           *
           * 一个 5GB 的文件按 64KB 回调是八万次，每次都 touch 一遍
           * 等于把整个任务表翻新八万遍——渲染层跟不上，纯浪费。
           * 120ms 一次视觉上就是连续滚动；最后一块必须上报，
           * 否则进度会停在 99%。
           */
          if (!firstEmit && elapsed < 120 && !done) return

          const instant = elapsed > 0 ? (received - lastEmitReceived) / (elapsed / 1000) : 0
          smoothSpeed = smoothSpeed > 0 ? smoothSpeed * 0.6 + instant * 0.4 : instant
          lastEmitAt = now
          lastEmitReceived = received
          firstEmit = false

          this.touch(item.relPath, {
            state: 'downloading',
            category: 'download',
            progress: total > 0 ? Math.min(1, received / total) : 0,
            speed: smoothSpeed,
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
    // 持久化到同步历史：下载成功同样要能长期追溯
    this.opts.manifest.recordHistory({
      kind: 'download',
      localPath: item.relPath,
      remotePath: item.remotePath,
      size
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
   * 确认「本地已删除」是否属实，再决定要不要动远端。
   *
   * 为什么不能直接信 watcher 的 unlink 事件：
   *
   * 同步根是**网络盘**（SMB/WebDAV 挂载）时，盘瞬断、服务端重启、
   * 句柄超时都会让 chokidar 认为整棵树都被删了，一次性吐出上万条
   * unlink。实测事故：22:50:57 出现大批
   * `UNKNOWN: unknown error, stat 'Z:\...'`（盘读不到），两秒后
   * 24,647 个文件被标成「已删除」，其中 927 个的**远端文件被真的移进了
   * 回收站**——而本地文件一个都没少。
   *
   * 删除远端是不可逆的（进了回收站也要用户自己捞），所以这里宁可
   * 漏判一次删除，也绝不凭一个事件就把用户还在的文件从远端抹掉。
   *
   * 判定规则：
   * - stat 到文件 → 假事件，忽略，状态不动；
   * - ENOENT / ENOTDIR → 真的没了，正常走删除；
   * - 其它错误（UNKNOWN / EIO / EBUSY / EPERM …）→ 此刻盘读不到，
   *   **不判定**，也不改状态，等下一轮扫描再比对。
   */
  private async confirmRemoval(relPath: string, config: AppConfig): Promise<void> {
    const absPath = absolutize(config.syncRoot, relPath)
    try {
      const st = await stat(absPath)
      if (st.isDirectory()) {
        await this.handleDirEvent(relPath, true, config)
        return
      }
      // 文件还在——盘抖造成的假 unlink
      this.noteRemovalAnomaly('still_there', relPath, null)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.handleRemoval(relPath, config)
        return
      }
      // 盘此刻读不到：既不能当删除，也不能当存在
      this.noteRemovalAnomaly('unreadable', relPath, code ?? (err as Error)?.message ?? '未知')
    }
  }

  /**
   * 删除事件的异常聚合。
   *
   * 盘断开会一次吐出上万条事件，逐条写日志会把运行日志彻底刷掉——
   * 用户真正需要看到的是「盘可能掉了」这一条。这里 5 秒一窗口，
   * 每个窗口只落一条，带累计计数。
   */
  private removalAnomaly = { at: 0, still: 0, unreadable: 0, code: '', sample: '' }

  private noteRemovalAnomaly(kind: 'still_there' | 'unreadable', relPath: string, code: string | null): void {
    const now = Date.now()
    const a = this.removalAnomaly
    if (kind === 'still_there') a.still++
    else {
      a.unreadable++
      if (code) a.code = code
    }
    if (!a.sample) a.sample = relPath

    if (now - a.at < 5000) return
    a.at = now

    if (a.still > 0) {
      this.opts.onLogDetail?.(
        'warn',
        `收到删除事件但本地文件仍在，已忽略 ${a.still} 条（例如 ${a.sample}）——` +
          '同步根可能是网络盘，盘抖时会产生假删除事件',
        { category: 'system' }
      )
      a.still = 0
      a.sample = ''
    }
    if (a.unreadable > 0) {
      this.opts.onLogDetail?.(
        'warn',
        `本地盘读取失败（${a.code || '未知错误'}），${a.unreadable} 个删除事件无法确认，本次未处理——` +
          '请检查网络盘/挂载盘是否已掉线，恢复后重新扫描即可',
        { category: 'system' }
      )
      a.unreadable = 0
      a.code = ''
      a.sample = ''
    }
  }

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
   *
   * **异步**：整盘场景下待恢复文件可多达上千个，对每个文件做一次
   * 磁盘探测（existsSync / statSync）。在 SMB 网络盘上单次同步探测
   * 约 18ms，1000 个就是 18 秒——`startSync` 里同步调用它，
   * 主线程被锁死十几秒，「点开始同步卡顿」就是这么来的。
   *
   * 改成异步 + 分批让出事件循环后，恢复在后台进行，界面即时响应。
   */
  async recoverPending(): Promise<number> {
    const manifest = this.opts.manifest
    const config = this.opts.getConfig()
    const pending = manifest.listFilesByStates(['uploading', 'error', 'hashed', 'pending'])

    let recovered = 0
    let i = 0
    for (const entry of pending) {
      i++
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
       *
       * 用异步 stat 而不是 existsSync：SMB 网络盘上同步探测单次约 18ms，
       * 上千个待恢复文件就是十几秒的主线程阻塞（「开始同步卡顿」的根因）。
       */
      let exists = true
      try {
        await stat(absPath)
      } catch {
        exists = false
      }
      if (!exists) {
        manifest.setState(entry.localPath, 'error', { errorMsg: '本地文件已不存在' })
      } else {
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
            const st = await stat(absPath)
            reusable = st.size === entry.localSize && Math.abs(st.mtimeMs - entry.mtimeMs) < 1
          } catch {
            reusable = false
          }
        }

        if (this.queuedPaths.has(item.relPath)) continue
        this.queuedPaths.add(item.relPath)
        if (reusable && entry.md5 && entry.sha1) {
          item.hashes = { md5: entry.md5, sha1: entry.sha1, size: entry.localSize }
          this.uploadQueue.push(item)
        } else {
          this.hashQueue.push(item)
        }
        recovered++
      }

      // 每处理一批让出事件循环：不让出的话，界面在恢复期间一直卡着
      if (i % 50 === 0) await tick()
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
    /** 失败时的 errno 码，供上层区分「句柄不足」与「文件真的没了」 */
    code?: string
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
      //
      // 走闸门：这是全流程里**调用最密**的文件操作（每个事件一次），
      // 不纳入限流的话，前面几处限得再严也白搭。
      const st = await ioGovernor.run(() => stat(absPath, { bigint: true }))
      return {
        ok: true,
        size: Number(st.size),
        mtimeMs: Number(st.mtimeMs),
        inode: st.ino > 0n ? st.ino.toString() : null
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { ok: false, reason: `文件被占用（${code}）`, code, size: 0, mtimeMs: 0, inode: null }
      }
      if (code === 'ENOENT') {
        return { ok: false, reason: '文件已不存在', code, size: 0, mtimeMs: 0, inode: null }
      }
      return { ok: false, reason: (err as Error).message, code, size: 0, mtimeMs: 0, inode: null }
    }
  }

  /**
   * 句柄耗尽导致探不到文件时，冷却后把这条事件重放一次。
   *
   * 为什么要重放而不是等下一轮扫描：下一轮可能是几小时后，
   * 期间这个文件既不在队列里、也不在清单里留痕，
   * 用户永远不会知道它没传上去。
   */
  private retryEventAfterCooldown(relPath: string): void {
    const tries = (this.fdEventRetries.get(relPath) ?? 0) + 1
    this.fdEventRetries.set(relPath, tries)

    if (tries > MAX_FD_RETRIES) {
      this.fdEventRetries.delete(relPath)
      this.opts.onLogDetail?.(
        'error',
        `文件句柄持续不足，暂时无法同步：${relPath}（盘的连接恢复后会重新扫描）`,
        { category: 'system', filePath: relPath }
      )
      return
    }

    const waitMs = Math.min(
      Math.max(ioGovernor.remainingCooldownMs, FD_RETRY_FALLBACK_MS) * tries,
      30_000
    )
    setTimeout(() => {
      if (this.running) void this.handleEvent(relPath, true)
    }, waitMs).unref?.()
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
      md5: patch.md5 !== undefined ? patch.md5 : (existing?.md5 ?? null),
      sha1: patch.sha1 !== undefined ? patch.sha1 : (existing?.sha1 ?? null),
      errorMsg: patch.errorMsg !== undefined ? patch.errorMsg : (existing?.errorMsg ?? null),
      attempts: patch.attempts ?? existing?.attempts ?? 0,
      /*
       * 进入终态时盖一个「完成时间」戳。
       *
       * 只在**首次进入终态**时记：一个任务可能先 done、再因为重试回到
       * queued，不该被旧的时间戳覆盖。重试重置（retryReset）时清掉，
       * 让它重新开始计时。
       */
      finishedAt:
        patch.retryReset === true
          ? undefined
          : isTerminal(nextState)
            ? (existing?.finishedAt ?? Date.now())
            : existing?.finishedAt
    }

    this.tasks.set(id, task)
    this.opts.onTask?.(task)
    this.evictIfOverflow()
  }

  /**
   * 任务表超过上限时淘汰旧记录。
   *
   * 三个要点：
   *
   * 1. **攒一批再淘汰**。一次只踢一条的话，每次插入都要扫一遍表，
   *    六万个文件就是六万次全表扫描。这里等到超出滞后量才动手，
   *    一次清回上限，均摊成本接近常数。
   *
   * 2. **只淘汰终态，且从最老的开始**。Map 的迭代序就是创建序，
   *    从头扫、遇到可淘汰的就删即可。失败与进行中的任务通过
   *    `isEvictable` 排除在外，永远不会被踢——丢掉失败的记录
   *    等于把用户要处理的问题藏起来。
   *
   * 3. **必须回报被删的 id**。渲染层那份数组不会自己缩，
   *    不同步的话两边表格会越差越远。
   *
   * 被淘汰的 done / skipped 已经写进了 sync_history（持久化），
   * 所以「从传输队列里消失」不再等于「记录丢失」——永久回看走同步历史页。
   */
  private evictIfOverflow(): void {
    if (this.tasks.size <= TASK_TABLE_LIMIT) return

    /*
     * 上一轮整表扫过、一个可淘汰的都没有 → 这次跳过。
     *
     * 表里全是失败/进行中的任务时会出现这种情况：它们都不能丢。
     * 不记住这个结论，往后每次插入都要白扫一遍整表。
     * 等表再长大一个滞后量，说明情况可能变了（有新任务进入了终态），
     * 那时再重试一次。
     */
    if (this.evictBlockedAt >= 0 && this.tasks.size < this.evictBlockedAt + TASK_EVICT_SLACK) {
      return
    }

    /*
     * 收集可淘汰项，分级排序：
     *
     * 淘汰的优先级从高到低：
     * 1. canceled —— 用户主动取消的，最不需要回看；
     * 2. skipped —— 数量最大（整盘「本地未变」都往这里堆），淘汰主力；
     * 3. done —— 用户最关心的「已完成」，放最后，且完成不久的有保护窗口。
     *
     * 以前直接按 Map 迭代序（入队序）从头删，但入队序 ≠ 完成序：
     * 一个排队很久才传完的文件，done 一写入就因为入队位置靠前而被
     * 立刻淘汰，用户看到「刚完成的内容凭空消失」。
     */
    const now = Date.now()
    const rank = (state: TransferTask['state']): number =>
      state === 'canceled' ? 0 : state === 'skipped' ? 1 : 2

    const evictable: Array<{ id: string; localPath: string; state: TransferTask['state']; finishedAt: number }> = []
    for (const [id, task] of this.tasks) {
      if (!isEvictable(task.state)) continue
      evictable.push({
        id,
        localPath: task.localPath,
        state: task.state,
        finishedAt: task.finishedAt ?? 0
      })
    }

    // 先按「类别优先级」，再按「完成时间升序」（最久的先删）
    evictable.sort((a, b) => rank(a.state) - rank(b.state) || a.finishedAt - b.finishedAt)

    let over = this.tasks.size - MAX_TASKS
    const evicted: string[] = []
    for (const item of evictable) {
      if (over <= 0) break
      // 保护窗口：只保护「刚完成的 done」，让用户来得及看到刚上传完的
      if (item.state === 'done' && item.finishedAt > 0 && now - item.finishedAt < EVICT_GRACE_MS) {
        continue
      }
      this.tasks.delete(item.id)
      // 路径索引必须一起清：留着它，同一路径再变更时会去找一个已删的 id
      if (this.taskIdByPath.get(item.localPath) === item.id) {
        this.taskIdByPath.delete(item.localPath)
      }
      evicted.push(item.id)
      over--
    }

    if (evicted.length === 0) {
      this.evictBlockedAt = this.tasks.size
      return
    }

    this.evictBlockedAt = -1
    this.tasksTruncated = true
    this.opts.onTasksEvicted?.(evicted)
  }

  /** 任务表是否因上限丢过记录 */
  get truncated(): boolean {
    return this.tasksTruncated
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
