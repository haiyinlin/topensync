import { app } from 'electron'
import { join } from 'path'
import { statSync } from 'fs'
import { Manifest } from './db/manifest'
import { OpenListClient } from './openlist/client'
import { Transfer } from './transfer/transfer'
import { Planner } from './planner/planner'
import { Reconciler } from './reconcile/reconciler'
import { Watcher, type WatchEvent } from './watcher/watcher'
import { absolutize, relativizeRemote } from './watcher/paths'
import { hashFile } from './hash/hashes'
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
  TransferTask
} from '@shared/types'

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
  onTransfer?: (task: TransferTask) => void
  onScan?: (scan: ScanRecord) => void
  onDiff?: (diff: DiffEntry) => void
  onConfig?: (config: AppConfig) => void
  onLog?: (entry: LogEntry) => void
  /** 连接自检结果变化时推送，渲染进程据此刷新顶栏与连接页 */
  onConnection?: (status: ConnectionStatus) => void
  /** 扫描/对账进度变化时推送 */
  onProgress?: (progress: ScanProgress) => void
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
   * 当前扫描/对账进度。
   *
   * 供首屏快照与统计使用；运行中的进度靠事件推送。
   */
  private progress: ScanProgress | null = null
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
    this.manifest = new Manifest(join(app.getPath('userData'), 'manifest.db'))
    const { openlist } = this.config
    this.client = new OpenListClient({
      baseUrl: openlist.baseUrl,
      username: openlist.username,
      password: openlist.password
    })
  }

  // ── 生命周期 ──────────────────────────────────────────

  async start(): Promise<void> {
    await this.ensureConnect()

    this.planner = this.buildPlanner()
    this.planner.start()

    // 恢复上次未完成的任务
    const recovered = this.planner.recoverPending()
    if (recovered > 0) {
      this.pushLog('info', `恢复未完成任务 ${recovered} 个`)
    }

    this.startWatcher()
    this.startReconciler()
  }

  stop(): void {
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
        const task = this.planner?.getTaskByPath(info.relPath)
        if (!task) return
        this.events.onTransfer?.({
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
      onTask: (t) => this.events.onTransfer?.(t),
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
      }
    })
  }

  private startWatcher(): void {
    if (!this.config.syncRoot) return
    this.watcher?.stop()

    this.watcher = new Watcher({
      root: this.config.syncRoot,
      exclude: this.config.exclude,
      onEvent: (e: WatchEvent) => {
        /*
         * 必须挂 catch。
         *
         * handleEvent 内部有多处可能抛：重命名窗口里把文件改完就删
         * → hashFile 读文件时 ENOENT；清单写入失败 → DB 错误。
         *
         * 异常从 async 函数里逃出变成未处理的 Promise 拒绝，
         * Node 的默认行为是**终止进程**——用户的应用就这么崩了，
         * 而且界面上什么都看不到。
         */
        void this.planner
          ?.handleEvent(e.relPath, e.type === 'upsert', e.isDir === true)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            this.pushLog('error', `处理本地变更失败 ${e.relPath}：${message}`)
          })
      },
      onReady: (count) => {
        this.localScannedCount = count
        this.lastLocalScanAt = Date.now()
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
      onError: (err) => this.pushLog('error', `监控出错：${err.message}`)
    })
    this.watcher.start()
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
        this.events.onDiff?.(diff)
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
      }
    })
    this.reconciler.start()
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
    }

    // 同步根变了 → 监控必须重建
    if (previousRoot !== this.config.syncRoot) {
      this.startWatcher()
    }
    return this.config
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

  async triggerScan(kind: ScanKind): Promise<void> {
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

    // 本地扫描：对**现有 watcher** 发起一次强制全量重扫。
    //
    // 以前这里是 startWatcher()——停掉旧实例再建一个新的。
    // 那条路走不通：chokidar 的 close() 是异步的，旧实例还没关完，
    // 新实例就在同一目录上起了，可能收不到初始事件；
    // 而且重建会把扫描计数复位，用户点完按钮看到的数字没变化，
    // 于是「点了没反应」。
    //
    // 现在直接调 watcher.rescan()：不重建，只重走一遍目录树。
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
    if (!this.watcher) {
      // 监控根本没在跑（暂停过、或目录刚设好）→ 起一个
      this.startWatcher()
      this.pushLog('info', '本地监控已启动，扫描交由目录监控接管', { category: 'system' })
      // 同样要回终态：起 watcher 不等于完成扫描，
      // 但界面不能因为「没有 progress 更新」而把按钮永远钉在「扫描中」。
      this.pushProgress({
        kind: 'local',
        running: false,
        done: 0,
        total: null,
        detail: '本地监控已启动'
      })
      return
    }
    /*
     * 进度：扫描期间持续汇报「已扫描 N 个文件」。
     *
     * 目录树事先数不出总数，所以用不确定态进度条 + 计数。
     * 但**必须有**——扫一个大目录要几十秒，没反馈就像卡死。
     */
    const finishProgress = this.beginProgress('local', '正在扫描本地目录…')
    try {
      const count = await this.watcher.rescan((done) => {
        this.pushProgress({
          kind: 'local',
          running: true,
          done,
          total: null,
          detail: `已扫描 ${done} 个文件`
        })
      })
      this.localScannedCount = count
      this.lastLocalScanAt = Date.now()
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
      this.pushLog('info', `本地重扫完成：共 ${count} 个文件`, { category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `本地重扫失败：${message}`, { category: 'system' })
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
    const diffs = this.manifest.listUnresolvedDiffs()
    const diff = diffs.find((d) => d.id === diffId)
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
      if (resolved) this.events.onDiff?.(resolved)
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
    const tasks = this.planner?.getTasks() ?? []
    const diffs = this.manifest.listUnresolvedDiffs()

    const active = tasks.filter((t) => t.state === 'uploading' || t.state === 'hashing').length
    const queued = tasks.filter((t) => t.state === 'queued').length
    const failed = tasks.filter((t) => t.state === 'failed').length

    return {
      synced: counts['synced'] ?? 0,
      queued,
      skipped: this.skippedThisRun,
      skippedLocal: this.skippedLocal,
      skippedRemote: this.skippedRemote,
      downloaded: this.downloadedCount,
      failed,
      active,
      openDiffs: diffs.length,
      paused: this.paused,
      totalFiles: Object.values(counts).reduce((a, b) => a + b, 0),
      localScan: {
        watching: this.watcher?.isWatching ?? false,
        lastScanAt: this.lastLocalScanAt,
        scannedCount: this.localScannedCount
      },
      remoteScan: {
        enabled: this.config.remoteScan.enabled,
        running: this.remoteScanRunning,
        lastScanAt: this.remoteLastScanAt,
        lastScanStatus: this.remoteLastStatus,
        scannedCount: this.remoteScannedCount,
        diffCount: this.remoteDiffCount,
        nextScanAt: this.config.remoteScan.enabled
          ? Date.now() + this.config.remoteScan.intervalHours * 3600_000
          : null
      },
      progress: this.progress
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

  listFiles(opts: { limit?: number } = {}): FileEntry[] {
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
    this.watcher?.stop()
    this.watcher = null
    this.reconciler?.stop()
    this.reconciler = null
    this.planner?.stop()
    this.pushLog('warn', '已暂停同步')
  }

  /** 恢复同步 */
  resume(): void {
    if (!this.paused) return
    this.paused = false
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
    this.startWatcher()
    this.startReconciler()
    this.pushLog('info', '已恢复同步')
  }

  get isPaused(): boolean {
    return this.paused
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
    this.events.onLog?.(entry)
  }

  /**
   * 推进度并推送。
   *
   * 扫描大目录树要几十秒，期间界面没反馈就像卡死——
   * 所以每一次进度变化都要推给渲染进程。
   */
  private pushProgress(progress: ScanProgress): void {
    this.progress = progress
    this.events.onProgress?.(progress)
  }

  /**
   * 开始一次带进度的操作。
   *
   * 返回一个收尾函数：调用它就把进度标记为结束并推一次。
   * 用 try/finally 保证异常路径下进度条也会收掉，
   * 否则界面会永远停在「扫描中」。
   */
  private beginProgress(kind: ScanKind, detail: string): () => void {
    this.pushProgress({ kind, running: true, done: 0, total: null, detail })
    return () => {
      this.pushProgress({ kind, running: false, done: 0, total: null, detail: '已完成' })
    }
  }
}
