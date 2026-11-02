import { create } from 'zustand'
import type {
  AppConfig,
  AppSnapshot,
  AppStats,
  ClearCacheResult,
  ConnectionStatus,
  DeepVerifyResult,
  DiffEntry,
  FileEntry,
  LogEntry,
  ScanProgressPair,
  StorageInfo,
  TaskBatch,
  TransferTask
} from '@shared/types'

/**
 * 渲染进程的全局状态。
 *
 * 数据有三个来源，优先级从高到低：
 * 1. 首屏快照（invoke 'app:snapshot'）——一次性拿全量
 * 2. 主进程推送的事件（transfer:update / diff:update / log:append …）——增量
 * 3. 轮询刷新统计——兜底，防止某类事件漏掉导致数字长期不更新
 */

interface AppState {
  ready: boolean
  config: AppConfig | null
  stats: AppStats | null
  files: FileEntry[]
  /** 当前已加载的文件条数（分页上限） */
  filesLimit: number
  diffs: DiffEntry[]
  tasks: TransferTask[]
  logs: LogEntry[]
  connection: ConnectionStatus | null
  /**
   * 两条扫描通道各自的进度。
   *
   * 分开存，而不是一个 progress 对象：
   * 共用时对账一启动就把本地扫描的进度覆盖掉，
   * 本地扫描的状态再也回不来；而且一条通道的终态会误伤另一条。
   */
  progress: ScanProgressPair
  /** 最近一次失败的说明；null 表示当前没有失败 */
  lastError: string | null

  /**
   * 首次加载：拉快照 + 建立事件订阅。
   *
   * 返回清理函数：取消全部订阅、停掉轮询定时器。
   * 组件卸载时必须调用它，否则订阅会一直留在 ipcRenderer 上。
   */
  init: () => Promise<() => void>
  /** 清掉失败提示 */
  clearError: () => void
  refreshStats: () => Promise<void>
  refreshFiles: () => Promise<void>
  /** 加载更多文件（分页追加） */
  loadMoreFiles: () => Promise<void>
  refreshDiffs: () => Promise<void>
  saveConfig: (patch: Partial<AppConfig>) => Promise<AppConfig | null>
  recheckConnection: () => Promise<void>
  /** 导出诊断包；返回生成的文件路径，失败返回 null */
  exportDiagnostics: () => Promise<string | null>
  /** 切换暂停状态；返回切换后的状态 */
  togglePause: () => Promise<boolean | null>
  /** 开始同步（启动后默认不开始） */
  startSync: () => Promise<void>
  /** 删除本地文件（批量）；返回成功/失败数 */
  deleteLocalFiles: (relPaths: string[]) => Promise<{ deleted: number; failed: number }>
  /** 从队列移除任务记录（批量）；返回移除条数 */
  removeTasks: (taskIds: string[]) => Promise<number>
  /** 删除远端文件（批量）；返回成功/失败数 */
  deleteRemoteFiles: (
    targets: { remotePath: string; diffId?: number }[]
  ) => Promise<{ deleted: number; failed: number }>
  /** 清空运行日志；返回清掉的条数 */
  clearLogs: () => Promise<number>
  /** 深度校验（批量）：把远端文件拉回来重算哈希，与本地比对 */
  verifyRemoteFiles: (relPaths: string[]) => Promise<DeepVerifyResult>
  /** 数据目录占用（数据库大小、缓存大小） */
  getStorageInfo: () => Promise<StorageInfo | null>
  /** 清除运行时缓存；返回释放字节与清理结果 */
  clearCache: () => Promise<ClearCacheResult | null>
}

/*
 * init 的全局状态。
 *
 * 为什么必须放模块级：事件订阅与轮询定时器是**全局唯一**的副作用。
 * React 19 开发模式的 StrictMode 会把 effect 跑两遍（mount→unmount→mount），
 * 不挡住第二次的话每个 IPC 通道都会挂两个监听器（每条日志追加两次），
 * 轮询也会变成 5 秒一次变两次。
 */

/** 是否已经初始化过（含正在初始化） */
let initialized = false
/** 当前这一轮初始化的清理函数；null 表示当前没有活跃的订阅 */
let initCleanup: (() => void) | null = null

/** 空的清理函数：没有订阅需要退时用它 */
function noop(): void {}

/**
 * 文件清单的分页大小。
 *
 * 六万个文件一次性塞进 IPC 的返回值里，JSON 序列化要一两秒，
 * 渲染进程主线程直接卡住。分页之后每次只传几千条，
 * 配合虚拟滚动，界面始终是流畅的。
 */
const FILE_PAGE_SIZE = 5000

/**
 * 后台刷新时最多重载的行数。
 *
 * 为什么刷新要记住当前的加载进度：用户点了三次「加载更多」
 * 已经看到两万条，这时后台因为某个文件传完而刷新一次清单，
 * 列表「唰」地缩回五千条——用户会以为程序把他的数据弄丢了，
 * 还得再点三次。这在大目录下几乎无法正常浏览。
 *
 * 但也不能无限重载：真按六万条重载，每次刷新就是几 MB 的
 * JSON 序列化 + 跨进程传输，比不刷新更卡。所以给个上限，
 * 超出部分由用户按需再点「加载更多」。
 */
const FILE_REFRESH_MAX = 20000

/**
 * 渲染层保留的日志条数。
 *
 * 日志页要能翻一段时间的历史，但不可能全量——六万条日志光是
 * 渲染就要命。五百条足够看清刚才发生了什么，更早的请用日志页
 * 的类别筛选去查（完整记录都落在数据库里）。
 */
const LOG_KEEP = 500

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  config: null,
  stats: null,
  files: [],
  filesLimit: 0,
  diffs: [],
  tasks: [],
  logs: [],
  connection: null,
  progress: { local: null, remote: null },
  lastError: null,

  init: async () => {
    /*
     * StrictMode 下 effect 会被调用两次。
     * 第二次进来绝不能重新订阅、重新起定时器——
     * 否则每条日志都会追加两次，轮询频率也翻倍。
     */
    if (initialized) {
      /*
       * 交出「当前这一轮」的清理函数，而不是 no-op：
       * StrictMode 的第一次 cleanup 发生在 init 还没 resolve 之前
       *（那时根本拿不到清理函数，什么也没释放），
       * 真正能收场的只有第二次挂载拿到的这一份。
       */
      return (): void => initCleanup?.()
    }
    initialized = true

    const snap = await safe<AppSnapshot | null>(
      () => ipc(window.topensync?.getSnapshot),
      null,
      '读取首屏快照'
    )
    if (!snap) {
      // 没有快照就没有可订阅的状态源：置为就绪，让界面显示空态而不是一直转圈
      set({ ready: true })
      initialized = false
      return noop
    }

    set({
      ready: true,
      config: snap.config,
      stats: snap.stats,
      files: snap.files,
      diffs: snap.diffs,
      tasks: snap.tasks,
      logs: snap.logs,
      connection: snap.connection,
      progress: snap.stats.progress
    })

    /*
     * 快照之后补刷一次清单。
     *
     * 快照是**某一刻**的全量，而订阅是在快照之后才建立的——
     * 这中间发生的变化（文件刚好传完、刚被删掉）就漏掉了。
     * 补一次刷新把这段窗口补上。
     */
    scheduleFilesRefresh(get)

    // ── 事件订阅 ──
    // preload 的每个订阅都会返回一个取消订阅函数，卸载时必须全部退掉
    const disposers: (() => void)[] = []
    const track = (unsubscribe: (() => void) | undefined): void => {
      if (unsubscribe) disposers.push(unsubscribe)
    }

    track(
      window.topensync?.onTransferBatch((batch) => {
        set((s) => {
          const next = mergeTaskBatch(s.tasks, batch)
          /*
           * 计数就地算，跟着合并那一次遍历走。
           *
           * 以前这里调两次 `countBy(...)`，每次内部都 `filter` 一遍
           * 整个任务数组——加上合并自己的 filter，一条推送要扫三遍。
           * 六万条时单次推送 31ms，累计三十多分钟。
           *
           * 现在合并与计数都在这一批里完成：批次多大就扫多大，
           * 与任务总量无关。
           */
          let queued = 0
          let failed = 0
          for (const t of next) {
            if (t.state === 'queued') queued++
            else if (t.state === 'failed') failed++
          }
          return {
            tasks: next,
            stats: s.stats ? { ...s.stats, queued, failed } : s.stats
          }
        })
        // 统计走节流：每条推送都拉一次统计会把主进程和 IPC 一起压垮
        scheduleStatsRefresh(get)
        /*
         * 任务走到终态 = 清单里那条记录的状态也定了
         * （uploading → synced / failed / 已取消）。
         * 这里必须刷，否则清单页会停在「上传中」——
         * 甚至在扫描事件抢跑的空表上永远停着。
         */
        if (batch.upserts.some((t) => isTerminalState(t.state))) {
          scheduleFilesRefresh(get)
        }
      })
    )

    /*
     * 扫描结束。
     *
     * 远端对账会**新增**差异条目，差异列表必须跟着刷新——
     * 只刷统计的话，对账页的表格永远是空的。
     *
     * 文件清单在**两种**扫描后都要刷：
     * - 本地扫描：刚上传/删除的文件要出现在清单页
     * - 远端对账：远端状态变化会改写清单里的远端路径
     * 以前只在远端对账后刷，于是本地扫描完清单页还是空的，
     * 用户得等下次对账才看得到自己刚传的文件。
     *
     * 走节流版而不是直接刷：扫描事件那一刻 files 表可能还是空的
     * （文件还在排队上传），直接刷只会刷回一张空表。
     */
    track(
      window.topensync?.onScanUpdate((scan) => {
        void safe(() => get().refreshStats(), undefined, '刷新统计')
        scheduleFilesRefresh(get)
        if (scan.kind === 'remote') {
          void safe(() => get().refreshDiffs(), undefined, '刷新差异列表')
        }
      })
    )

    /*
     * 差异更新（**批量**）。
     *
     * 一轮对账可能一次产生上万条差异。以前是逐条推、逐条
     * `[diff, ...s.diffs.filter(...)]`——那是「每条都重建一次全表」，
     * 一万条就是一万次万级数组重建 + 一万次 getStats 往返，
     * 对账跑完的瞬间界面直接卡死，用户以为程序挂了。
     *
     * 现在一批只重建一次，统计刷新走节流。
     */
    const applyDiffs = (diffs: DiffEntry[]): void => {
      if (diffs.length === 0) return
      set((s) => {
        // 已处置的（resolvedAt 非空）从列表里撤掉；其余置顶
        const removedIds = new Set<number>()
        const upserts: DiffEntry[] = []
        for (const d of diffs) {
          if (d.resolvedAt !== null) removedIds.add(d.id)
          else upserts.push(d)
        }
        if (removedIds.size === 0 && upserts.length === 0) return {}

        // 先按 id 去掉旧版本（一次遍历），再整批拼到最前面。
        // 批次内倒序：最新收到的那条排在最上面
        const upsertIds = new Set(upserts.map((d) => d.id))
        const kept = s.diffs.filter((d) => !removedIds.has(d.id) && !upsertIds.has(d.id))
        return { diffs: [...upserts.slice().reverse(), ...kept] }
      })
      scheduleStatsRefresh(get)
    }

    if (window.topensync?.onDiffBatch) {
      track(window.topensync.onDiffBatch(applyDiffs))
    } else {
      // 老版本 preload：退回单条通道
      track(window.topensync?.onDiffUpdate((diff) => applyDiffs([diff])))
    }

    track(
      window.topensync?.onConfigUpdate((config) => {
        set({ config })
      })
    )

    // 连接状态跟着主进程走。
    // 以前只在首屏取一次快照，改完配置后界面还显示旧的「未配置」，
    // 用户会以为设置没生效。
    track(
      window.topensync?.onConnectionUpdate((connection) => {
        set({ connection })
      })
    )

    /*
     * 扫描/对账进度。
     *
     * 没有这条推送，扫描期间界面毫无反馈——
     * 用户点了「扫描本地」不知道程序在跑还是卡死。
     */
    track(
      window.topensync?.onScanProgress((progress) => {
        /*
         * 按通道分流存进度。
         *
         * 以前是一个 progress 对象：本地扫描和对账共用，
         * 对账一开始就把本地扫描的进度顶掉，本地扫描的状态永远回不来，
         * 而且对账完成后进度条还挂着不消失。
         */
        set((s) => ({
          progress:
            progress.kind === 'local'
              ? { ...s.progress, local: progress }
              : { ...s.progress, remote: progress }
        }))
        // 进度是高频事件（每个文件一跳），统计必须走节流
        scheduleStatsRefresh(get)
      })
    )

    track(
      window.topensync?.onLogBatch((entries) => {
        if (entries.length === 0) return
        /*
         * 整批一次性拼进去。
         *
         * 以前每条日志都 `[entry, ...s.logs].slice(0, 500)`——
         * 六万条日志就是六万次 500 元素数组重建。
         * 现在一批只重建一次，批次内的顺序反转成「最新在前」。
         */
        set((s) => ({ logs: [...entries.slice().reverse(), ...s.logs].slice(0, LOG_KEEP) }))
      })
    )

    // 兜底轮询：统计与清单不会每次都有事件推送
    const timer = window.setInterval(() => {
      void safe(() => get().refreshStats(), undefined, '刷新统计')
    }, 5000)

    const cleanup = (): void => {
      for (const unsubscribe of disposers) {
        try {
          unsubscribe()
        } catch {
          // 一个订阅退不掉不该连累其他订阅
        }
      }
      disposers.length = 0
      window.clearInterval(timer)
      if (filesRefreshTimer !== null) {
        window.clearTimeout(filesRefreshTimer)
        filesRefreshTimer = null
      }
      filesRefreshAt = 0
      if (statsRefreshTimer !== null) {
        window.clearTimeout(statsRefreshTimer)
        statsRefreshTimer = null
      }
      initialized = false
      initCleanup = null
    }
    initCleanup = cleanup
    return cleanup
  },

  clearError: () => set({ lastError: null }),

  refreshStats: async () => {
    const stats = await safe(() => ipc(window.topensync?.getStats), null, '刷新统计')
    if (stats) set({ stats })
  },

  refreshFiles: async () => {
    /*
     * 保住用户已经「加载更多」出来的行数。
     *
     * 以前这里固定按 FILE_PAGE_SIZE 拉——后台一刷新，列表就缩回五千条，
     * 用户刚翻到的位置全没了。现在按当前已加载量重拉（有上限）。
     */
    const limit = Math.max(FILE_PAGE_SIZE, Math.min(get().filesLimit, FILE_REFRESH_MAX))
    const files = await safe(
      () => ipc(() => window.topensync?.listFiles({ limit })),
      null,
      '刷新文件清单'
    )
    if (files) set({ files, filesLimit: limit })
  },

  loadMoreFiles: async () => {
    /*
     * 真正的分页追加：只取**接下来**那一段，拼到已有列表后面。
     *
     * 以前是「把 limit 加大再重拉一遍」——点第一次拉五千行，
     * 第二次拉一万行（其中五千行已经拿过了），第三次一万五……
     * 点到第六万行总共要传三十九万行，平方级浪费。
     */
    const offset = get().files.length
    const more = await safe(
      () => ipc(() => window.topensync?.listFiles({ limit: FILE_PAGE_SIZE, offset })),
      null,
      '加载更多文件'
    )
    if (!more || more.length === 0) return
    set((s) => ({ files: s.files.concat(more), filesLimit: s.files.length + more.length }))
  },

  refreshDiffs: async () => {
    const diffs = await safe(() => ipc(window.topensync?.listDiffs), null, '刷新差异列表')
    if (diffs) set({ diffs })
  },

  saveConfig: async (patch) => {
    // 失败时返回 null（调用方据此判断没保存成功），原因记在 lastError
    const config = await safe(() => ipc(() => window.topensync?.patchConfig(patch)), null, '保存配置')
    if (config) set({ config })
    return config
  },

  recheckConnection: async () => {
    const connection = await safe(() => ipc(window.topensync?.checkConnection), null, '连接自检')
    if (connection) set({ connection })
  },

  exportDiagnostics: async () => {
    return safe(() => ipc(window.topensync?.exportDiagnostics), null, '导出诊断包')
  },

  getStorageInfo: async () => {
    return safe(() => ipc(window.topensync?.getStorageInfo), null, '读取存储占用')
  },

  clearCache: async () => {
    return safe(() => ipc(window.topensync?.clearCache), null, '清除缓存')
  },

  togglePause: async () => {
    const current = get().stats?.paused ?? false
    const ok = await safe(
      () => ipc(current ? window.topensync?.resumeSync : window.topensync?.pauseSync),
      null,
      '切换同步状态'
    )
    if (ok === null) return null
    // 暂停会改变监控状态，重新拉一次统计
    await get().refreshStats()
    return !current
  },

  startSync: async () => {
    await safe(() => ipc(window.topensync?.startSync), null, '开始同步')
    await get().refreshStats()
  },

  deleteLocalFiles: async (relPaths) => {
    const res = await safe(
      () => ipc(() => window.topensync?.deleteLocalFiles(relPaths)),
      null,
      '删除本地文件'
    )
    const result = res ?? { deleted: 0, failed: relPaths.length }
    // 删完本地文件，清单与统计都会变
    await get().refreshFiles()
    await get().refreshStats()
    return result
  },

  removeTasks: async (taskIds) => {
    const removed = await safe(
      () => ipc(() => window.topensync?.removeTasks(taskIds)),
      null,
      '移除任务记录'
    )
    const count = removed ?? 0
    // 主进程已把记录删了，本地状态也要同步去掉
    if (count > 0) {
      set((s) => ({ tasks: s.tasks.filter((t) => !taskIds.includes(t.id)) }))
    }
    await get().refreshStats()
    return count
  },

  deleteRemoteFiles: async (targets) => {
    const res = await safe(
      () => ipc(() => window.topensync?.deleteRemoteFiles(targets)),
      null,
      '删除远端文件'
    )
    const result = res ?? { deleted: 0, failed: targets.length }
    // 远端删了，差异列表里对应的条目也要消失
    await get().refreshDiffs()
    // 清单也要跟着刷：远端文件被删后，下一轮对账会改写清单里的远端归属
    await get().refreshFiles()
    await get().refreshStats()
    return result
  },

  clearLogs: async () => {
    const removed = await safe(() => ipc(window.topensync?.clearLogs), null, '清空日志')
    // 清空失败时不清本地列表：主进程的日志还在，清空了只是骗自己
    if (removed === null) return 0
    set({ logs: [] })
    return removed
  },

  verifyRemoteFiles: async (relPaths) => {
    const empty: DeepVerifyResult = {
      checked: 0,
      matched: 0,
      mismatched: 0,
      skipped: 0,
      failed: 0,
      details: []
    }
    const res = await safe(
      () => ipc(() => window.topensync?.verifyRemoteFiles(relPaths)),
      null,
      '深度校验'
    )
    const result = res ?? empty
    // 校验会改写清单里的可信级别与同步基准，清单必须跟着刷
    await get().refreshFiles()
    await get().refreshStats()
    return result
  }
}))

/**
 * 把捕获到的异常变成一句能直接给人看的话。
 *
 * IPC 抛出来的错误常带着 "Error invoking remote method 'files:deleteLocal': " 这种
 * 给开发者看的包装前缀，真正有用的是最里层那句原因。
 */
export function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '未知错误'
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

/**
 * 统一兜住 IPC 异常。
 *
 * 为什么需要：这些动作全是 IPC 往返，主进程抛错时 Promise 直接 reject。
 * 没有这层，界面既不报错也不动——用户只看到「点了没反应」，
 * 批量操作还会冒出 unhandled rejection。
 *
 * 失败时把原因记进 lastError，并返回兜底值：
 * 调用方照常走「没有数据」的分支，界面不会崩，也不会把成功当成失败。
 */
async function safe<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    useAppStore.setState({ lastError: `${label}失败：${describeError(e)}` })
    return fallback
  }
}

/**
 * 调 preload 的接口。
 *
 * preload 不存在时（浏览器里直接打开调试页）返回 null，
 * 让调用方走「没有数据」的分支，而不是抛 TypeError。
 */
function ipc<T>(fn: (() => Promise<T> | undefined) | undefined): Promise<T | null> {
  if (!fn) return Promise.resolve(null)
  return Promise.resolve(fn()).then((v) => v ?? null)
}

/**
 * 清单刷新的节流器。
 *
 * 两个目的：
 *
 * 1. **性能**：上传完成是高频事件，一批几百个文件就是几百条任务推送。
 *    每条都拉一次几千行的清单，渲染进程会被自己压死。
 *
 * 2. **别把刷新饿死**。这里原来是防抖（每次事件都重置计时器）——
 *    扫描六万个文件时事件每 80ms 就来一批，计时器**永远等不到**
 *    那 400ms 的静默期，于是扫描全程清单页一次都不刷新。
 *    用户看到的是一直不动的旧列表，以为程序没在干活。
 *    改成节流：最多 1 秒刷一次，首次立刻刷，最后一次补刷。
 *
 * 首次立刻刷的意义：`scan:update` 是在扫描结束的瞬间推的，
 * 那时文件往往还在上传队列里排队，files 表里一行都没有。
 * 立刻刷会拿到空表，但 1 秒后的补刷会拿到真实数据——
 * 两条一起才既有反馈又不会停在空表上。
 */
const FILES_REFRESH_MIN_MS = 1000
let filesRefreshTimer: number | null = null
let filesRefreshAt = 0

function scheduleFilesRefresh(get: () => AppState): void {
  const run = (): void => {
    filesRefreshTimer = null
    filesRefreshAt = Date.now()
    // 后台刷新没有调用方接 promise，失败必须在这里收口
    void safe(() => get().refreshFiles(), undefined, '刷新文件清单')
  }

  const since = Date.now() - filesRefreshAt
  if (since >= FILES_REFRESH_MIN_MS) {
    run()
    return
  }
  // 冷却期内：只挂一个补刷，不重置（重置就又变成防抖了）
  if (filesRefreshTimer !== null) return
  filesRefreshTimer = window.setTimeout(run, FILES_REFRESH_MIN_MS - since)
}

/**
 * 统计刷新的节流器。
 *
 * 为什么需要：主进程的 `transfer:batch` 与 `scan:progress` 都是高频事件。
 * 每收到一条就 `refreshStats()` 意味着一次 IPC 往返 + 主进程
 * 一次 `countByState()` 全表聚合 + 一次差异列表查询。
 *
 * 扫描六万个文件时，即使任务推送已经攒批（80ms 一次），
 * 进度推送仍在以 120ms 的频率触发统计刷新——
 * 不节流的话这条链路会持续占用主进程。
 *
 * 数字晚 400ms 更新，用户完全感知不到；但主进程的负载降一个量级。
 */
let statsRefreshTimer: number | null = null

function scheduleStatsRefresh(get: () => AppState): void {
  if (statsRefreshTimer !== null) return
  statsRefreshTimer = window.setTimeout(() => {
    statsRefreshTimer = null
    // 后台刷新没有调用方接 promise，失败必须在这里收口
    void safe(() => get().refreshStats(), undefined, '刷新统计')
  }, 400)
}

/** 任务的终态：这些状态一出现，清单里的那条记录也定了 */
function isTerminalState(state: TransferTask['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'skipped' || state === 'canceled'
}

/**
 * 把一批任务变更合进现有数组。
 *
 * 一次遍历建索引、一次遍历合并，整批只扫两遍——
 * 而不是「每个任务都 filter 一遍全表」。
 *
 * 顺序说明：新任务追加到末尾（与主进程的创建序一致），
 * 已有任务就地替换（保持它在列表里的位置）。
 */
function mergeTaskBatch(tasks: TransferTask[], batch: TaskBatch): TransferTask[] {
  let base = tasks
  if (batch.removed.length > 0) {
    const drop = new Set(batch.removed)
    base = tasks.filter((t) => !drop.has(t.id))
  }
  if (batch.upserts.length === 0) return base

  const index = new Map<string, number>()
  for (let i = 0; i < base.length; i++) index.set(base[i].id, i)

  const out = base.slice()
  const added: TransferTask[] = []
  for (const t of batch.upserts) {
    const at = index.get(t.id)
    if (at === undefined) added.push(t)
    else out[at] = t
  }
  return added.length > 0 ? out.concat(added) : out
}
