import { app } from 'electron'
import { join } from 'path'
import { Manifest } from './db/manifest'
import { OpenListClient } from './openlist/client'
import { Transfer } from './transfer/transfer'
import { Planner } from './planner/planner'
import { Reconciler } from './reconcile/reconciler'
import { Watcher, type WatchEvent } from './watcher/watcher'
import { loadConfig, saveConfig } from './config/store'
import type {
  AppConfig,
  AppSnapshot,
  AppStats,
  ConnectionStatus,
  DiffEntry,
  DiffResolution,
  FileEntry,
  ScanKind,
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
  onLog?: (entry: { ts: number; level: 'info' | 'warn' | 'error'; message: string }) => void
}

export class Engine {
  private config: AppConfig
  private readonly manifest: Manifest
  private client: OpenListClient
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
  private lastLocalScanAt: number | null = null
  private localScannedCount = 0
  private remoteScanRunning = false
  private remoteLastScanAt: number | null = null
  private remoteLastStatus: ScanStatus | null = null
  private remoteScannedCount = 0
  private remoteDiffCount = 0

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
    await this.connect()

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

  /** 建立 OpenList 连接；配置不全或连不上时不阻断启动 */
  private async connect(): Promise<void> {
    const { openlist, syncRoot, remoteRoot } = this.config

    this.client = new OpenListClient({
      baseUrl: openlist.baseUrl,
      username: openlist.username,
      password: openlist.password
    })

    this.connection = {
      configured: !!syncRoot && !!openlist.baseUrl && !!openlist.username,
      reachable: false,
      canRead: false,
      canWrite: false,
      error: null,
      checkedAt: Date.now()
    }

    if (!this.connection.configured) {
      this.connection.error = '尚未配置同步目录或 OpenList 连接信息'
      return
    }

    try {
      await this.client.login()
      this.connection.reachable = true
    } catch (err) {
      this.connection.error = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `OpenList 登录失败：${this.connection.error}`)
      return
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
  }

  private buildPlanner(): Planner {
    const transfer = new Transfer({
      client: this.client,
      manifest: this.manifest,
      config: this.config,
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
      onSkip: (count) => {
        this.skippedThisRun = count
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
        void this.planner?.handleEvent(e.relPath, e.type === 'upsert')
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
      config: this.config,
      onDiff: (diff) => {
        void this.planner?.handleDiff(diff)
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

    const next: AppConfig = {
      ...this.config,
      ...patch,
      openlist: { ...this.config.openlist, ...(patch.openlist ?? {}) },
      remoteScan: { ...this.config.remoteScan, ...(patch.remoteScan ?? {}) },
      retry: { ...this.config.retry, ...(patch.retry ?? {}) }
    }
    this.config = next
    saveConfig(next)
    this.events.onConfig?.(next)

    // 同步根变了 → 监控必须重建
    if (previousRoot !== next.syncRoot) {
      this.startWatcher()
    }
    // 远端相关配置变了 → 对账器要按新周期与策略重建
    if (patch.remoteScan || patch.remoteRoot !== undefined) {
      this.startReconciler()
    }
    // 连接信息变了 → 重新握手
    if (patch.openlist) {
      await this.connect()
    }
    return next
  }

  async triggerScan(kind: ScanKind): Promise<void> {
    if (kind === 'remote') {
      if (!this.reconciler) {
        this.pushLog('warn', '尚未连接 OpenList，无法执行远端对账')
        return
      }
      this.remoteScanRunning = true
      const startedAt = Date.now()
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
        this.remoteLastScanAt = Date.now()
        this.remoteLastStatus = res.timedOut ? 'cancelled' : 'done'
        this.remoteScannedCount = res.scannedFiles
        this.remoteDiffCount = res.diffCount
        this.events.onScan?.({
          id: res.scanId,
          kind: 'remote',
          trigger: 'manual',
          startedAt,
          finishedAt: this.remoteLastScanAt,
          scannedCount: res.scannedFiles,
          changedCount: res.diffCount,
          errorCount: 0,
          status: this.remoteLastStatus,
          errorMsg: null
        })
        this.pushLog(
          'info',
          `远端对账完成：扫描 ${res.scannedFiles} 个文件，发现 ${res.diffCount} 处差异`
        )
      } catch (err) {
        this.remoteLastStatus = 'failed'
        this.remoteScanRunning = false
        const message = err instanceof Error ? err.message : String(err)
        this.pushLog('error', `远端对账失败：${message}`)
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
        return
      }
      this.remoteScanRunning = false
      return
    }

    // 本地扫描：重启 watcher 触发一次全量
    if (!this.config.syncRoot) {
      this.pushLog('warn', '尚未设置本地同步目录')
      return
    }
    this.startWatcher()
  }

  retryTransfer(taskId: string): void {
    this.planner?.retry(taskId)
  }

  cancelTransfer(taskId: string): void {
    this.planner?.cancel(taskId)
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
      switch (resolution) {
        case 'uploaded':
        case 'overwritten': {
          if (diff.localPath) {
            await this.planner?.handleDiff({
              kind: 'size_mismatch',
              localPath: diff.localPath,
              remotePath: diff.remotePath
            })
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
          break
      }
      this.manifest.resolveDiff(diffId, resolution)
      this.manifest.log('info', `差异已处置：${diff.remotePath} → ${resolution}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog('error', `差异处置失败 ${diff.remotePath}：${message}`)
    }
  }

  /** 把远端文件下载到本地同步目录 */
  private async pullRemote(diff: DiffEntry): Promise<void> {
    if (!diff.localPath) {
      throw new Error('该差异没有对应的本地路径，无法下载')
    }
    const localPath = join(this.config.syncRoot, diff.localPath)
    await this.client.downloadTo(diff.remotePath, localPath)
    this.pushLog('info', `已下载到本地：${diff.remotePath}`)
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
      failed,
      active,
      openDiffs: diffs.length,
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
      }
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

  recentLogs(limit = 200): { ts: number; level: string; message: string }[] {
    return this.manifest.recentLogs(limit)
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connection
  }

  /** 重新做一次连接自检 */
  async recheckConnection(): Promise<ConnectionStatus> {
    await this.connect()
    return this.connection
  }

  // ── 内部 ──────────────────────────────────────────────

  private pushLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.manifest.log(level, message)
    this.events.onLog?.({ ts: Date.now(), level, message })
  }
}
