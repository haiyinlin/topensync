import { create } from 'zustand'
import type {
  AppConfig,
  AppSnapshot,
  AppStats,
  ConnectionStatus,
  DeepVerifyResult,
  DiffEntry,
  FileEntry,
  LogEntry,
  ScanProgressPair,
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
      window.topensync?.onTransferUpdate((task) => {
        set((s) => ({
          tasks: [...s.tasks.filter((x) => x.id !== task.id), task],
          // 任务状态变了，统计数字跟着变
          stats: s.stats
            ? { ...s.stats, queued: countBy(s.tasks, task, 'queued'), failed: countBy(s.tasks, task, 'failed') }
            : s.stats
        }))
        // 后台刷新没有调用方接 promise：失败必须在这里收口，否则是 unhandled rejection
        void safe(() => get().refreshStats(), undefined, '刷新统计')
        /*
         * 任务走到终态 = 清单里那条记录的状态也定了
         * （uploading → synced / failed / 已取消）。
         * 这里必须刷，否则清单页会停在「上传中」——
         * 甚至在扫描事件抢跑的空表上永远停着。
         */
        if (task.state === 'done' || task.state === 'failed' || task.state === 'skipped' || task.state === 'canceled') {
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
     * 差异更新。
     *
     * 收到一条差异就把它顶到列表最前面。
     * 但**对账结束后**还要整体重拉一次：
     * 被自动修复掉的差异会从库里消失，只靠增量推送撤不掉。
     */
    track(
      window.topensync?.onDiffUpdate((diff) => {
        set((s) => ({
          diffs:
            // 已处置的差异要从列表里撤掉，而不是置顶。
            // 主进程在用户处置完差异后会推一条 resolvedAt 非空的条目，
            // 不撤的话那一行会永远留在表里，用户以为操作没生效、反复点。
            diff.resolvedAt !== null
              ? s.diffs.filter((d) => d.id !== diff.id)
              : [diff, ...s.diffs.filter((d) => d.id !== diff.id)]
        }))
        void safe(() => get().refreshStats(), undefined, '刷新统计')
      })
    )

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
        void safe(() => get().refreshStats(), undefined, '刷新统计')
      })
    )

    track(
      window.topensync?.onLogAppend((entry) => {
        set((s) => ({ logs: [entry, ...s.logs].slice(0, 500) }))
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
    const files = await safe(
      () => ipc(() => window.topensync?.listFiles({ limit: FILE_PAGE_SIZE })),
      null,
      '刷新文件清单'
    )
    if (files) set({ files, filesLimit: FILE_PAGE_SIZE })
  },

  loadMoreFiles: async () => {
    const current = get().files.length
    const nextLimit = current + FILE_PAGE_SIZE
    const files = await safe(
      () => ipc(() => window.topensync?.listFiles({ limit: nextLimit })),
      null,
      '加载更多文件'
    )
    if (files) set({ files, filesLimit: nextLimit })
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
 * 为什么要节流：扫描结束、上传完成都是**高频事件**——
 * 一批 500 个文件传完就是 500 条 transfer:update。
 * 每条都去拉一次 2000 行的清单，渲染进程会被自己压死。
 *
 * 为什么需要它（不只是性能）：
 * `scan:update` 是在**扫描结束的瞬间**推的，那时文件往往还在上传队列里
 * 排队，files 表里一行都还没有。这时候去拉清单必然拉回空表——
 * 而扫描事件之后不会再有第二次，于是清单页就一直空着。
 * 上传完成才是 files 表真正有内容的时刻，所以那才是该刷新的时机。
 */
let filesRefreshTimer: number | null = null

function scheduleFilesRefresh(get: () => AppState): void {
  if (filesRefreshTimer !== null) window.clearTimeout(filesRefreshTimer)
  filesRefreshTimer = window.setTimeout(() => {
    filesRefreshTimer = null
    // 后台刷新没有调用方接 promise，失败必须在这里收口
    void safe(() => get().refreshFiles(), undefined, '刷新文件清单')
  }, 400)
}

/** 单个任务状态变化后，重算该状态的任务数 */
function countBy(
  tasks: TransferTask[],
  changed: TransferTask,
  state: TransferTask['state']
): number {
  const others = tasks.filter((t) => t.id !== changed.id)
  return [...others, changed].filter((t) => t.state === state).length
}
