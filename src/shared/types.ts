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
/**
 * 对账差异只回答一件事：**这个文件在不在**。
 *
 * 「仅修改时间不同」不算差异——复制、解压、跨设备同步都会改 mtime，
 * 而内容可能一模一样。把它列进清单只会制造噪声，
 * 用户真正关心的是「远端有没有这个东西」「两边是不是同一份」。
 */
export type DiffKind =
  | 'local_only' // 本地有，远端无
  | 'remote_only' // 远端有，本地无
  | 'size_mismatch' // 两侧都有但大小不同
  | 'missing_remote' // 本地清单标为已同步，但远端不存在（远端被外部删除）

export type DiffResolution =
  | 'ignored' // 用户选择忽略
  | 'uploaded' // 已重新上传
  | 'deleted_remote' // 已从远端移除
  | 'overwritten' // 已用本地版本覆盖远端
  | 'pulled' // 已下载到本地
  | 'auto' // 本轮对账已不再成立，差异自动消除

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

/**
 * 同步结论的可信级别。
 *
 * `hash` = 内容经哈希确认；`size` = 仅凭同名同大小弱认定；
 * `null` = 未标记。
 */
export type VerifyLevel = 'hash' | 'size' | null

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
  /**
   * 最近一次**成功同步**时确认的内容哈希。
   *
   * 与 md5/sha1 分开存：md5/sha1 记录的是「本地当前文件」的哈希，
   * 一次失败的上传也会把它改掉；而 synced_* 记录的是
   * 「远端确实存着的那个版本」的哈希，只有同步成功才写。
   *
   * 有了它才能在客户端自行判定「远端重复」——服务端不给任何秒传信号。
   */
  syncedMd5: string | null
  syncedSha1: string | null
  /**
   * 这条「已同步」结论的可信级别。
   *
   * - `hash`：内容经过哈希比对确认（上传后校验，或深度校验通过）
   * - `size`：仅凭「远端同名 + 同大小」弱认定，**内容未校验**
   * - `null`：未标记（旧库数据，或还没走完同步流程）
   *
   * 为什么必须打这个标记：认领（adopt）这条路只比对名称与大小，
   * 不读内容。它能挡住整批重传，但代价是「同名同大小、内容其实不同」
   * 这情况会被误当成已同步——本地那份就等于没备份。
   * 界面上必须能一眼看出哪些结论只是弱认定，
   * 用户才能决定要不要做深度校验。
   */
  verifyLevel: VerifyLevel
  /**
   * 本地文件的 inode（Windows 上是文件索引号）。
   *
   * 重命名时 inode 不变而路径变——这是识别重命名最可靠的信号，
   * 且比算哈希便宜得多（stat 一次 vs 读一遍全文件）。
   */
  /**
   * 本地 inode。
   *
   * 用字符串：Windows 上是 64 位文件索引号，数值普遍超过 JS 的 2^53
   * 安全整数范围，按数字传递会丢精度甚至抛异常。
   */
  localInode: string | null
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

/**
 * 传输类别：这个任务到底在做什么。
 *
 * 只说「方向」不够——用户真正想知道的是「这个文件为什么没传」，
 * 所以「跳过」被单列成一类，并用 skipReason 说明原因。
 */
export type TransferCategory =
  | 'upload' // 上传：本地 → 远端
  | 'download' // 下载：远端 → 本地
  | 'skip' // 跳过：内容已经存在，无需传输

/**
 * 跳过的原因。
 *
 * - local_duplicate：本地内容与上次成功同步的一致（mtime+size 未变），零上行
 * - remote_duplicate：远端已有同样内容（按哈希判定），无需再传一遍
 * - remote_size_match：远端已有同名同大小的文件（未校验内容），
 *   按「文件名 + 大小」两个条件弱认定，不再上行
 */
export type SkipReason = 'local_duplicate' | 'remote_duplicate' | 'remote_size_match'

export type TransferMode = 'single' // 单次 PUT /api/fs/put
export type TransferState =
  | 'queued'
  | 'hashing'
  | 'uploading'
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'skipped'

export interface TransferTask {
  id: string
  fileId: number
  localPath: string
  remotePath: string
  size: number
  mode: 'single' | 'multipart'
  state: TransferState
  /** 这个任务属于哪一类：上传 / 下载 / 跳过 */
  category: TransferCategory
  /** 跳过原因；仅 category === 'skip' 时有值 */
  skipReason: SkipReason | null
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

// ── 传输速率────────────────────────────────────────

/**
 * 传输速率统计。
 *
 * 三个数字各有各的用处，不能只留一个：
 * - `current`：此刻的速率，看上传卡没卡
 * - `max`：本次运行的峰值，看线路能跑多快
 * - `avg`：本次运行的平均速率，看整体效率
 *
 * 单位统一为字节/秒（不是 bit）。
 */
export interface TransferSpeed {
  /** 当前瞬时速率（字节/秒） */
  current: number
  /** 本次运行观测到的峰值速率（字节/秒） */
  max: number
  /** 本次运行的平均速率（字节/秒） */
  avg: number
  /** 累计传输字节数 */
  totalBytes: number
  /** 平均速率的统计时长（毫秒） */
  elapsedMs: number
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
  /**
   * 是否启用「同名 + 同大小」认领。
   *
   * 开启后，对账与上传前闸门都会检查：远端已有同名同大小的文件时，
   * 直接把它认成本地文件的同步基准，**不再上行**。
   *
   * 代价必须说清楚：这条判定**不校验内容**。
   * 「同名同大小但内容不同」的文件会被误判成已同步——
   * 本地那份等于没备份。所以认领出来的记录会打上 `verify_level='size'` 标记，
   * 界面上能看出来，需要时可用「深度校验」补做内容比对。
   *
   * 哈希去重不受这个开关影响：它比的是内容，永远准确。
   */
  adoptByNameAndSize: boolean
  /**
   * 远端遍历时的排除规则（glob，作用于相对远端根的路径）。
   *
   * 与本地 `exclude` 分开配置：本地排除的是「不上传的路径」，
   * 远端排除的是「不参与差异比对的路径」。两者语义不同，
   * 混在一起会出现「本地没同步但远端有」被判成 remote_only 的噪声。
   */
  exclude: string[]
}

export type DeletePolicy = 'trash' | 'delete' | 'keep'

/** 远端一致性校验模式 */
export type VerifyMode = 'none' | 'size' | 'hash'

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
  verifyMode: VerifyMode
  quarkMaxFileBytes: number
  remoteScan: RemoteScanConfig
  /**
   * 是否把本地空目录同步到远端。
   *
   * 默认关闭：多数备份场景不需要保留空目录，
   * 开启后会在远端创建对应的空目录。
   */
  syncEmptyDirs: boolean
  /**
   * 是否识别本地重命名。
   *
   * 识别成功时远端走 move（省一次完整上行），
   * 否则退化为「删旧 + 传新」。
   */
  detectRenames: boolean
  /**
   * 重命名识别的候选窗口（毫秒）。
   *
   * 删除与新增两条事件之间的间隔超过此值就不再视为重命名。
   * 默认 5000ms——文件管理器改名时两条事件几乎同时到达，
   * 但跨磁盘移动或大文件时会拉开距离。
   */
  renameWindowMs: number
  /**
   * hash 校验模式下，允许「下载远端重算哈希」的文件大小上限（字节）。
   *
   * 夸克驱动的 hash_info 通常为空，远端哈希拿不到，
   * 想真正校验内容只能把远端文件拉回来重算——那是全量下行流量。
   * 因此只对不超过此值的文件做深度校验，其余退化为大小校验。
   */
  verifyHashMaxBytes: number
}

// ── 主进程 → 渲染进程 的 IPC 通道 ───────────────────────────────
// ── 运行日志──────────────────────────────────────────

/**
 * 日志类别。
 *
 * 用户问「这个文件到底怎么了」时，要能一眼分清这条日志说的是
 * **上传**、**下载**、**跳过**，还是别的什么。混在一起的话，
 * 日志页只是一堆时间戳加文字流水，看不出同步实际做了什么。
 */
export type LogCategory =
  | 'upload' // 上传：本地 → 远端
  | 'download' // 下载：远端 → 本地
  | 'skip' // 跳过：内容已存在或未变，无需传输
  | 'reconcile' // 对账：远端差异的发现与处置
  | 'system' // 系统：连接、配置、扫描等非文件级事件

/**
 * 一条日志。
 *
 * `filePath` / `remotePath` 是结构化的文件信息：
 * 消息文本给人读，这两列给机器用（筛选、按文件查历史）。
 */
export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
  category: LogCategory
  /** 涉及的本地文件（相对同步根）；系统级日志为 null */
  filePath: string | null
  /** 涉及的远端文件；系统级日志为 null */
  remotePath: string | null
}

/**
 * 写日志时附带的结构化信息。
 *
 * 与 LogEntry 分开：写入时多数字段还不知道（时间戳由写入方生成）。
 */
export interface LogMeta {
  category?: LogCategory
  /** 本地相对路径 */
  filePath?: string | null
  /** 远端完整路径 */
  remotePath?: string | null
  /** 清单里的文件 id，用于回连 files 表 */
  fileId?: number | null
}

/**
 * 扫描/对账进度。
 *
 * 存在的理由：扫描一个大目录树要几秒到几十秒，期间界面**必须**有反馈，
 * 否则用户点了按钮什么也没发生，只能靠猜。
 *
 * `total` 为 null 表示总量未知（遍历型操作事先数不出总数），
 * 此时界面显示不确定态进度条 + 已处理计数。
 */
export interface ScanProgress {
  kind: ScanKind
  running: boolean
  /** 已处理数量 */
  done: number
  /** 总数；未知时为 null */
  total: number | null
  /** 人类可读描述，如「已扫描 128 个文件」 */
  detail: string
  /**
   * 这次为什么失败（只在 running=false 且确实是失败时非空）。
   *
   * 失败与成功在界面上长得一模一样的话，用户完全看不出刚才对账失败了。
   */
  error?: string | null
}

/**
 * 两条扫描通道各自的进度。
 *
 * 以前只有**一个** progress 对象，两条通道共用：
 * 对账一开始就把本地扫描的进度覆盖掉，本地扫描的状态再也回不来；
 * 而且对账成功路径不推终态，进度条就一直挂着。
 *
 * 拆成两个独立槽位，两条通道互不干扰——
 * 本地扫描可以正在跑，同时对账也在跑，界面各显示各的。
 */
export interface ScanProgressPair {
  local: ScanProgress | null
  remote: ScanProgress | null
}

export interface MainToRendererEvents {
  'transfer:update': (task: TransferTask) => void
  'scan:update': (scan: ScanRecord) => void
  /** 扫描/对账进度；扫描过程中持续推送 */
  'scan:progress': (progress: ScanProgress) => void
  'diff:update': (diff: DiffEntry) => void
  'config:update': (config: AppConfig) => void
  'log:append': (entry: LogEntry) => void
  /**
   * 连接自检结果变化。
   *
   * 没有这条推送，界面上的连接状态只在首屏取一次快照——
   * 改完配置后仍然显示旧的「未配置」，用户以为没生效。
   */
  'connection:update': (status: ConnectionStatus) => void
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
  /** 本次运行被跳过的文件总数（本地重复 + 远端重复） */
  skipped: number
  /** 其中「本地内容与上次一致」而跳过的数量 */
  skippedLocal: number
  /** 其中「远端已有同样内容」而跳过的数量 */
  skippedRemote: number
  /** 本次运行下载（远端 → 本地）的文件数 */
  downloaded: number
  /** 失败数 */
  failed: number
  /** 进行中 */
  active: number
  /** 未处理的对账差异数 */
  openDiffs: number
  /** 是否处于暂停状态 */
  paused: boolean
  /** 已扫描的本地文件总数 */
  totalFiles: number
  /** 本地扫描通道状态 */
  localScan: {
    watching: boolean
    /**
     * 监控没起来时的原因（目录不存在、权限不足等）；null 表示正常。
     *
     * 必须把「没设置目录」和「设了但起不来」分开：
     * 用户配的是盘符根（`Z:/`）时，网卡没插上 / 盘符未映射 / 权限不足
     * 都会让监控起不来。这两种情况给同一句「尚未设置同步目录」，
     * 用户只会反复去改设置，而真正的原因是盘符当时不存在。
     */
    error: string | null
    /** 正在监听的本地目录（未设置时为空串） */
    root: string
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
  /** 传输速率统计（上传 + 下载合计） */
  speed: TransferSpeed
  /**
   * 当前正在跑的扫描进度（本地扫描与远端对账各自独立）。
   *
   * 没有它的话，扫描期间界面完全没有反馈——
   * 用户点了「扫描本地」，不知道程序是在跑还是已经卡死。
   */
  progress: ScanProgressPair
  /**
   * 是否已经开始同步。
   *
   * 程序启动后**默认不开始**——本地扫描、远端对账、上传队列
   * 都要用户显式点「开始同步」才启动。
   * 备份工具在启动瞬间就抢带宽、扫全盘，不是用户想要的。
   *
   * 与 `paused` 分开：`started=false` 是「还没开始」，
   * `started=true && paused=true` 是「运行中途暂停了」，
   * 两者的界面文案不一样。
   */
  started: boolean
}

/** 首屏一次性拉取的全部数据 */
export interface AppSnapshot {
  config: AppConfig
  stats: AppStats
  files: FileEntry[]
  diffs: DiffEntry[]
  tasks: TransferTask[]
  logs: LogEntry[]
  /** 主进程侧的连接自检结果 */
  connection: ConnectionStatus
}

/** 连接页的权限自检结果 */
export interface ConnectionStatus {
  /**
   * OpenList 连接信息是否已填写完整（服务器地址 + 账号）。
   *
   * 刻意**不含**本地同步目录：没设本地目录是「还没决定同步哪」，
   * 跟「连不上服务端」是两回事，混在一起会让界面一律显示「未配置」。
   */
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

/** 单次远端校验的结论 */
export interface VerifyResult {
  /** 校验是否通过 */
  ok: boolean
  /** 校验方式 */
  mode: VerifyMode
  /** 期望值（本地） */
  expected: number
  /** 实际值（远端） */
  actual: number | null
  /** 不一致时的说明 */
  detail?: string
}

/**
 * 深度校验（把远端文件拉回来重算哈希）的批量结果。
 *
 * 存在的意义：认领这条路只比对「文件名 + 大小」，不碰内容。
 * 深度校验是它的补口——把远端那份下载下来重算 md5/sha1，
 * 与本地比对，一致就把结论升级成 `verify_level='hash'`。
 */
export interface DeepVerifyResult {
  /** 实际参与校验的文件数 */
  checked: number
  /** 内容一致的数量 */
  matched: number
  /** 内容不一致的数量 */
  mismatched: number
  /** 跳过的数量（超过体积上限、无远端路径等） */
  skipped: number
  /** 校验过程出错的数量 */
  failed: number
  details: { localPath: string; ok: boolean; detail: string }[]
}

/**
 * 诊断包内容。
 *
 * 目的是让用户能在不暴露凭据的前提下把现场交出去——
 * 所以密码一律脱敏，其余尽量完整。
 */
export interface DiagnosticBundle {
  /** 打包时间 */
  generatedAt: number
  /** 应用与运行环境 */
  app: {
    version: string
    electron: string
    node: string
    platform: string
    arch: string
    /** 进程已运行时长（毫秒） */
    uptimeMs: number
    /** 本地清单库路径 */
    manifestPath: string
    /** 操作系统版本 */
    osRelease: string
  }
  /** 配置（凭据已脱敏） */
  config: AppConfig
  /** 连接自检结果 */
  connection: ConnectionStatus
  /** 统计概览 */
  stats: AppStats
  /** 各状态的文件计数 */
  fileStates: Record<string, number>
  /** 最近的传输任务 */
  tasks: TransferTask[]
  /** 未处置的对账差异 */
  diffs: DiffEntry[]
  /** 最近的日志 */
  logs: { ts: number; level: string; message: string }[]
  /** 同步根目录下的顶层条目，便于看出目录结构 */
  treePreview: string[]
}
