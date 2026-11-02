import { app } from 'electron'
import { join } from 'path'
import { statSync, existsSync } from 'fs'
import { Manifest } from './db/manifest'
import { OpenListClient } from './openlist/client'
import { Transfer } from './transfer/transfer'
import { Planner } from './planner/planner'
import { Reconciler } from './reconcile/reconciler'
import { Watcher, scanLocalTree, type WatchEvent } from './watcher/watcher'
import { TaskBatcher } from './task-batcher'
import { absolutize, relativizeRemote } from './watcher/paths'
import { hashFile } from './hash/hashes'
import { ioGovernor, isResourceExhausted } from './io/governor'
import { loadConfig, normalizeConfig, saveConfig } from './config/store'
import { exportDiagnostics } from './diagnostics/export'
import type {
  AppConfig,
  AppSnapshot,
  AppStats,
  ConnectionStatus,
  DeepVerifyResult,
  DiffEntry,
  DiffResolution,
  FileEntry,
  LogEntry,
  LogMeta,
  ScanKind,
  ScanProgress,
  ScanRecord,
  ScanStatus,
  TaskBatch,
  TransferSpeed,
  TransferTask
} from '@shared/types'

/**
 * 任务推送的合并窗口。
 *
 * 80ms 约等于 12 帧推一次：进度条与状态切换看起来依旧跟手，
 * 但六万个文件的推送次数从「六万次」降到「数千次」量级。
 * 再长（比如 300ms）就会明显感觉按钮和进度条「慢半拍」。
 */
const TASK_FLUSH_MS = 80

/**
 * 扫描进度的节流窗口。
 *
 * 进度文字是「已扫描 N 个文件」，用户不需要看到每一跳。
 * 120ms 跳一次数字，视觉上是连续滚动；而 IPC 次数下降两个数量级。
 */
const PROGRESS_THROTTLE_MS = 120

/**
 * 日志攒批的窗口。
 *
 * 日志比任务变化稀疏得多，但仍然可能一秒几千条（扫描时每个文件一条）。
 * 150ms 推一次，视觉上就是「一秒钟冒出十来批新行」，够实时了。
 */
const LOG_FLUSH_MS = 150

/** 攒到这么多条就不等窗口，立刻推 */
const LOG_BATCH_MAX = 200

/**
 * 差异推送的攒批窗口与单批上限。
 *
 * 150ms 一批：对账时用户看到的是「一片一片冒出来」，视觉上是连续的；
 * 单批 200 条是为了别让一次 IPC 的序列化把主线程占住——
 * 一万条差异一次性序列化要几百毫秒，正好卡在界面刷新之前。
 */
const DIFF_FLUSH_MS = 150
const DIFF_BATCH_MAX = 200

/**
 * 启动预热等待上限。
 *
 * 「开始同步」后本地首轮遍历可能要几十秒（整块盘六万文件），
 * 对账要等它跑完再起，但**不能无限等**：盘卡住时对账永远不跑，
 * 用户根本不知道发生了什么。超时就照常开跑，靠 isBusy 让路。
 */
const WARMUP_MAX_WAIT_MS = 5 * 60_000
/** 首轮扫描完成后，再等上传队列安静多久（超出就照常对账） */
const WARMUP_SETTLE_MS = 30_000

/** 速率采样窗口：1 秒内的字节数折算成每秒字节数 */
const SPEED_WINDOW_MS = 1000
/** 超过这么久没有新字节，当前速率归零（传输已经停了） */
const SPEED_IDLE_MS = 1500
/** 峰值只认可这个长度以上的窗口，避免几毫秒的突发刷出假峰值 */
const SPEED_MAX_MIN_WINDOW_MS = 250
/** 平均速率的时长兜底，防止首个文件几毫秒就跑完时算出天文数字 */
const SPEED_AVG_MIN_MS = 250
/** 实时速率的分母兜底：窗口太短会算出不可信的瞬时值 */
const SPEED_MIN_WINDOW_MS = 100

/**
 * 应用引擎：把四个进程内模块装配成一台能跑的机器。
 *
 *   Watcher ──┐
 *             ├─▶ Planner ─▶ Transfer ─▶ OpenList
 *   Reconciler┘
 *
 * 所有对外能力都从这里暴露，IPC 层只做参数转发，不含业务逻辑。
 */

export interface EngineEvents {
  /**
   * 任务批量变更。
   *
   * 注意是**一批**，不是一条。六万个文件逐个推就是六万次 IPC，
   * 渲染层每条还要遍历整个任务数组做替换——实测单条 31ms，
   * 累计三十多分钟，界面全程无响应。
   */
  onTransferBatch?: (batch: TaskBatch) => void
  onScan?: (scan: ScanRecord) => void
  onDiff?: (diff: DiffEntry) => void
  onConfig?: (config: AppConfig) => void
  /** 日志批量追加（不是逐条——一次扫描会给每个文件写一条） */
  onLogBatch?: (entries: LogEntry[]) => void
  /** 连接自检结果变化时推送，渲染进程据此刷新顶栏与连接页 */
  onConnection?: (status: ConnectionStatus) => void
  /** 扫描/对账进度变化时推送 */
  onProgress?: (progress: ScanProgress) => void
  /**
   * 差异**批量**推送。
   *
   * 一轮对账可能一次产生上万条差异。逐条推（以前的做法）意味着
   * 上万次 IPC + 渲染层上万次数组重建 + 上万次 getStats 往返，
   * 实测对账跑完界面直接卡死几十秒——用户以为程序挂了。
   *
   * 攒批之后推送次数与「批」成正比，与差异条数无关。
   */
  onDiffBatch?: (diffs: DiffEntry[]) => void
}

export class Engine {
  private config: AppConfig
  private readonly manifest: Manifest
  /**
   * 全应用**唯一**的 OpenList 客户端。
   *
   * 刻意做成 readonly：一旦允许重新赋值，Planner / Transfer / Reconciler
   * 手里握着的旧引用就会与它分叉——实测踩过这个坑：
   * 用户在界面改了连接地址后，「连接检查」用的是新地址（显示正常），
   * 而上传仍打向旧地址（日志里全是 connect ECONNREFUSED 127.0.0.1:5244，
   * 那是配置的默认值）。
   *
   * 改配置请走 `client.reconfigure()`，它会原地生效。
   */
  private readonly client: OpenListClient
  private planner: Planner | null = null
  private watcher: Watcher | null = null
  private reconciler: Reconciler | null = null
  private connection: ConnectionStatus = {
    configured: false,
    reachable: false,
    canRead: false,
    canWrite: false,
    error: null,
    checkedAt: null
  }
  private skippedThisRun = 0
  /**
   * 本地监控起不来的原因；null 表示正常。
   *
   * 单独存而不是靠「watcher 是不是 null」推断：
   * 「没设置目录」和「设了但目录不可达」在界面上必须说不同的话。
   */
  private watcherError: string | null = null
  /** 其中「本地内容未变」而跳过 */
  private skippedLocal = 0
  /** 其中「远端已有同样内容」而跳过 */
  private skippedRemote = 0
  /** 本次运行完成的下载数 */
  private downloadedCount = 0
  private lastLocalScanAt: number | null = null
  private localScannedCount = 0
  private remoteScanRunning = false
  private remoteLastScanAt: number | null = null
  private remoteLastStatus: ScanStatus | null = null
  private remoteScannedCount = 0
  private remoteDiffCount = 0
  /** 是否处于暂停状态 */
  private paused = false
  /**
   * 传输速率统计（上传 + 下载合计）。
   *
   * 三个数各有各的用处：
   * - current：此刻的速率，看有没有卡住
   * - max：本次运行的峰值，看线路能跑多快
   * - avg：本次运行的平均，看整体效率
   *
   * avg 用「累计字节 / 累计时长」算，而不是「各次速率的平均」——
   * 后者会让一个 1 KB 的文件和 1 GB 的文件等权，
   * 算出来的平均速率毫无参考价值。
   */
  private speedCurrent = 0
  private speedMax = 0
  private speedTotalBytes = 0
  /**
   * 第一个字节到达的时刻（0 = 本次运行还没传过任何数据）。
   *
   * 不能用引擎构造时刻做平均速率的起点：程序可能开着挂机两小时
   * 才开始同步，那样算出来的「平均」会被两小时的空闲摊薄成 0。
   */
  private speedStartedAt = 0
  /** 最近一次收到字节的时刻（用于判断是否已空闲） */
  private speedLastAt = 0
  /** 当前采样窗口的起点 */
  private speedWindowAt = 0
  private speedWindowBytes = 0
  /**
   * 当前扫描/对账进度。
   *
   * 两条通道**各存一份**，不共用一个对象。
   * 共用时对账一启动就把本地扫描的进度覆盖掉，
   * 本地扫描的状态再也回不来；而且一条通道的终态会误伤另一条。
   */
  private localProgress: ScanProgress | null = null
  private remoteProgress: ScanProgress | null = null
  /**
   * 任务推送攒批器。
   *
   * 所有任务变化先落这里（同 id 覆盖，天然取最新），
   * 攒够一个短窗口再整批推出去。六万个文件时，
   * 逐条推会让渲染层做六万次全表遍历，界面完全失去响应。
   */
  private readonly taskBatcher: TaskBatcher
  /**
   * 扫描进度的节流计时器，按通道各一个。
   *
   * 进度是**每个文件**报一次（`已扫描 N 个文件`）。
   * 不节流的话六万个文件就是六万次 IPC，而且渲染层每次收到都要
   * 刷一次统计（又一次往返），比任务推送还贵。
   */
  private readonly progressTimers = new Map<ScanKind, NodeJS.Timeout>()
  private readonly pendingProgress = new Map<ScanKind, ScanProgress>()
  /**
   * 日志攒批。
   *
   * 与任务推送同理：扫描时每个文件都会写一条日志，逐条推 IPC
   * 就是几万次跨进程调用 + 几万次渲染层数组重建。
   */
  private readonly pendingLogs: LogEntry[] = []
  private logFlushTimer: NodeJS.Timeout | null = null
  /**
   * 差异攒批缓冲。
   *
   * 与日志同理：对账一轮能产出上万条差异，逐条推 IPC 会把渲染层压死。
   */
  private readonly pendingDiffs: DiffEntry[] = []
  private diffFlushTimer: NodeJS.Timeout | null = null
  /**
   * 本地首轮扫描完成的通知口。
   *
   * 「开始同步」之后，整棵目录树正在被遍历（几万次 stat + 写库）。
   * 对账要是同时挂上去，两边抢同一个主线程，界面就完全没响应了。
   * 用一个 promise 让对账「等首轮扫描完再开跑」。
   *
   * null 表示当前没有等待者（未开始同步）。
   */
  private resolveLocalReady: (() => void) | null = null
  /**
   * 实时监听是否已降级为定时比对。
   *
   * 整盘 / 网络盘上 fs.watch 建不起来时会降级（见 watcher 的 WatchMode）。
   * 必须让界面知道：否则用户改完文件等不到同步，会以为同步坏了。
   */
  private watchMode: 'watch' | 'poll' = 'watch'
  /**
   * 是否已经开始同步。
   *
   * 程序启动后默认**不开始**——本地扫描、远端对账、上传队列
   * 都要用户点「开始同步」才启动。备份工具不该在启动瞬间就抢带宽。
   */
  private started = false
  /**
   * 首次连接自检的 promise。
   *
   * 首屏快照必须等它跑完：连接探测是异步的（要登录、要列目录），
   * 快照若抢先返回，界面就会先闪一个「未配置」——
   * 而那只是「还没探测完」，不是真实状态。
   */
  private connectStarted = false
  private firstConnect: Promise<void> = Promise.resolve()

  constructor(private readonly events: EngineEvents = {}) {
    this.config = loadConfig()
    this.applyIoLimit()
    this.manifest = new Manifest(join(app.getPath('userData'), 'manifest.db'))
    this.taskBatcher = new TaskBatcher(
      (batch) => this.events.onTransferBatch?.(batch),
      TASK_FLUSH_MS
    )
    const { openlist } = this.config
    this.client = new OpenListClient({
      baseUrl: openlist.baseUrl,
      username: openlist.username,
      password: openlist.password
    })
  }

  /**
   * 把文件句柄额度跟并发配置对齐。
   *
   * 公式 = 哈希并发 + 上传并发 + 2 的余量（事件处理与下载用）。
   * 上限 16：再多也不会更快——瓶颈在磁盘/网络的延迟，
   * 不在同时开了几个读流；但开多了会直接把驱动器句柄打光
   * （实测 5.8 万文件时整块盘 EMFILE，连 fs.watch 都建不起来）。
   */
  private applyIoLimit(): void {
    const cfg = this.config
    const want = Math.max(6, Math.min(16, cfg.hashConcurrency + cfg.uploadConcurrency + 2))
    ioGovernor.setLimit(want)
  }

  // ── 生命周期 ──────────────────────────────────────────

  async start(): Promise<void> {
    /*
     * 启动后**默认不开始同步**。
     *
     * 程序一打开就扫全盘、列远端树、抢带宽——这不是用户想要的：
     * 备份工具多半是开机自启的，用户可能只是路过看一眼状态。
     * 现在本地扫描、远端对账、上传队列都要用户点「开始同步」才启动。
     *
     * 但**连接自检照做**：那只是几十毫秒的登录探测，
     * 不产生任何流量，用户需要它来确认配置对不对。
     */
    this.started = false

    // 回读上次的扫描结果：重启后概览页不该显示「已扫描 0 个文件」
    this.restoreScanHistory()

    /*
     * 裁剪历史日志。
     *
     * 每次扫描每个文件写一条，六万个文件就是六万行。不裁剪的话
     * 日志表会一直涨，最终拖慢查询、撑大数据库文件。
     * 放在启动时做（而不是每次扫描后）：一次性收尾，不干扰同步过程。
     */
    const pruned = this.manifest.pruneLogs()
    if (pruned > 0) {
      this.pushLog('info', `已清理 ${pruned} 条历史日志（仅保留最近 10 万条）`)
    }

    /*
     * 每一段各自兜住异常。
     *
     * 以前是一个大 try 包住后面所有步骤：任何一步抛异常，
     * 后面的步骤全都不执行，而界面只会显示一句笼统的「引擎启动失败」。
     * 分段之后，某一步失败不影响其余部分照常工作。
     */
    try {
      await this.ensureConnect()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `连接自检失败：${message}`, { category: 'system' })
    }

    /*
     * 建对账器，但**不排期**。
     *
     * 「对账远端」是个只读操作（列远端树 + 比清单），跟同步开没开始无关，
     * 所以对账器要提前建好，用户点按钮就能用。
     * 定时对账与「启动即对账」仍然只在 startSync() 之后才排——
     * 那才是「启动默认关闭对账」要拦的东西。
     */
    try {
      this.startReconciler()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('warn', `对账器初始化失败：${message}`, { category: 'system' })
    }

    this.pushLog('info', '已就绪，点击「开始同步」后开始扫描与上传', { category: 'system' })
  }

  /**
   * 开始同步。
   *
   * 把本地监控、远端对账、上传调度一次性拉起来。
   * 界面上就是顶栏那个按钮。
   */
  startSync(): void {
    if (this.started && !this.paused) return
    this.started = true
    this.paused = false

    // 速率统计的口径是「本次运行」：重新开始时把上一轮的清零
    this.resetSpeedStats()

    /*
     * 先把「本地首轮扫描完成」的承诺挂上，再起 watcher。
     *
     * 对账要等这个承诺才开跑（见 startReconciler）。顺序不能反——
     * 先起 watcher 的话，onReady 可能在承诺建立之前就触发了，
     * 对账会一直等下去。
     */
    const localReady = this.armLocalReady()

    // 本地监控不依赖 OpenList 连接，先起来
    this.startWatcher()

    try {
      this.planner = this.buildPlanner()
      this.planner.start()

      // 恢复上次未完成的任务
      const recovered = this.planner.recoverPending()
      if (recovered > 0) {
        this.pushLog('info', `恢复未完成任务 ${recovered} 个`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `调度器启动失败：${message}`, { category: 'system' })
    }

    try {
      this.startReconciler()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `远端对账启动失败：${message}`, { category: 'system' })
    }

    // 预热结束后再跑「启动即对账」
    void this.runStartupReconcileAfterWarmup(localReady)

    this.pushLog('info', '已开始同步', { category: 'system' })
  }

  /** 挂一个「本地首轮扫描完成」的通知口，返回等待它的 promise */
  private armLocalReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveLocalReady = resolve
    })
  }

  /** 本地首轮扫描完成（= 可以开始对账了） */
  private markLocalReady(): void {
    const resolve = this.resolveLocalReady
    this.resolveLocalReady = null
    resolve?.()
  }

  /**
   * 预热结束后跑一轮「启动即对账」。
   *
   * 为什么不能跟「开始同步」同时开：这两个动作都会把主线程占满——
   * 本地首轮遍历是几万次 stat + 清单写入，对账是远端遍历 +
   * 逐条比对 + 差异落库。同时跑，界面在整个预热期都没有任何响应，
   * 用户点「暂停」都点不动（点击事件排在几千个微任务后面）。
   *
   * 串起来之后总耗时几乎不变（瓶颈本来就在 IO），
   * 但界面一直是活的，用户能随时暂停 / 看进度。
   */
  private async runStartupReconcileAfterWarmup(
    localReady: Promise<void> | null
  ): Promise<void> {
    const deadline = Date.now() + WARMUP_MAX_WAIT_MS
    try {
      // 1) 等本地首轮扫描跑完（没有可用的监控时等满上限就走）
      //    localReady 为 null 表示当前没有预热中的扫描（改配置触发的路径）
      if (localReady) {
        await Promise.race([
          localReady,
          new Promise<void>((resolve) => setTimeout(resolve, WARMUP_MAX_WAIT_MS))
        ])
      }
      if (!this.started || this.paused) return

      // 2) 再等上传队列安静一会儿：清单还在写的时候对账会读出假差异
      const settleDeadline = Math.min(deadline, Date.now() + WARMUP_SETTLE_MS)
      while (this.planner && !this.planner.isIdle && Date.now() < settleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!this.started || this.paused) return

      const res = await this.reconciler?.runStartup()
      if (res) {
        this.pushLog(
          'info',
          `启动对账完成：扫描 ${res.scannedFiles} 个文件，发现 ${res.diffCount} 处差异`,
          { category: 'reconcile' }
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('warn', `启动对账失败：${message}`, { category: 'reconcile' })
    }
  }

  /**
   * 把一次本地扫描的结果写进 scans 表。
   *
   * 为什么要专门记：本地扫描跟远端对账不同，它是**持续**的——
   * chokidar 就绪时报一次总数，之后增量事件一直在来。
   * 所以这里不是「每次新建一行」，而是：
   * - 第一次就绪时开一行（后续复用同一行更新计数）
   * - 手动重扫时把那一行更新成最新的数
   *
   * 这样重启后回读到的就是上次真实的文件数，概览页不会显示 0。
   */
  private recordLocalScan(count: number): void {
    try {
      const existing = this.manifest.lastScanId('local')
      if (existing === null) {
        const id = this.manifest.startScan('local', 'startup')
        this.manifest.finishScan(id, 'done', { scanned: count, changed: 0, errors: 0 })
      } else {
        this.manifest.updateLastScanCounts('local', { scanned: count })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('warn', `写入本地扫描记录失败：${message}`, { category: 'system' })
    }
  }

  /**
   * 从数据库回读上次的扫描结果。
   *
   * 扫描结果以前只存在内存里，程序一关就没了：
   * 用户重开应用看到「已扫描 0 个文件」「尚未执行对账」，
   * 以为上次根本没扫过——实际上上一轮扫了六万个。
   *
   * scans 表一直都在，只是没人往里写、也没人读。这一步把两头接上。
   */
  private restoreScanHistory(): void {
    try {
      const local = this.manifest.lastScan('local')
      if (local) {
        this.localScannedCount = local.scannedCount
        this.lastLocalScanAt = local.finishedAt ?? local.startedAt
      }
      const remote = this.manifest.lastScan('remote')
      if (remote) {
        this.remoteScannedCount = remote.scannedCount
        this.remoteLastScanAt = remote.finishedAt ?? remote.startedAt
        this.remoteLastStatus = remote.status
        // 差异数以数据库里的未处置差异为准（那才是当前真实待办）
        this.remoteDiffCount = this.manifest.countUnresolvedDiffs()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('warn', `读取历史扫描记录失败：${message}`, { category: 'system' })
    }
  }

  stop(): void {
    // 先把缓冲区里的任务推完再收摊：退出前那批状态是用户
    // 下次打开时最想看到的（哪些传完了、哪些还挂着）
    this.taskBatcher.flushNow()
    this.taskBatcher.dispose()
    // 日志同理：退出前最后几行往往是「为什么没传」的关键线索
    this.flushLogs()
    // 差异也是：这一批往往是「对账刚发现的」，丢了界面上就少几条
    this.flushDiffs()
    for (const kind of [...this.progressTimers.keys()]) this.clearProgressTimer(kind)

    this.watcher?.stop()
    this.watcher = null
    this.reconciler?.stop()
    this.reconciler = null
    this.planner?.stop()
    this.planner = null
    this.manifest.close()
  }

  /**
   * 保证连接自检只做一次，返回它的 promise。
   *
   * 窗口创建与引擎启动是并行的：渲染进程可能比 `start()` 更早要快照。
   * 谁先来谁发起探测，后来者复用同一个 promise，不会重复握手。
   */
  private ensureConnect(): Promise<void> {
    if (!this.connectStarted) {
      this.connectStarted = true
      this.firstConnect = this.connect()
    }
    return this.firstConnect
  }

  /** 等首次连接自检结束（首屏快照用它，避免显示过期的连接状态） */
  async whenReady(): Promise<void> {
    await this.ensureConnect()
  }

  /** 建立 OpenList 连接；配置不全或连不上时不阻断启动 */
  private async connect(): Promise<void> {
    const { openlist, remoteRoot } = this.config

    // 原地改配置，不新建实例。
    // Planner / Transfer / Reconciler 都持有这个 client 的引用，
    // 换实例会让它们继续用旧地址发请求——界面显示「已连接」，
    // 但上传打到了另一台服务器。
    this.client.reconfigure({
      baseUrl: openlist.baseUrl,
      username: openlist.username,
      password: openlist.password
    })

    // 「已配置」只描述 OpenList 连接信息本身（地址 + 账号）。
    // 以前把本地同步目录也算进来，于是用户填好了地址和账号、
    // 只是还没设本地目录时，界面一律显示「未配置」——
    // 看着像没填，其实填了。
    this.connection = {
      configured: !!openlist.baseUrl && !!openlist.username,
      reachable: false,
      canRead: false,
      canWrite: false,
      error: null,
      checkedAt: Date.now()
    }

    if (!this.connection.configured) {
      this.connection.error = '尚未填写 OpenList 连接信息'
      this.publishConnection()
      return
    }

    try {
      await this.client.login()
      this.connection.reachable = true
      // 登录成功就先报一次：界面立刻变成「已连接」，
      // 不用等目录探测跑完。
      this.publishConnection()
    } catch (err) {
      this.connection.error = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `OpenList 登录失败：${this.connection.error}`)
      this.publishConnection()
      return
    }

    // 远端根目录可能还不存在（第一次用这个路径）。
    // 主动建出来，否则 canRead/canWrite 永远是 false，
    // 用户也只会看到一个没法解读的 "object not found"。
    if (remoteRoot && remoteRoot !== '/') {
      try {
        if (!(await this.client.dirReady(remoteRoot))) {
          this.pushLog('info', `远端目录不存在，正在创建：${remoteRoot}`)
          await this.client.mkdirp(remoteRoot)
        }
      } catch (err) {
        // 建不出来就交给下面的读探测给结论，不在这里抛
        this.pushLog(
          'warn',
          `远端目录 ${remoteRoot} 不可用：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    try {
      await this.client.list(remoteRoot)
      this.connection.canRead = true
    } catch (err) {
      this.connection.error = err instanceof Error ? err.message : String(err)
    }

    // refresh:true 需要目标目录写权限，用它反推写权限
    try {
      await this.client.list(remoteRoot, { refresh: true })
      this.connection.canWrite = true
    } catch (err) {
      this.connection.canWrite = false
      if (!this.connection.error) {
        this.connection.error = err instanceof Error ? err.message : String(err)
      }
    }

    this.publishConnection()
  }

  /** 把当前连接状态推给渲染进程 */
  private publishConnection(): void {
    // 传副本：主进程后续还会改这个对象，
    // 直接传引用会让已推送出去的状态跟着变（IPC 之外还可能被别处持有）。
    this.events.onConnection?.({ ...this.connection })
  }

  private buildPlanner(): Planner {
    const transfer = new Transfer({
      client: this.client,
      manifest: this.manifest,
      // 取配置的方式与 Planner 一致：实时读，不吃构造时的快照
      getConfig: () => this.config,
      onProgress: (info) => {
        // 总体速率统计：按**增量**字节累计，与并发任务数无关
        this.recordSpeed(info.delta)
        const task = this.planner?.getTaskByPath(info.relPath)
        if (!task) return
        this.queueTask({
          ...task,
          state: 'uploading',
          chunksDone: info.chunksDone,
          chunksTotal: info.chunksTotal,
          progress: info.total > 0 ? info.sent / info.total : 0,
          speed: info.speed
        })
      }
    })

    return new Planner({
      manifest: this.manifest,
      transfer,
      client: this.client,
      getConfig: () => this.config,
      onTask: (t) => this.queueTask(t),
      /** 任务表因容量上限淘汰了旧记录 → 渲染层要同步删掉 */
      onTasksEvicted: (ids) => this.queueTaskRemoval(ids),
      onLog: (level, message) => this.pushLog(level, message),
      /*
       * 带类别的日志：上传/下载/跳过这三类都涉及具体文件，
       * 日志页要能按类别筛、按文件查历史。
       */
      onLogDetail: (level, message, meta) => this.pushLog(level, message, meta),
      onSkip: (count) => {
        this.skippedThisRun = count
      },
      onSkipDetail: (detail) => {
        this.skippedThisRun = detail.total
        this.skippedLocal = detail.local
        this.skippedRemote = detail.remote
      },
      onDownload: (count) => {
        this.downloadedCount = count
      },
      onDownloadBytes: (bytes) => {
        // 下载流量计入总体速率
        this.recordSpeed(bytes)
      }
    })
  }

  /**
   * 启动本地监控。
   *
   * 三处必须做对，否则用户会看到「配了目录却提示没设置」：
   *
   * ①**先确认目录真的在**。盘符根（`Z:/`）尤其危险：
   * 网络映射盘没连上、移动盘没插、盘符被系统重新分配，配置里那串
   * `Z:/` 就指向一个不存在的位置。以前这里不检查，chokidar 对不存在的
   * 路径不报错也不抛，只是静默什么都不产出——界面上只能显示
   * 「未在监控中（尚未设置同步目录）」，把用户的注意力引向错误的方向。
   *
   * ②**失败原因要留下来**，让界面能说清楚是「没设目录」还是「目录不可用」。
   *
   * ③**不许抛异常**。watcher 起不来不该让整个引擎跟着挂掉。
   */
  private startWatcher(): void {
    this.watcherError = null

    const root = this.config.syncRoot
    if (!root) {
      this.watcher = null
      // 没有可监控的目录 → 不存在「等首轮扫描」，直接放行对账
      this.markLocalReady()
      return
    }

    // 盘符根 / 映射盘：配置里的路径可能指向一个当前不可达的位置
    if (!isDirectoryAccessible(root)) {
      this.watcher = null
      this.watcherError = describeInaccessibleRoot(root)
      this.pushLog('error', `本地同步目录不可用：${this.watcherError}`, { category: 'system' })
      this.markLocalReady()
      return
    }

    /*
     * 直接同步整块盘时要提醒一句。
     *
     * 这不是限制用户，而是把代价说清楚：监听整块盘意味着
     * 每个目录都要占一个 watch 句柄，几千个目录之后句柄会紧张；
     * 网络映射盘尤其脆——实测整块盘同步时连 `fs.watch` 都会报
     * `EMFILE: too many open files, watch ...`。
     * 挑一个具体目录（哪怕是个大目录）比整块盘稳得多。
     */
    /*
     * 整盘根目录**直接**用定时比对，不去试实时监听。
     *
     * 不是保守，是实测结论：`fs.watch` 是每个目录一个句柄，
     * 整块盘上万个目录，chokidar 在遍历阶段就成片报
     * `EMFILE: too many open files, watch 'Z:\...'` 与 `scandir 'Z:\...'`——
     * 连一个 watch 都没建成，等于完全没有监控，而界面上显示「正在监控」。
     * 用户改了文件永远同步不上去，日志里只有几百条看不懂的 EMFILE。
     *
     * 直接走定时比对：不稳定但**确实在工作**，最多延迟一轮比对时间。
     * 子目录（哪怕很大）仍然走实时监听——那里句柄通常够用。
     */
    const isDriveRoot = /^[A-Za-z]:[\\/]?$/.test(root)
    if (isDriveRoot) {
      this.pushLog(
        'warn',
        `同步根是整块盘的根目录（${root.toUpperCase()}）：` +
          '实时监听需要为每个目录占一个文件句柄，整盘规模下建不起来，' +
          '已改用定时比对（文件改动最多延迟一轮比对被发现）。' +
          '想要秒级同步，请把同步目录改成具体的子目录（例如 Z:\\download）。',
        { category: 'system' }
      )
    }
    this.watcher?.stop()
    this.watcher = null

    try {
      this.watcher = new Watcher({
        root,
        exclude: this.config.exclude,
        forcePolling: isDriveRoot,
        onEvent: (e: WatchEvent) => {
          /*
           * 返回 promise，而不是 void。
           *
           * 初始扫描要拿它做背压：一次只推进若干条事件，上层消化完了
           * 再继续。以前这里 `void` 掉，五万个事件瞬间全推上来，
           * 每个事件又各开一个 stat —— 句柄当场打光（EMFILE）。
           *
           * 同时必须挂 catch：handleEvent 内部有多处可能抛（重命名窗口里
           * 文件被删 → hashFile 报 ENOENT；清单写入失败 → DB 错误）。
           * 异常从 async 函数逃出会变成未处理的 Promise 拒绝，
           * Node 的默认行为是**终止主进程**。
           */
          const planner = this.planner
          if (!planner) return Promise.resolve()
          return planner
            .handleEvent(e.relPath, e.type === 'upsert', e.isDir === true)
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              // 句柄耗尽会成批出现，逐条写日志只是把噪声放大几百倍
              if (!isResourceExhausted(err)) {
                this.pushLog('error', `处理本地变更失败 ${e.relPath}：${message}`)
              }
            })
        },
        onReady: (count) => {
          this.localScannedCount = count
          this.lastLocalScanAt = Date.now()
          // 落库：重启后概览页还能显示上次的真实数量，而不是 0
          this.recordLocalScan(count)
          // 首轮扫描完成 → 放行等待中的对账
          this.markLocalReady()
          this.events.onScan?.({
            id: 0,
            kind: 'local',
            trigger: 'event',
            startedAt: this.lastLocalScanAt,
            finishedAt: Date.now(),
            scannedCount: count,
            changedCount: 0,
            errorCount: 0,
            status: 'done',
            errorMsg: null
          })
        },
        onError: (err) => {
          this.watcherError = err.message
          this.pushLog('error', `监控出错：${err.message}`)
        },
        /*
         * 实时监听建不起来时自动降级为定时比对（见 watcher 的 WatchMode）。
         *
         * 这不是「功能退化」而是「从不可用变成可用」：整块盘 / 网络盘上
         * fs.watch 根本建不起来，以前的表现是界面显示「正在监控」，
         * 实际一条事件都收不到，文件改了永远同步不上去。
         */
        onModeChange: (mode) => {
          this.watchMode = mode
          if (mode === 'poll') {
            // 降级后不是错误状态：监控在工作，只是粒度不同
            this.watcherError = null
            this.pushLog(
              'warn',
              '实时监听不可用，已切换为定时比对：文件改动会在下一轮比对时被发现（默认 5 分钟一次）',
              { category: 'system' }
            )
          }
        }
      })
      this.watchMode = this.watcher.watchMode
      this.watcher.start()
    } catch (err) {
      this.watcher = null
      this.watcherError = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `本地监控启动失败：${this.watcherError}`, { category: 'system' })
      this.markLocalReady()
    }
  }

  private startReconciler(): void {
    this.reconciler?.stop()
    this.reconciler = null
    if (!this.connection.reachable) return

    this.reconciler = new Reconciler({
      client: this.client,
      manifest: this.manifest,
      // 实时取配置，不吃构造时的快照
      getConfig: () => this.config,
      onDiff: (diff) => {
        // 同样要挂 catch：未处理的 Promise 拒绝会终止主进程
        void this.planner?.handleDiff(diff).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.pushLog('error', `处理对账差异失败 ${diff.remotePath}：${message}`)
        })
      },
      /*
       * 差异落库后推给渲染进程。
       *
       * 这条链路以前是**断的**：EngineEvents 声明了 onDiff，
       * index.ts 也接好了 emit('diff:update')，
       * 但 Engine 从来没调用过它——于是 diff:update 永远不会发出去，
       * 对账页拿到的差异列表始终是空的。
       */
      onDiffRecorded: (diff) => {
        // 攒批：一轮对账可能上万条，逐条推会把渲染层压死
        this.queueDiff(diff)
      },
      onPull: (params) => {
        this.planner?.enqueueDownload(params)
      },
      /*
       * 探测本地是否真的存在某个文件，并带回大小与修改时间。
       *
       * 对账用它区分「远端有、清单没记」和「真的本地没有」：
       * 前者是状态没同步上（上传还在排队），不是差异。
       *
       * 带元信息是为了「同名 + 同大小」认领：两个条件都要成立才能认领，
       * 光知道「文件在」是不够的。
       */
      probeLocal: (relPath) => {
        if (!this.config.syncRoot) return null
        try {
          const st = statSync(absolutize(this.config.syncRoot, relPath))
          return { size: st.size, mtimeMs: st.mtimeMs }
        } catch {
          return null
        }
      },
      /*
       * 对账结束统一回写统计。
       *
       * 以前只有手动触发那条路径写统计，定时与启动触发的对账
       * 跑完什么都不留——概览页永远停在「尚未执行对账」。
       * 现在三条路径（手动 / 定时 / 启动）都走这一个回调。
       */
      onComplete: (res) => {
        this.remoteLastScanAt = Date.now()
        this.remoteLastStatus = res.error ? 'failed' : res.timedOut ? 'cancelled' : 'done'
        this.remoteScannedCount = res.scannedFiles
        this.remoteDiffCount = res.diffCount
        this.remoteScanRunning = false
        /*
         * 收掉对账进度条。
         *
         * 这里以前**漏了**：只有失败分支推了 running=false，
         * 成功路径没推——于是对账早就结束了，顶栏的进度条还挂着，
         * 按钮也一直显示「对账中…」。用户只能重启应用。
         *
         * 放在 onComplete 里而不是 triggerScan 里，
         * 是因为定时触发的对账也走这个回调——两条路径都会收尾。
         */
        this.pushProgress({
          kind: 'remote',
          running: false,
          done: res.scannedFiles,
          total: null,
          detail: res.error
            ? `对账失败：${res.error}`
            : res.timedOut
              ? '对账超时结束'
              : `对账完成，扫描 ${res.scannedFiles} 个文件，发现 ${res.diffCount} 处差异`,
          error: res.error ?? null
        })
        this.events.onScan?.({
          id: res.scanId,
          kind: 'remote',
          trigger: 'event',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scannedCount: res.scannedFiles,
          changedCount: res.diffCount,
          errorCount: res.error ? 1 : 0,
          status: this.remoteLastStatus,
          errorMsg: res.error ?? null
        })
      },
      /*
       * 对账进度：远端树可能很大，一轮要几十秒。
       *
       * 没有它，界面在整轮对账期间毫无反馈——
       * 用户点了「对账远端」，按钮转个圈就再也没动静，
       * 根本不知道程序是在跑还是已经卡死。
       */
      onProgress: (p) => {
        this.pushProgress({
          kind: 'remote',
          running: true,
          done: p.files,
          total: null,
          detail: `已扫描 ${p.dirs} 个目录 · ${p.files} 个文件`
        })
      },
      /*
       * 同步正在忙时对账主动让路。
       *
       * 两个后台任务抢同一个主线程，谁都不让的结果就是界面完全不响应。
       * 对账是「可以慢慢跑」的那一方，所以让它在分片之间多睡一会儿。
       */
      isBusy: () => this.isForegroundBusy()
    })

    /*
     * 对账器**建**与**排期**分开。
     *
     * 建：随时都建。改完地址/账号后必须马上有对账器，
     * 否则用户点「立即对账」会静默失败（这是修过的 P0）。
     *
     * 排期（定时器）：只在**已开始同步**时排。
     * 用户还没点「开始同步」，远端对账就自己跑起来了——
     * 那正是「启动默认关闭对账」要避免的事。
     *
     * 「启动即对账」那一轮交给 startSync 里的预热流程（deferStartup），
     * 不在这里立刻跑：点「开始同步」的瞬间本地正在遍历整棵目录树，
     * 两边同时跑会把主线程占满，界面卡到点不动按钮。
     */
    if (this.started) {
      this.reconciler.start({ deferStartup: true })
    }
  }

  /**
   * 前台是否正忙（本地扫描 / 事件处理 / 上传队列有积压）。
   *
   * 对账拿它决定要不要让路。只看「队列长度」不看「进度百分比」：
   * 队列短的时候让路没有意义，让了也省不出什么。
   */
  private isForegroundBusy(): boolean {
    const backlog = this.planner?.backlog ?? 0
    if (backlog > 0) return true
    return this.localProgress?.running === true
  }

  // ── 对外能力 ──────────────────────────────────────────

  getConfig(): AppConfig {
    return this.config
  }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const previousRoot = this.config.syncRoot
    const previousRemoteRoot = this.config.remoteRoot

    const next: AppConfig = {
      ...this.config,
      ...patch,
      openlist: { ...this.config.openlist, ...(patch.openlist ?? {}) },
      remoteScan: { ...this.config.remoteScan, ...(patch.remoteScan ?? {}) },
      retry: { ...this.config.retry, ...(patch.retry ?? {}) }
    }

    /*
     * 路径归一化：去掉首尾空白。
     *
     * 这不是洁癖——路径尾部的空格在界面上不可见，
     * 却会让文件传到「另一个目录」去。
     * 实测踩过：远端根 `/.../照片备份/公司 `（尾部空格），
     * 应用把整批照片传进了新建的「公司␣」目录，
     * 而用户原有的「公司」目录原封不动 → 夸克侧两个「公司」，文件传了两遍。
     */
    this.config = normalizeConfig(next)
    saveConfig(this.config)
    this.events.onConfig?.(this.config)
    // 并发度可能被改过，句柄额度要跟着走
    this.applyIoLimit()

    /*
     * 远端根变了 → 清单里已存的 remote_path 要跟着改前缀。
     *
     * 不改的话，下一轮对账会拿旧前缀去远端找文件，
     * 全部判「远端缺失」→ 整批重传（用户看到的就是「换了目录就重传一遍」）。
     */
    if (previousRemoteRoot !== this.config.remoteRoot) {
      const changed = this.manifest.rewriteRemoteRoot(
        previousRemoteRoot,
        this.config.remoteRoot
      )
      if (changed > 0) {
        this.pushLog('info', `远端根已变更，已改写清单中 ${changed} 条远端路径`)
      }
      // 远端快照是按旧根采集的，直接作废
      this.manifest.clearRemoteSnapshot()
    }

    /*
     * 顺序很重要：**先握手，再建对账器**。
     *
     * startReconciler() 里有这么一道闸：`if (!this.connection.reachable) return`
     * ——连不上就不建对账器（没连上，建了也只会一直失败）。
     *
     * 以前这里是反的：先建对账器、后握手。
     * 而「首次配置」这个最常见的场景，恰恰是**两个一起改**的
     * （地址、账号、密码、远端根、对账参数一次填完）。
     * 于是握手还没跑，对账器先被建——
     * 那时 connection.reachable 还是 false → 直接 return，**对账器根本没被创建**。
     *
     * 后果就是用户点「立即对账」毫无反应：
     * triggerScan 里 `if (!this.reconciler)` 命中，只写一条
     * 「尚未连接 OpenList，无法执行远端对账」的日志就结束了——
     * 而实际上连接是通的。
     */
    if (patch.openlist) {
      await this.connect()
    }

    // 远端相关配置变了 → 对账器要按新周期与策略重建
    // 连接信息变了也要重建：刚连上时之前建的（没建的）对账器还不存在
    if (patch.remoteScan || patch.remoteRoot !== undefined || patch.openlist) {
      this.startReconciler()
      /*
       * 改完远端相关配置后补跑一轮对账（以前 start() 里会立刻跑）。
       *
       * 现在 start() 只排定时器，启动那一轮由这里发起——
       * localReady 传 null：当前没有预热中的本地扫描，
       * 不能挂一个永远等不到通知的 promise。
       */
      if (this.started && !this.paused) {
        void this.runStartupReconcileAfterWarmup(null)
      }
    }

    // 同步根变了 → 监控必须重建（但只在已开始同步时才建）
    if (previousRoot !== this.config.syncRoot) {
      if (this.started) {
        this.startWatcher()
      } else {
        /*
         * 还没开始同步时也要检查目录可达性。
         *
         * 用户刚把目录填成 `Z:/`，而 Z 盘此刻没插上——
         * 界面必须立刻说「Z: 盘当前不可用」，
         * 而不是等到他点「开始同步」才反应，
         * 更不能显示那句误导性的「尚未设置同步目录」。
         */
        this.checkSyncRootAccessibility()
      }
    }
    return this.config
  }

  /**
   * 只检查同步目录的可达性，不启动监控。
   *
   * 与 startWatcher() 分开：未开始同步时也要能给出准确的诊断，
   * 但不能因为检查就起了监控（那等于偷偷开始同步）。
   */
  private checkSyncRootAccessibility(): void {
    const root = this.config.syncRoot
    if (!root) {
      this.watcherError = null
      return
    }
    if (isDirectoryAccessible(root)) {
      this.watcherError = null
      return
    }
    this.watcherError = describeInaccessibleRoot(root)
    this.pushLog('error', `本地同步目录不可用：${this.watcherError}`, { category: 'system' })
  }

  /**
   * 等上传队列排空。
   *
   * 远端对账的前置条件：上传没跑完时清单里没有对应记录，
   * 对账会把「本地有、远端也有、只是还没记进清单」的文件
   * 判成「仅远端存在」——假差异，照着提示操作还会误删远端文件。
   *
   * 上限 30 秒：上传卡住时不能让对账一直排队。
   */
  private async waitForUploadsToSettle(timeoutMs = 30_000): Promise<void> {
    const planner = this.planner
    if (!planner || planner.isIdle) return

    const pending = planner.pendingCount
    this.pushLog('info', `等待 ${pending} 个上传任务完成后再执行对账…`)

    const deadline = Date.now() + timeoutMs
    while (!planner.isIdle && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    if (!planner.isIdle) {
      this.pushLog(
        'warn',
        `等待上传完成超时（仍有 ${planner.pendingCount} 个任务在跑），对账结果可能不完整`
      )
    }
  }

  /**
   * 手动触发一次扫描 / 对账。
   *
   * **不启动同步。**
   *
   * 以前这里第一件事就是 `startSync()`——用户只是想看看目录里有什么，
   * 结果整个上传队列跑起来了。备份工具里「看一眼」和「开始传」是
   * 两个完全不同的意图，不能混在一个按钮里：
   *
   * - 扫描本地：只读巡检，数一遍文件、更新统计，不读清单、不上传
   * - 对账远端：列出远端树、和清单比对、记差异；同步没开始时
   *   差异只记录不自动处置（自动重传挂在 Planner 上，没启动就没有）
   *
   * 要真正开始传，用户得点「开始同步」。这是两件事，两个按钮。
   */
  async triggerScan(kind: ScanKind): Promise<void> {
    /*
     * 同一条通道已经在跑了就别再起一轮。
     *
     * 用户连点「对账远端」会起两个对账：两边同时列远端树、
     * 同时比对、同时写差异表——差异会被重复插入，
     * 而对账器自己也会抛「对账已在进行中」。
     */
    if (this.isScanning(kind)) {
      this.pushLog('warn', kind === 'remote' ? '对账已在进行中' : '本地扫描已在进行中', {
        category: 'system'
      })
      return
    }

    if (kind === 'remote') {
      if (!this.reconciler) {
        this.pushLog('warn', '尚未连接 OpenList，无法执行远端对账', { category: 'system' })
        // 同理：必须回终态，否则「对账中…」永远收不掉
        this.pushProgress({
          kind: 'remote',
          running: false,
          done: 0,
          total: null,
          detail: '尚未连接 OpenList，无法对账'
        })
        return
      }

      /*
       * 上传还在跑就先等它跑完。
       *
       * 两者互不知晓会出乱子：上传还没落库时清单里没有对应记录，
       * 对账会把「本地有、远端也有、只是还没记进清单」的文件
       * 判成「仅远端存在」——假差异。用户照着提示点「移入回收站」，
       * 就会把好好的远端文件删掉。
       *
       * 等不了太久：上传卡住时不能让对账一直排队。
       */
      await this.waitForUploadsToSettle()

      this.remoteScanRunning = true
      const startedAt = Date.now()
      /*
       * 进度从「等待上传完成」开始报。
       *
       * 对账之前要等上传队列排空，那段等待也是用户看得见的等待——
       * 不报进度的话，界面会从「点了对账」一直静默到对账真正开始。
       */
      this.pushProgress({
        kind: 'remote',
        running: true,
        done: 0,
        total: null,
        detail: '正在等待上传队列完成…'
      })
      this.events.onScan?.({
        id: 0,
        kind: 'remote',
        trigger: 'manual',
        startedAt,
        finishedAt: null,
        scannedCount: 0,
        changedCount: 0,
        errorCount: 0,
        status: 'running',
        errorMsg: null
      })
      try {
        const res = await this.reconciler.runNow()
        /*
         * 统计回写交给 Reconciler 的 onComplete 统一处理——
         * 手动、定时、启动三条路径共用同一套逻辑，
         * 不会再出现「只有手动那条路写统计」的分叉。
         */
        this.pushLog(
          'info',
          `远端对账完成：扫描 ${res.scannedFiles} 个文件，发现 ${res.diffCount} 处差异`,
          { category: 'reconcile' }
        )
      } catch (err) {
        this.remoteLastStatus = 'failed'
        this.remoteScanRunning = false
        const message = err instanceof Error ? err.message : String(err)
        this.pushLog('error', `远端对账失败：${message}`, { category: 'reconcile' })
        this.events.onScan?.({
          id: 0,
          kind: 'remote',
          trigger: 'manual',
          startedAt,
          finishedAt: Date.now(),
          scannedCount: 0,
          changedCount: 0,
          errorCount: 1,
          status: 'failed',
          errorMsg: message
        })
        // 失败也要收掉进度条，否则界面会永远停在「对账中」
        this.pushProgress({
          kind: 'remote',
          running: false,
          done: 0,
          total: null,
          detail: '对账失败'
        })
        return
      }
      this.remoteScanRunning = false
      // 对账结束，收掉进度条
      this.pushProgress({
        kind: 'remote',
        running: false,
        done: 0,
        total: null,
        detail: '对账完成'
      })
      return
    }

    /*
     * 本地扫描：只读巡检。
     *
     * 同步在跑 → 交给 Watcher.rescan()，事件进 Planner，该传的传（原有行为）。
     * 同步没跑 → 自己走一遍目录树，只数文件、更新统计。
     *   **不建 watcher**：整块盘有几千个目录，为了数一遍文件
     *   就把每个目录的 watch 句柄挂起来不值得，而且那正是句柄耗尽的来源之一。
     */
    if (!this.config.syncRoot) {
      this.pushLog('warn', '尚未设置本地同步目录', { category: 'system' })
      // 必须回一条终态：否则界面上的「扫描中…」永远收不掉。
      this.pushProgress({
        kind: 'local',
        running: false,
        done: 0,
        total: null,
        detail: '未设置本地同步目录，无法扫描'
      })
      return
    }

    /*
     * 进度：扫描期间持续汇报「已扫描 N 个文件」。
     *
     * 目录树事先数不出总数，所以用不确定态进度条 + 计数。
     * 但**必须有**——扫一个大目录要几十秒，没反馈就像卡死。
     */
    // 只有「同步真的在跑」时才把扫描事件喂给调度器；
    // 暂停中的 planner 会直接丢弃事件（那是刻意的），
    // 这时候走只读巡检反而更快、也更诚实
    const scanningWithPipeline = this.watcher !== null && this.planner?.isRunning === true
    const finishProgress = this.beginProgress('local', '正在扫描本地目录…')
    try {
      const count = scanningWithPipeline
        ? await this.watcher!.rescan((done) => {
            this.pushProgress({
              kind: 'local',
              running: true,
              done,
              total: null,
              detail: `已扫描 ${done} 个文件`
            })
          })
        : await scanLocalTree({
            root: this.config.syncRoot,
            exclude: this.config.exclude,
            onFile: (_rel, _abs, done) => {
              // 每 200 个报一次就够了：逐文件推 IPC 只是把渲染进程压死，
              // 数字跳得快也没人看得清
              if (done % 200 === 0) {
                this.pushProgress({
                  kind: 'local',
                  running: true,
                  done,
                  total: null,
                  detail: `已扫描 ${done} 个文件`
                })
              }
            }
          })

      this.localScannedCount = count
      this.lastLocalScanAt = Date.now()
      this.recordLocalScan(count)
      this.events.onScan?.({
        id: 0,
        kind: 'local',
        trigger: 'manual',
        startedAt: this.lastLocalScanAt,
        finishedAt: Date.now(),
        scannedCount: count,
        changedCount: 0,
        errorCount: 0,
        status: 'done',
        errorMsg: null
      })
      this.pushLog(
        'info',
        scanningWithPipeline
          ? `本地重扫完成：共 ${count} 个文件`
          : `本地扫描完成：共 ${count} 个文件（仅统计，未开始同步）`,
        { category: 'system' }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `本地扫描失败：${message}`, { category: 'system' })
    } finally {
      finishProgress()
    }
  }

  retryTransfer(taskId: string): void {
    this.planner?.retry(taskId)
  }

  cancelTransfer(taskId: string): void {
    this.planner?.cancel(taskId)
  }

  /**
   * 删除本地文件（批量）。
   *
   * 语义与用户在资源管理器里删文件一致：
   * 真删本地 → watcher 的 unlink 事件 → 远端按 deletePolicy 处理。
   *
   * 不直接动远端是刻意的：本地删了但远端留着，下次对账会把它
   * 判成「仅远端存在」又给拉回来，用户会以为删除没生效。
   */
  async deleteLocalFiles(relPaths: string[]): Promise<{ deleted: number; failed: number }> {
    if (relPaths.length === 0) return { deleted: 0, failed: 0 }
    const deleted = await this.planner?.deleteLocalFiles(relPaths)
    this.pushLog('info', `已删除本地文件 ${deleted ?? 0} 个，远端按删除策略处理`)
    return { deleted: deleted ?? 0, failed: relPaths.length - (deleted ?? 0) }
  }

  /**
   * 从传输队列移除任务记录（批量）。
   *
   * 只清界面记录，**不动文件**——用户在队列里看到的是历史快照，
   * 「删除」指的是「这条记录我不要看了」，不是「把这个文件删了」。
   * 真要删文件请去文件清单页。
   */
  removeTasks(taskIds: string[]): number {
    if (taskIds.length === 0) return 0
    const removed = this.planner?.removeTasks(taskIds) ?? 0
    this.pushLog('info', `已从队列移除 ${removed} 条任务记录`)
    return removed
  }

  /**
   * 删除远端文件（批量），并关闭对应差异。
   *
   * 委托给 Planner：它才有「建回收站目录」的能力，
   * 而 OpenList 的 move 要求目标父目录已存在，
   * 不建的话 move 会静默失败（文件还在原地），差异却已被标记成已处置。
   */
  async deleteRemoteFiles(
    targets: { remotePath: string; diffId?: number }[]
  ): Promise<{ deleted: number; failed: number }> {
    if (targets.length === 0) return { deleted: 0, failed: 0 }
    const res = (await this.planner?.deleteRemoteFiles(targets)) ?? {
      deleted: 0,
      failed: targets.length
    }
    this.pushLog(
      'info',
      `已删除远端文件 ${res.deleted} 个${res.failed > 0 ? `，失败 ${res.failed} 个` : ''}`
    )
    return res
  }

  /**
   * 处置一条对账差异。
   *
   * - uploaded / overwritten → 重新上传本地版本
   * - deleted_remote → 删远端
   * - pulled → 下载到本地
   * - ignored → 仅记录
   */
  async resolveDiff(diffId: number, resolution: DiffResolution): Promise<void> {
    // 按 id 单取：以前为了找一条而把整张差异表读进内存
    const diff = this.manifest.getDiff(diffId)
    if (!diff) return

    try {
      let acted = true
      switch (resolution) {
        case 'uploaded':
        case 'overwritten': {
          if (diff.localPath) {
            /*
             * handleDiff 现在返回「是否真的处理了」。
             *
             * 它有多个「什么都没做」的分支：冲突策略不是 local-wins、
             * 自动修复额度已满、本地文件读不到、超单文件上限。
             * 以前不管三七二十一都把差异标成「已处置」——
             * 用户以为远端已经用本地那份覆盖了，其实远端那份错的文件一直留着。
             */
            acted =
              (await this.planner?.handleDiff({
                kind: 'size_mismatch',
                localPath: diff.localPath,
                remotePath: diff.remotePath
              })) ?? false
          }
          break
        }
        case 'deleted_remote': {
          await this.client.remove([diff.remotePath])
          break
        }
        case 'pulled': {
          await this.pullRemote(diff)
          break
        }
        case 'ignored':
        default:
          // 「忽略」本身就是处置：明确表示「这条差异我知道了，不处理」
          break
      }

      if (!acted) {
        this.pushLog(
          'warn',
          `差异未实际处理，保持待处置状态：${diff.remotePath}（请检查冲突策略与文件状态）`
        )
        return
      }

      const resolved = this.manifest.resolveDiff(diffId, resolution)
      this.manifest.log('info', `差异已处置：${diff.remotePath} → ${resolution}`)
      /*
       * 处置完要把这一行从渲染进程的差异列表里撤掉。
       *
       * 以前这里什么都不推，界面上的那一行就永远留着——
       * 用户点「下载到本地」或「忽略」之后，行还在，
       * 看起来像操作没生效（其实远端已经处理过了），
       * 用户会反复点。
       *
       * 推的是**已处置**的完整条目（resolvedAt 非空），
       * 渲染层据此把它从列表里撤掉。
       */
      if (resolved) this.queueDiff(resolved)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `差异处置失败 ${diff.remotePath}：${message}`)
    }
  }

  /**
   * 把远端文件下载到本地同步目录。
   *
   * 走 Planner 的下载队列，这样它在传输队列里是一条
   * 「下载」类别的任务——有进度、能取消、能重试，
   * 而不是一次看不见摸不着的后台动作。
   *
   * 路径推导：`remote_only` 差异的 localPath 可能是空的
   * （旧数据），这时用「远端路径相对远端根」反推本地相对路径。
   */
  private async pullRemote(diff: DiffEntry): Promise<void> {
    const relPath = diff.localPath ?? relativizeRemote(this.config.remoteRoot, diff.remotePath)
    if (!relPath) {
      throw new Error('该差异没有对应的本地路径，无法下载')
    }
    if (!this.planner) {
      throw new Error('同步引擎未运行，无法下载')
    }

    this.planner.enqueueDownload({
      relPath,
      remotePath: diff.remotePath,
      size: diff.remoteSize ?? 0
    })
    this.pushLog('info', `已排入下载队列：${diff.remotePath} → ${relPath}`)
  }

  /**
   * 深度校验（批量）：把远端文件拉回来重算哈希，与本地比对。
   *
   * 为什么需要这道口子：认领（adoptByNameAndSize）只比对「文件名 + 大小」，
   * **不读内容**。它能挡住整批重传，但代价是
   * 「同名同大小、内容其实不同」会被当成已同步——
   * 本地那份等于没备份，而且从界面上看不出来。
   *
   * 深度校验就是那个缺口的后悔药：把远端那份下载下来重算 md5/sha1，
   * 一致就把结论从弱认定升级成 `verify_level='hash'`，
   * 同时把远端那份内容的哈希写进 synced_md5/synced_sha1——
   * 从这一刻起 L2 哈希判重才真正可用。
   *
   * 流量成本与文件大小成正比，所以受 `verifyHashMaxBytes` 限制：
   * 超过上限的只比大小、明确标为「跳过」——
   * 绝不能因为「没做深度校验」就当作通过，那等于没校验。
   */
  async verifyRemoteFiles(relPaths: string[]): Promise<DeepVerifyResult> {
    const result: DeepVerifyResult = {
      checked: 0,
      matched: 0,
      mismatched: 0,
      skipped: 0,
      failed: 0,
      details: []
    }
    if (relPaths.length === 0) return result
    if (!this.config.syncRoot) return result

    const limit = this.config.verifyHashMaxBytes

    for (const relPath of relPaths) {
      const entry = this.manifest.getFile(relPath)
      if (!entry?.remotePath) {
        result.skipped++
        result.details.push({ localPath: relPath, ok: false, detail: '清单里没有远端路径，跳过' })
        continue
      }
      if (limit > 0 && entry.localSize > limit) {
        result.skipped++
        result.details.push({
          localPath: relPath,
          ok: false,
          detail: `超过深度校验上限（${limit} 字节），仅比大小`
        })
        continue
      }

      // 本地哈希：算出来的是「本地当前这份」的内容
      let localHashes: { md5: string; sha1: string; size: number }
      try {
        localHashes = await hashFile(absolutize(this.config.syncRoot, relPath))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.failed++
        result.details.push({ localPath: relPath, ok: false, detail: `读取本地文件失败：${message}` })
        continue
      }

      // 远端哈希：把远端那份下载下来重算
      let remoteHashes: { md5: string; sha1: string; size: number } | null
      try {
        remoteHashes = await this.client.hashRemote(entry.remotePath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.failed++
        result.details.push({ localPath: relPath, ok: false, detail: `深度校验失败：${message}` })
        continue
      }

      if (!remoteHashes) {
        result.failed++
        result.details.push({ localPath: relPath, ok: false, detail: '深度校验失败：无法下载远端文件' })
        continue
      }

      result.checked++

      const same =
        remoteHashes.size === localHashes.size &&
        remoteHashes.md5 === localHashes.md5 &&
        remoteHashes.sha1 === localHashes.sha1

      if (!same) {
        result.mismatched++
        const detail =
          `内容不一致：远端 md5=${remoteHashes.md5.slice(0, 8)} / ${remoteHashes.size} 字节，` +
          `本地 md5=${localHashes.md5.slice(0, 8)} / ${localHashes.size} 字节`
        result.details.push({ localPath: relPath, ok: false, detail })
        this.manifest.log('error', `深度校验未通过：${relPath}（${detail}）`)

        /*
         * 内容对不上就必须处理，否则「弱认定已同步」会一直挂着，
         * 而远端那份错的文件永远躺在那里。
         *
         * 默认「本地为准」→ 重新上传覆盖远端；
         * 「全部交由我确认」→ 只标成冲突，等用户自己处理。
         */
        if (this.config.remoteScan.conflictPolicy === 'local-wins') {
          await this.planner?.reupload(relPath)
        } else {
          this.manifest.setState(relPath, 'conflict', { errorMsg: '深度校验发现内容不一致' })
        }
        continue
      }

      result.matched++
      this.manifest.promoteToHashVerified(relPath, localHashes.md5, localHashes.sha1, remoteHashes.size)
      result.details.push({ localPath: relPath, ok: true, detail: '内容一致，已升级为哈希确认' })
    }

    this.pushLog(
      'info',
      `深度校验完成：校验 ${result.checked} 个，一致 ${result.matched}，不一致 ${result.mismatched}，跳过 ${result.skipped}`
    )
    return result
  }

  // ── 快照 ──────────────────────────────────────────────

  getStats(): AppStats {
    const counts = this.manifest.countByState()
    /*
     * 任务计数不经过 `getTasks()`：那个会分配一个最多 3600 条的对象数组，
     * 而 getStats 是界面高频调用的方法（扫描时每秒好几次）。
     */
    const taskCounts = this.planner?.countTaskStates() ?? { queued: 0, active: 0, failed: 0 }
    /*
     * 只取**数量**，不读整张差异表。
     *
     * getStats() 是界面高频调用的方法（任务变更、进度跳变都会问一次），
     * 以前每次都把上万条差异读成对象数组——对账跑完后界面整个卡住，
     * 就是这么来的。
     */
    const openDiffs = this.manifest.countUnresolvedDiffs()

    return {
      synced: counts['synced'] ?? 0,
      queued: taskCounts.queued,
      skipped: this.skippedThisRun,
      skippedLocal: this.skippedLocal,
      skippedRemote: this.skippedRemote,
      downloaded: this.downloadedCount,
      failed: taskCounts.failed,
      active: taskCounts.active,
      openDiffs,
      paused: this.paused,
      totalFiles: Object.values(counts).reduce((a, b) => a + b, 0),
      localScan: {
        watching: this.watcher?.isWatching ?? false,
        error: this.watcherError,
        root: this.config.syncRoot,
        lastScanAt: this.lastLocalScanAt,
        scannedCount: this.localScannedCount,
        /*
         * 监控模式。整盘 / 网络盘上实时监听建不起来时会降级为定时比对，
         * 界面上必须说清楚——否则用户改完文件等不到同步，
         * 会以为「同步坏了」而不是「要等下一轮比对」。
         */
        mode: this.watchMode
      },
      remoteScan: {
        enabled: this.config.remoteScan.enabled,
        running: this.remoteScanRunning,
        lastScanAt: this.remoteLastScanAt,
        lastScanStatus: this.remoteLastStatus,
        scannedCount: this.remoteScannedCount,
        diffCount: this.remoteDiffCount,
        /*
         * 定时对账只在「已开始同步」后才排期（见 startReconciler）。
         * 没开始时说「下次对账在 6 小时后」是在骗人——
         * 那个定时器根本没起来。
         */
        nextScanAt:
          this.started && !this.paused && this.config.remoteScan.enabled
            ? Date.now() + this.config.remoteScan.intervalHours * 3600_000
            : null
      },
      speed: this.getSpeedStats(),
      tasksTruncated: this.planner?.truncated ?? false,
      progress: {
        local: this.localProgress,
        remote: this.remoteProgress
      },
      started: this.started
    }
  }

  getSnapshot(): AppSnapshot {
    return {
      config: this.config,
      stats: this.getStats(),
      files: this.listFiles(),
      diffs: this.manifest.listUnresolvedDiffs(),
      tasks: this.planner?.getTasks() ?? [],
      logs: this.manifest.recentLogs(200),
      connection: this.connection
    }
  }

  listFiles(opts: { limit?: number; offset?: number } = {}): FileEntry[] {
    return this.manifest.listFiles(opts)
  }

  listDiffs(): DiffEntry[] {
    return this.manifest.listUnresolvedDiffs()
  }

  listTasks(): TransferTask[] {
    return this.planner?.getTasks() ?? []
  }

  recentLogs(limit = 200): LogEntry[] {
    return this.manifest.recentLogs(limit)
  }

  /** 清空运行日志（只清日志表，不动同步状态） */
  clearLogs(): number {
    const n = this.manifest.clearLogs()
    this.pushLog('info', `已清空 ${n} 条运行日志`)
    return n
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connection
  }

  /** 重新做一次连接自检 */
  async recheckConnection(): Promise<ConnectionStatus> {
    await this.connect()
    return this.connection
  }

  /**
   * 暂停同步。
   *
   * 停掉本地监控与远端对账定时器，但**保留清单与配置**——
   * 暂停不是退出，重启后未完成的任务照常恢复。
   */
  pause(): void {
    if (this.paused) return
    this.paused = true
    // 放行可能正在等待首轮扫描的预热流程（否则它会挂到超时）
    this.markLocalReady()
    this.watcher?.stop()
    this.watcher = null
    this.reconciler?.stop()
    this.reconciler = null
    this.planner?.stop()
    // 暂停时两条通道的进度都要收掉，否则界面上的进度条会挂着不消失
    this.pushProgress({
      kind: 'local',
      running: false,
      done: 0,
      total: null,
      detail: '同步已暂停'
    })
    this.pushProgress({
      kind: 'remote',
      running: false,
      done: 0,
      total: null,
      detail: '同步已暂停'
    })
    this.pushLog('warn', '已暂停同步')
  }

  /**
   * 恢复同步。
   *
   * 与 startSync() 走同一条路径：两者都是「把一切拉起来」，
   * 区别只是 startSync() 还要处理「从未开始过」的状态。
   */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.started = true
    this.planner = this.buildPlanner()
    this.planner.start()
    /*
     * 恢复待处理任务。
     *
     * 暂停时 `planner.stop()` 会清空三个队列——那些排在后面的
     * 几百个文件就此从内存里消失了。不重新捞回来的话，
     * 它们在清单里停在 pending，而本次会话再也不会处理它们。
     * 用户点「恢复」却什么都没发生，看起来就是「暂停把同步搞坏了」。
     */
    const recovered = this.planner.recoverPending()
    if (recovered > 0) {
      this.pushLog('info', `已恢复同步，重新排队 ${recovered} 个待处理文件`)
    }
    const localReady = this.armLocalReady()
    this.startWatcher()
    this.startReconciler()
    // 恢复后同样要等首轮扫描跑完再对账（理由见 startSync）
    void this.runStartupReconcileAfterWarmup(localReady)
    this.pushLog('info', '已恢复同步')
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** 是否已经开始同步（未开始 ≠ 已暂停） */
  get isStarted(): boolean {
    return this.started
  }

  /**
   * 导出诊断包，返回生成的文件路径。
   */
  async exportDiagnostics(): Promise<string> {
    const path = await exportDiagnostics(this, this.manifest)
    this.pushLog('info', `已导出诊断包：${path}`)
    return path
  }

  // ── 内部 ──────────────────────────────────────────────

  /**
   * 写一条日志并推给渲染进程。
   *
   * `meta` 携带类别与文件路径——没有它的话日志页只是一堆文字流水，
   * 用户问「这个文件为什么没传」时无从查起。
   */
  private pushLog(level: LogEntry['level'], message: string, meta?: LogMeta): void {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      message,
      category: meta?.category ?? 'system',
      filePath: meta?.filePath ?? null,
      remotePath: meta?.remotePath ?? null
    }
    this.manifest.log(level, message, meta?.fileId ?? null, meta?.remotePath ?? null, meta)

    /*
     * 攒批推送，不逐条推。
     *
     * 扫描六万个文件就给每个文件写一条日志（上传/跳过都有），
     * 逐条推就是六万次 IPC，渲染层每次还要重建日志数组。
     * 攒批后推送次数与「批」成正比。
     *
     * 攒到一定条数立刻推，避免一次扫描的日志全攒到结束才出现——
     * 用户盯着日志页时应该能持续看到新行。
     */
    this.pendingLogs.push(entry)
    if (this.pendingLogs.length >= LOG_BATCH_MAX) {
      this.flushLogs()
      return
    }
    if (this.logFlushTimer) return
    const timer = setTimeout(() => this.flushLogs(), LOG_FLUSH_MS)
    timer.unref?.()
    this.logFlushTimer = timer
  }

  /** 把攒下的日志整批推给渲染进程 */
  private flushLogs(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer)
      this.logFlushTimer = null
    }
    if (this.pendingLogs.length === 0) return
    const batch = this.pendingLogs.splice(0)
    this.events.onLogBatch?.(batch)
  }

  /**
   * 收下一条差异变化，攒批推送。
   *
   * 与任务推送同理：一轮对账可能一次产生上万条差异。逐条推意味着
   * 上万次 IPC、渲染层上万次全表重建、上万次 getStats 往返——
   * 实测对账刚跑完的那几秒界面完全卡死，用户以为程序挂了。
   */
  private queueDiff(diff: DiffEntry): void {
    this.pendingDiffs.push(diff)
    if (this.pendingDiffs.length >= DIFF_BATCH_MAX) {
      this.flushDiffs()
      return
    }
    if (this.diffFlushTimer) return
    const timer = setTimeout(() => this.flushDiffs(), DIFF_FLUSH_MS)
    timer.unref?.()
    this.diffFlushTimer = timer
  }

  /** 把攒下的差异整批推给渲染进程（单批不超过 DIFF_BATCH_MAX） */
  private flushDiffs(): void {
    if (this.diffFlushTimer) {
      clearTimeout(this.diffFlushTimer)
      this.diffFlushTimer = null
    }
    if (this.pendingDiffs.length === 0) return

    const batch = this.pendingDiffs.splice(0, DIFF_BATCH_MAX)

    if (this.events.onDiffBatch) {
      this.events.onDiffBatch(batch)
    } else if (this.events.onDiff) {
      // 兼容旧调用方（单条通道）
      for (const diff of batch) this.events.onDiff(diff)
    }

    // 还有剩的 → 立刻再排一批，别等下一个窗口
    if (this.pendingDiffs.length > 0) {
      const timer = setTimeout(() => this.flushDiffs(), 0)
      timer.unref?.()
      this.diffFlushTimer = timer
    }
  }

  /**
   * 推进度并推送。
   *
   * 扫描大目录树要几十秒，期间界面没反馈就像卡死——
   * 所以每一次进度变化都要推给渲染进程。
   */
  private pushProgress(progress: ScanProgress): void {
    // 按通道分流：两条通道各存各的，互不覆盖
    if (progress.kind === 'local') this.localProgress = progress
    else this.remoteProgress = progress

    /*
     * 终态**立刻推**，不等节流窗口。
     *
     * 终态决定界面上的按钮能不能恢复可点。晚 120ms 推出去，
     * 用户就会看到「扫描中…」多挂一会儿；更糟的是如果紧接着
     * 又起了下一轮扫描，节流器会把终态和新的运行态合并，
     * 终态直接丢失——进度条永远收不掉。
     */
    if (!progress.running) {
      this.clearProgressTimer(progress.kind)
      this.events.onProgress?.(progress)
      return
    }

    this.pendingProgress.set(progress.kind, progress)
    if (this.progressTimers.has(progress.kind)) return
    const timer = setTimeout(() => {
      this.progressTimers.delete(progress.kind)
      const pending = this.pendingProgress.get(progress.kind)
      this.pendingProgress.delete(progress.kind)
      if (pending) this.events.onProgress?.(pending)
    }, PROGRESS_THROTTLE_MS)
    // 定时器不该拖住进程退出
    timer.unref?.()
    this.progressTimers.set(progress.kind, timer)
  }

  private clearProgressTimer(kind: ScanKind): void {
    const timer = this.progressTimers.get(kind)
    if (timer) {
      clearTimeout(timer)
      this.progressTimers.delete(kind)
    }
    this.pendingProgress.delete(kind)
  }

  /**
   * 收下一个任务变化，攒批推送。
   *
   * 同一 id 在缓冲里天然合并——一个文件从 pending 走到 skipped，
   * 界面只需要看到最后那个状态，中间态推出去也是白推。
   */
  private queueTask(task: TransferTask): void {
    this.taskBatcher.push(task)
  }

  private queueTaskRemoval(ids: string[]): void {
    this.taskBatcher.remove(ids)
  }

  /** 某条通道当前是否正在跑 */
  private isScanning(kind: ScanKind): boolean {
    const p = kind === 'local' ? this.localProgress : this.remoteProgress
    return p?.running === true
  }

  /**
   * 开始一次带进度的操作。
   *
   * 返回一个收尾函数：调用它就把进度标记为结束并推一次。
   * 用 try/finally 保证异常路径下进度条也会收掉，
   * 否则界面会永远停在「扫描中」。
   *
   * 收尾时**保留最后一次的进度描述**（done 也保留），
   * 而不是硬写成「已完成」——用户看到的应该是
   * 「已扫描 128 个文件」这种有信息量的结果。
   */
  private beginProgress(kind: ScanKind, detail: string): (finalDetail?: string) => void {
    this.pushProgress({ kind, running: true, done: 0, total: null, detail })
    return (finalDetail?: string): void => {
      // pushProgress 已经把每次进度存进了对应的槽位，直接读回来即可
      const cur = kind === 'local' ? this.localProgress : this.remoteProgress
      this.pushProgress({
        kind,
        running: false,
        done: cur?.done ?? 0,
        total: cur?.total ?? null,
        detail: finalDetail ?? cur?.detail ?? '已完成'
      })
    }
  }

  /**
   * 记录一段传输流量，刷新速率统计。
   *
   * `bytes` 是这一段新增的字节数（不是累计值）。
   *
   * current 用**时间窗**算而不是「这一段 / 这一段的时长」：
   * 单次 PUT 的传输可能只有几十毫秒，用它自己的时长算出来的速率
   * 会是天文数字（几百 MB/s），而实际线路可能只有 5 MB/s。
   * 所以这里按 1 秒窗口累计，到窗口边界才结算一次速率。
   */
  private recordSpeed(bytes: number): void {
    if (bytes <= 0) return
    const now = Date.now()

    if (this.speedStartedAt === 0) {
      this.speedStartedAt = now
      this.speedWindowAt = now
    }
    this.speedLastAt = now
    this.speedTotalBytes += bytes
    this.speedWindowBytes += bytes

    /*
     * 窗口攒够 1 秒就结算一次瞬时速率。
     *
     * 注意这里**只是采样**：`speedCurrent` 的实时值在 `getSpeedStats()`
     * 里用「还没结算的窗口」估算。只靠结算点更新的话，
     * 一个几百 KB 的文件几秒钟就传完，窗口永远等不到关闭的时刻，
     * 界面上的当前速率与峰值会一直是 0——用户看到的就是「速率没生效」。
     */
    const windowMs = now - this.speedWindowAt
    if (windowMs >= SPEED_WINDOW_MS) {
      const instant = (this.speedWindowBytes * 1000) / windowMs
      this.speedCurrent = instant
      if (instant > this.speedMax) this.speedMax = instant
      this.speedWindowBytes = 0
      this.speedWindowAt = now
    }
  }

  /**
   * 速率快照。
   *
   * 三个数的口径：
   * - `current`：未结算窗口的即时估算，空闲超过 1.5 秒归零
   * - `max`：最长的那个 1 秒窗口的峰值（不足 250ms 的窗口不计，
   *   否则一个小文件从页缓存里瞬间读完就能刷出几百 MB/s 的假峰值）
   * - `avg`：累计字节 ÷ **有流量的那段时长**，不含空闲
   */
  private getSpeedStats(): TransferSpeed {
    const now = Date.now()
    const active = this.speedStartedAt > 0 && this.speedLastAt > 0
    const activeMs = active ? Math.max(1, this.speedLastAt - this.speedStartedAt) : 0
    const idleMs = active ? now - this.speedLastAt : Number.POSITIVE_INFINITY

    const rawWindowMs = this.speedWindowAt > 0 ? Math.max(1, now - this.speedWindowAt) : 0
    /*
     * 分母兜底 100ms。
     *
     * 单次 PUT 只会在传完之后报一次进度，那时窗口可能才开了几十毫秒。
     * 一个 10 KB 的文件除以 3ms 会算出 3 MB/s——数字本身没错，
     * 但那是「从页缓存读出来」的速度，不是线路速度。
     * 兜底后这类极短窗口给出的是保守估计，不会跳出一个不可信的数。
     */
    const windowMs = rawWindowMs > 0 ? Math.max(SPEED_MIN_WINDOW_MS, rawWindowMs) : 0
    const live =
      this.speedWindowBytes > 0 && windowMs > 0 ? (this.speedWindowBytes * 1000) / windowMs : 0

    let current = 0
    if (idleMs <= SPEED_IDLE_MS) {
      // 取结算值与实时估算里较大的那个：结算值不会被窗口重置瞬间打回 0
      current = Math.max(this.speedCurrent, live)
    }

    let max = this.speedMax
    if (this.speedWindowBytes > 0 && rawWindowMs >= SPEED_MAX_MIN_WINDOW_MS) {
      max = Math.max(max, live)
    }

    return {
      current: Math.round(current),
      max: Math.round(max),
      // 分母兜底 250ms：首个文件只有几毫秒时，除法会算出天文数字
      avg: active ? Math.round((this.speedTotalBytes * 1000) / Math.max(SPEED_AVG_MIN_MS, activeMs)) : 0,
      totalBytes: this.speedTotalBytes,
      elapsedMs: activeMs
    }
  }

  /**
   * 清零速率统计。
   *
   * 口径是「本次同步运行」：用户重新点「开始同步」时，
   * 上一次运行的平均速率不该还在里面。
   */
  private resetSpeedStats(): void {
    this.speedCurrent = 0
    this.speedMax = 0
    this.speedTotalBytes = 0
    this.speedStartedAt = 0
    this.speedLastAt = 0
    this.speedWindowAt = 0
    this.speedWindowBytes = 0
  }
}

/**
 * 判断本地同步目录当前是否可达。
 *
 * 盘符根（`Z:/`）是最容易踩的一种：网络映射盘没连上、移动盘没插上、
 * 盘符被系统重新分配给别的设备，配置里那串路径就指向一个
 * **不存在或不对**的位置。这种情况下 chokidar 不会报错——
 * 它只是静默地什么都不产出，用户在界面上看到的却是
 * 「尚未设置同步目录」，然后去反复改设置，永远找不到原因。
 *
 * 所以在起监控之前先探一次，把「目录不可用」这件事说清楚。
 */
function isDirectoryAccessible(root: string): boolean {
  try {
    if (!existsSync(root)) return false
    return statSync(root).isDirectory()
  } catch {
    // 权限不足、路径过长、盘符未就绪——一律按「不可达」处理
    return false
  }
}

/**
 * 把「目录不可达」翻译成人能看懂的一句话。
 *
 * 注意区分两种情况：
 * - 路径**就是**盘符根（`Z:/`）→ 说「盘不可用」，用户该去查盘符/网盘
 * - 路径是某个子目录 → 说「目录不存在或不可访问」，用户该去查路径
 *
 * 以前这里只用 `/^([A-Za-z]):/` 判断，于是 `C:\Users\me\Desktop\missing`
 * 也被说成「C: 盘当前不可用」——完全指错了方向。
 */
function describeInaccessibleRoot(root: string): string {
  const driveRoot = /^([A-Za-z]):[\\/]?$/.exec(root.trim())
  if (driveRoot) {
    return `${driveRoot[1].toUpperCase()}: 盘当前不可用（未映射、未插入或无访问权限）`
  }
  return `目录不存在或不可访问：${root}`
}
