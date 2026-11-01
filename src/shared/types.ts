/**
 * 全局共享类型定义（主进程 / 预加载 / 渲染进程共用）。
 *
 * 数据模型的唯一权威定义；
 * SQLite 表结构的字段命名与本文件保持一致。
 */

// ── 文件同步状态（状态机）────────────────────────────
export type FileState =
  | 'pending' // 待处理（新增或已排入队列）
  | 'hashing' // 正在计算 md5 + sha1
  | 'hashed' // 哈希就绪，等待上传
  | 'uploading' // 上传中（可能处于分片续传）
  | 'synced' // 远端已确认存在且大小一致
  | 'error' // 重试耗尽，需人工处理
  | 'stale' // 内容已变，需重算哈希
  | 'deleted' // 本地已删除（远端按删除策略处理）
  | 'local_only' // 仅本地存在（远端尚未上传）
  | 'remote_only' // 仅远端存在（本地无此文件）
  | 'conflict' // 两侧内容分叉

// ── 对账差异类型────────────────────────────────────
export type DiffKind =
  | 'local_only' // 本地有，远端无
  | 'remote_only' // 远端有，本地无
  | 'size_mismatch' // 两侧都有但大小不同
  | 'mtime_mismatch' // 两侧都有，仅修改时间不同（弱信号）
  | 'missing_remote' // 本地清单标为已同步，但远端不存在（远端被外部删除）

export type DiffResolution =
  | 'ignored' // 用户选择忽略
  | 'uploaded' // 已重新上传
  | 'deleted_remote' // 已从远端移除
  | 'overwritten' // 已用本地版本覆盖远端
  | 'pulled' // 已下载到本地

// ── 扫描批次（scans 表）──────────────────────────────
export type ScanKind = 'local' | 'remote'
export type ScanTrigger = 'startup' | 'timer' | 'manual' | 'event'
export type ScanStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface ScanRecord {
  id: number
  kind: ScanKind
  trigger: ScanTrigger
  startedAt: number
  finishedAt: number | null
  scannedCount: number
  changedCount: number
  errorCount: number
  status: ScanStatus
  errorMsg: string | null
}

// ── 文件条目（files 表）───────────────────────────────
export interface FileEntry {
  id: number
  localPath: string // 相对同步根目录，POSIX 分隔
  localSize: number
  mtimeMs: number
  md5: string | null
  sha1: string | null
  remotePath: string | null
  remoteSize: number | null
  remoteEtag: string | null
  /** 最近一次成功同步时确认的本地大小；L1 去重的基准 */
  syncedSize: number | null
  /** 最近一次成功同步时确认的本地修改时间；L1 去重的基准 */
  syncedMtimeMs: number | null
  state: FileState
  lastSyncAt: number | null
  lastVerifyAt: number | null
  errorMsg: string | null
  firstSeenAt: number
  deletedAt: number | null
}

// ── 差异条目（diffs 表）──────────────────────────────
export interface DiffEntry {
  id: number
  kind: DiffKind
  localPath: string | null
  remotePath: string
  localSize: number | null
  remoteSize: number | null
  localMtime: number | null
  remoteMtime: number | null
  detectedAt: number
  resolvedAt: number | null
  resolution: DiffResolution | null
}

// ── 传输任务────────────────────────────────────────
export type TransferMode = 'single' // 单次 PUT /api/fs/put
export type TransferState = 'queued' | 'hashing' | 'uploading' | 'verifying' | 'done' | 'failed' | 'canceled'

export interface TransferTask {
  id: string
  fileId: number
  localPath: string
  remotePath: string
  size: number
  mode: 'single' | 'multipart'
  state: TransferState
  /** 已完成分片数（multipart 模式） */
  chunksDone: number
  /** 分片总数（multipart 模式） */
  chunksTotal: number
  /** 0–1 */
  progress: number
  /** 每秒字节数 */
  speed: number
  md5Prefix: string
  sha1Prefix: string
  errorMsg: string | null
  attempts: number
}

// ── 配置──────────────────────────────────────────
export interface RemoteScanConfig {
  enabled: boolean
  intervalHours: number
  onStartup: boolean
  /** 穿透服务端目录缓存；false 则无法发现远端被外部删除 */
  refresh: boolean
  maxConcurrency: number
  timeoutMinutes: number
  /** local-wins | manual */
  conflictPolicy: 'local-wins' | 'manual'
  /** record-only | pull | delete */
  remoteOnlyPolicy: 'record-only' | 'pull' | 'delete'
  /** 单次对账自动修复的最大文件数，超出则仅记录 */
  autoFixLimit: number
}

export type DeletePolicy = 'trash' | 'delete' | 'keep'

export interface AppConfig {
  syncRoot: string
  openlist: {
    baseUrl: string
    username: string
    /** 经 Electron safeStorage 加密后存储，运行时解密 */
    password: string
  }
  remoteRoot: string
  hashConcurrency: number
  uploadConcurrency: number
  singlePutMaxBytes: number
  chunkConcurrency: number
  deletePolicy: DeletePolicy
  trashRoot: string
  maxDeletesPerRun: number
  maxDeleteBytesPerRun: number
  retry: { maxAttempts: number; baseDelayMs: number }
  exclude: string[]
  verifyMode: 'none' | 'size' | 'hash'
  quarkMaxFileBytes: number
  remoteScan: RemoteScanConfig
}

// ── 主进程 → 渲染进程 的 IPC 通道 ───────────────────────────────
export interface MainToRendererEvents {
  'transfer:update': (task: TransferTask) => void
  'scan:update': (scan: ScanRecord) => void
  'diff:update': (diff: DiffEntry) => void
  'config:update': (config: AppConfig) => void
  'log:append': (entry: { ts: number; level: 'info' | 'warn' | 'error'; message: string }) => void
}

export interface RendererToMainEvents {
  'scan:trigger': (kind: ScanKind) => void
  'transfer:retry': (taskId: string) => void
  'transfer:cancel': (taskId: string) => void
  'diff:resolve': (diffId: number, resolution: DiffResolution) => void
  'app:quit': () => void
}
// 注：配置变更走 invoke（'config:patch'），因为调用方需要拿到合并后的新配置。

// ── 渲染进程启动时拉取的初始快照 ────────────────────────────────

/** 概览页统计卡的数据来源 */
export interface AppStats {
  /** 已同步文件数 */
  synced: number
  /** 待上传（排队中） */
  queued: number
  /** 本次运行 L1 去重命中、零上行的文件数 */
  skipped: number
  /** 失败数 */
  failed: number
  /** 进行中 */
  active: number
  /** 未处理的对账差异数 */
  openDiffs: number
  /** 已扫描的本地文件总数 */
  totalFiles: number
  /** 本地扫描通道状态 */
  localScan: {
    watching: boolean
    lastScanAt: number | null
    scannedCount: number
  }
  /** 远端对账通道状态 */
  remoteScan: {
    enabled: boolean
    running: boolean
    lastScanAt: number | null
    lastScanStatus: ScanStatus | null
    scannedCount: number
    diffCount: number
    nextScanAt: number | null
  }
}

/** 首屏一次性拉取的全部数据 */
export interface AppSnapshot {
  config: AppConfig
  stats: AppStats
  files: FileEntry[]
  diffs: DiffEntry[]
  tasks: TransferTask[]
  logs: { ts: number; level: string; message: string }[]
  /** 主进程侧的连接自检结果 */
  connection: ConnectionStatus
}

/** 连接页的权限自检结果 */
export interface ConnectionStatus {
  /** 配置是否完整（同步根目录 + OpenList 地址 + 账号） */
  configured: boolean
  /** OpenList 是否可达且登录成功 */
  reachable: boolean
  /** 能否读取远端根目录 */
  canRead: boolean
  /** 能否写入远端根目录（refresh:true 的前提） */
  canWrite: boolean
  /** 上一次检查的错误信息 */
  error: string | null
  checkedAt: number | null
}
