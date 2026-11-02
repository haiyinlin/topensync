import chokidar, { type FSWatcher } from 'chokidar'
import { watch as watchNative } from 'fs'
import { readdir, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join } from 'path'
import { ioGovernor, isResourceExhausted } from '../io/governor'
import { tick } from '../io/tick'
import { getExcludeMatcher, hasIgnoredSegment, isExcluded, relativize, toLongPath } from './paths'

/**
 * 本地文件监控（通道 A）。
 *
 * 只负责「本地发生了什么」，产出归一化事件流交给 Planner。
 * 不做任何上传决策，也不碰远端。
 *
 * 三条 Windows 相关的硬约束：
 * - 长路径：访问本地 FS 时加 `\\?\` 前缀，否则超 260 字符的路径 stat 失败
 * - 目录联接/符号链接：不跟随（followSymlinks: false），否则无限递归
 * - 云盘占位文件（OneDrive / 坚果云的重解析点）：不跟随、读不到就跳过，
 *   不反复重试——那类文件一旦被访问会被云盘客户端强制拉取正文，
 *   反复重试等于反复拉取，浪费上行
 */

export type WatchEventType = 'upsert' | 'remove'

/**
 * 监控模式。
 *
 * - `watch`：chokidar（跨平台，但**每个目录一个句柄**）
 * - `native`：Windows 原生递归监听（`fs.watch({recursive:true})`，
 *   **整棵树只占一个句柄**）
 * - `poll`：定时遍历目录树做差异比对。没有实时性，但几乎不占句柄
 *
 * 为什么需要 native：chokidar 在 Windows 上对每个目录各开一个
 * `ReadDirectoryChangesW`，整块盘（上万个目录）必然 `EMFILE`。
 * 而 Win32 的 `ReadDirectoryChangesW` 本身支持 `bWatchSubtree=TRUE`——
 * 一个句柄看整棵树，Node 把它暴露成 `fs.watch(root, {recursive:true})`。
 * 实测整盘（SMB 映射盘，3.8 TB）：建监听 14 ms，普通改动 100% 收到事件。
 *
 * ⚠️ native 模式的硬限制：**突发大量变更会丢事件**。
 * Windows 的变更缓冲只有几十 KB，一次拷几千个文件进来时缓冲溢出，
 * 系统丢弃事件且不重发（实测：本地 NTFS 上 1500 个文件 / 0.57 秒，
 * 只收到 1 条）。所以 native 模式必须配两样东西：
 * 1. 突发检测 → 安静后对涉及的目录做局部重扫（见 onNativeEvent）
 * 2. 周期性全树比对兜底（见 startSafetyScan）
 *
 * 这两样加起来才能保证「最终一致」，光靠监听一定漏文件。
 */
export type WatchMode = 'watch' | 'native' | 'poll'

/** 连续多少次 watch/scandir 错误后判定「实时监听不可用」 */
const WATCH_ERROR_LIMIT = 8
/** 错误统计窗口：只有短时间内的密集报错才算「不可用」 */
const WATCH_ERROR_WINDOW_MS = 60_000
/** 同类错误最多往上报几条（其余只计数，避免把日志刷满） */
const WATCH_ERROR_LOG_MAX = 3

/**
 * 降级后默认的轮询间隔。
 *
 * 每轮要把目录树 stat 一遍（六万文件在本地盘约十几秒，网络盘更久），
 * 所以不能太密；但备份场景 5 分钟的可见延迟是可接受的——
 * 对比「实时监听完全失效、文件永远不同步」，这个延迟是明确更优的取舍。
 */
const DEFAULT_POLL_INTERVAL_MS = 300_000

/** 轮询时每处理多少个文件让出一次事件循环 */
const POLL_YIELD_EVERY = 500

/** 全树兜底比对的默认间隔：30 分钟 */
const DEFAULT_SAFETY_SCAN_MS = 30 * 60_000

/** native 模式的单路径稳定窗口：事件停止这么久之后才去 stat */
const NATIVE_SETTLE_MS = 900

/** 稳定校验的间隔与轮数：文件还在写就等它写完（最多 ~9 秒） */
const NATIVE_STABLE_STEP_MS = 1_200
const NATIVE_STABLE_ROUNDS = 7

/** 突发检测窗口与阈值 */
const NATIVE_BURST_WINDOW_MS = 1_000
const NATIVE_BURST_LIMIT = 120

/** 两次兜底比对的最小间隔（突发可能连着来，别把盘扫穿） */
const SAFETY_MIN_GAP_MS = 5 * 60_000
/** 突发结束后多久补一轮局部/全树比对 */
const BURST_SETTLE_MS = 8_000

export interface WatchEvent {
  type: WatchEventType
  /** 相对同步根的 POSIX 路径 */
  relPath: string
  /** 本地绝对路径 */
  absPath: string
  /** 事件来源：首次全量扫描 vs 增量事件 */
  origin: 'initial' | 'change'
  /**
   * 是否是目录事件。
   *
   * 文件事件默认同步文件本身；目录事件只关心「空目录是否需要在远端建出来」，
   * 因此与文件分开标记，上层才能区别对待。
   */
  isDir?: boolean
}

export interface WatcherOptions {
  root: string
  /** 排除规则（glob） */
  exclude: string[]
  /** 同一路径的事件合并窗口（毫秒），默认 500 */
  debounceMs?: number
  onEvent: (event: WatchEvent) => void | Promise<void>
  /** 首次全量扫描完成 */
  onReady?: (count: number) => void
  /**
   * 全树遍历的进度（每 500 个文件一次）。
   *
   * 整块盘的首轮遍历要五到十分钟（SMB 上 stat 约 200 文件/秒），
   * 没有这个回调，界面在那十分钟里会一直显示「已扫描 0 个文件」，
   * 用户没法判断程序是在干活还是卡住了。
   */
  onProgress?: (done: number) => void
  /**
   * 一轮遍历（首轮或兜底比对）结束。
   *
   * 界面上那个进度条要靠它收尾——只推「进行中」不推终态，
   * 进度条会永远挂着，用户以为还在扫。
   */
  onScanEnd?: (count: number, initial: boolean) => void
  onError?: (err: Error) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * 监控模式发生变化（实时监听失效 → 轮询，或反之）。
   *
   * 上层用它更新界面状态并写一条**人话**日志：用户必须知道
   * 「现在是定时比对」——否则他会奇怪为什么改完文件过几分钟才同步。
   */
  onModeChange?: (mode: WatchMode, reason: string) => void
  /** 强制轮询模式（测试与「网络盘」手动降级用） */
  forcePolling?: boolean
  /**
   * 强制使用某个模式（主要给测试与排障用）。
   *
   * `auto`（默认）：Windows 走 native，其它平台走 chokidar；
   * native 打不开时退回 chokidar；chokidar 句柄耗尽时退回 poll。
   */
  mode?: WatchMode | 'auto'
  /** 轮询间隔（毫秒），默认 5 分钟 */
  pollIntervalMs?: number
  /**
   * 全树兜底比对的间隔（毫秒），默认 30 分钟；`0` 表示关闭。
   *
   * 为什么必须有：native 监听在突发写入时会丢事件（见 WatchMode 的说明），
   * 丢了就没有任何补偿机制。这一轮全树比对是最后的收敛保证。
   *
   * 为什么是 30 分钟：实测这块 SMB 盘全树 stat 约 200 文件/秒
   * （6 万文件 ≈ 5 分钟），跑太密会长期占着网络与主线程。
   */
  safetyScanMs?: number
  /**
   * 已入库的基准快照：`相对路径 → size:mtimeMs` 指纹。
   *
   * 为什么需要它：用户已经在上一轮把整块盘扫完、清单里有几万条记录了，
   * 此时再点「开始同步」**不该**又跑一遍全盘遍历——那 5~10 分钟的
   * stat 风暴会跟正在进行的上传抢主线程，还顺手把「已同步」的文件
   * 重新走一遍判重、写成「已跳过」。
   *
   * 传了这个快照（且非空）时，`start()` 会**跳过首次全盘扫描**，
   * 直接用快照建立差异比对基准，监听照常实时起。只有没传（首次启动、
   * 清单为空）时才全盘扫一遍把基准建起来。
   */
  initialSnapshot?: Map<string, string>
}
/** chokidar 递归深度上限，防止病态目录把进程拖死 */
const MAX_DEPTH = 24

/**
 * 扫描事件的并发窗口。
 *
 * 32 是实测出来的数：定 4 时 4000 个文件要 15 秒（每个都被 await 串起来），
 * 五万个文件就是几分钟，用户会以为扫描卡死；32 时同样的量 1.7 秒。
 *
 * 窗口本身**不负责句柄安全**——真正同时打开的文件数由 IO 闸门压到 8 以内
 * （见 io/governor.ts）。这里只做一件事：别让待处理的事件无限堆积。
 */
const RESCAN_WINDOW = 32

export class Watcher {
  private watcher: FSWatcher | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 每个路径最后一次事件；防抖窗口结束时据此决定发 upsert 还是 remove */
  private readonly pending = new Map<
    string,
    { type: WatchEventType; origin: WatchEvent['origin']; isDir: boolean }
  >()
  /** 防抖窗口内的原始路径，Windows 大小写不敏感 */
  private readonly pendingAbs = new Map<string, string>()
  private initialDone = false
  /** 已发现的文件路径（小写去重键）；用于 ready 时报真实数量 */
  private readonly discovered = new Set<string>()
  /** watcher 已停止；挡住 close() 完成前残余的事件 */
  private stopped = false
  /** 进行中的扫描（同一时刻只允许一轮） */
  private scanPromise: Promise<number> | null = null
  /** 扫描期间在飞的事件处理（窗口背压用） */
  private readonly rescanInflight: Array<Promise<void>> = []
  private lastReadyAt: number | null = null
  /** 当前监控模式；见 WatchMode 的说明 */
  private mode: WatchMode = 'watch'
  /** 轮询定时器（仅 poll 模式） */
  private pollTimer: NodeJS.Timeout | null = null
  /** 是否正在做全树/子树比对（上一轮没跑完就不再起新一轮） */
  private comparing = false
  /**
   * 轮询模式的「上一轮看到的样子」：相对路径 → `size:mtimeMs`。
   *
   * 只存指纹不存完整元信息：一轮几十万个条目时，
   * 一个短字符串比一个对象省一个数量级的内存。
   */
  private readonly pollSnapshot = new Map<string, string>()
  /** 本窗口内的 watch 错误计数与首次时间 */
  private watchErrorCount = 0
  private watchErrorSince = 0
  /** 同类错误已经往上报了几条 */
  private watchErrorLogged = 0
  /** native 模式的递归监听器（整棵树只有这一个句柄） */
  private nativeWatcher: ReturnType<typeof watchNative> | null = null
  /** native 模式下按路径的稳定窗口定时器 */
  private readonly nativeTimers = new Map<string, NodeJS.Timeout>()
  /** 全树兜底比对定时器 */
  private safetyTimer: NodeJS.Timeout | null = null
  /** 突发结束后补扫的一次性定时器 */
  private burstTimer: NodeJS.Timeout | null = null
  /** 上一次全树比对开始的时刻（防止扫穿） */
  private lastSafetyAt = 0
  /** 突发计数窗口 */
  private burstWindowAt = 0
  private burstCount = 0
  /** 本次突发涉及的顶层目录（相对同步根），安静后局部重扫 */
  private readonly burstDirs = new Set<string>()

  constructor(private readonly opts: WatcherOptions) {
    if (opts.mode && opts.mode !== 'auto') this.mode = opts.mode
    else if (opts.forcePolling) this.mode = 'poll'
    else if (process.platform === 'win32') this.mode = 'native'
  }

  get isWatching(): boolean {
    // 已停止（暂停 / 退出）就是没在监控——轮询模式下没有 chokidar
    // 实例，不能靠「watcher 为 null」来推断
    if (this.stopped) return false
    return this.watcher !== null || this.nativeWatcher !== null || this.mode === 'poll'
  }

  /** 当前监控模式（界面上要说清楚是实时还是定时） */
  get watchMode(): WatchMode {
    return this.mode
  }

  get lastScanAt(): number | null {
    return this.lastReadyAt
  }

  start(): void {
    if (this.watcher || this.pollTimer || this.nativeWatcher) return
    const { root } = this.opts
    this.stopped = false
    this.watchErrorCount = 0
    this.watchErrorLogged = 0

    // 有已入库的基准快照 → 跳过首次全盘扫描，直接用它建立比对基准
    if (this.opts.initialSnapshot && this.opts.initialSnapshot.size > 0) {
      for (const [rel, fp] of this.opts.initialSnapshot) {
        this.pollSnapshot.set(rel, fp)
      }
      this.initialDone = true
      this.lastReadyAt = Date.now()
    }

    /*
     * 强制轮询（或已经降级过）：不建任何监听。
     *
     * 降级是**单向**的：重新尝试实时监听只会把已经稳定跑着的轮询打断，
     * 再撞一次同样的失败。
     */
    if (this.mode === 'poll') {
      this.startPolling()
      return
    }

    // 原生递归监听：一个句柄看整棵树，先试它
    if (this.mode === 'native') {
      if (this.startNative()) return
      // 打不开（不支持递归 / 权限 / 网络盘异常）→ 退回 chokidar 再试
      this.mode = 'watch'
      this.opts.onModeChange?.('watch', '原生递归监听不可用，退回逐目录监听')
    }

    this.watcher = chokidar.watch(toLongPath(root), {
      // 自行判定忽略项：chokidar 的 glob 匹配对 Windows 路径分隔符不友好
      ignored: (p: string) => this.shouldIgnore(p),
      persistent: true,
      /*
       * 初始全量扫描**不交给 chokidar**，交给下面的 rescan()。
       *
       * 这是这一版最重要的一处改动。chokidar 在 `ignoreInitial: false` 时
       * 会为每个既有文件各起一个 awaitWriteFinish 轮询（每 100ms 一次 stat，
       * 直到文件连续 2 秒不再变化）。真实用户把整块盘（5.8 万个文件）
       * 设为同步根，于是同一时刻有 5.8 万个轮询在跑——每秒几十万次 stat，
       * 直接把驱动器的句柄吃光，连 `fs.watch` 都建不起来：
       * `EMFILE: too many open files, watch 'Z:\...\IMG_8278.JPG'`。
       *
       * 既有文件不需要「等写完」——它们早就写完了。真正的写入检测
       * 只对增量事件有意义，所以 ignoreInitial 之后 awaitWriteFinish
       * 只作用于 live 事件，既保住正确性，也把初始开销降为一次目录遍历。
       */
      ignoreInitial: true,
      // 编辑器「删除+重建」合并为单次 change
      atomic: true,
      // 写完成判定：文件停止变化 2 秒才算写完
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      // 不跟随符号链接与目录联接
      followSymlinks: false,
      depth: MAX_DEPTH
    })

    this.watcher
      .on('add', (p) => this.onFsEvent(p, 'upsert', false))
      .on('change', (p) => this.onFsEvent(p, 'upsert', false))
      .on('unlink', (p) => this.onFsEvent(p, 'remove', false))
      // 目录事件：用于空目录同步。非空目录由其下文件上传时自动建出，
      // 所以只有空目录才需要单独在远端创建。
      .on('addDir', (p) => this.onFsEvent(p, 'upsert', true))
      .on('unlinkDir', (p) => this.onFsEvent(p, 'remove', true))
      .on('error', (err) => {
        const e = err instanceof Error ? err : new Error(String(err))
        this.handleWatchError(e)
      })
      .on('ready', () => {
        this.initialDone = true
        this.lastReadyAt = Date.now()
        /*
         * 有已入库的基准快照 → 不重扫整盘，直接上报就绪。
         *
         * 首次扫描只在「没有快照」时才跑（见 start() 里对
         * initialSnapshot 的处理）。chokidar 的 ready 只是说
         * 「增量监听就绪了」，不代表一定要再走一遍全树。
         */
        if (this.pollSnapshot.size > 0) {
          this.opts.onReady?.(this.pollSnapshot.size)
          return
        }
        /*
         * 初始扫描自己走一遍目录树（见上方 ignoreInitial 的说明）。
         *
         * 不 await：ready 的回调一旦被长时间占住，chokidar 内部队列会跟着堵，
         * 增量事件全都不派发了。这里只负责发起，进度与就绪由 rescan 自己报。
         */
        void this.initialScan().catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err))
          this.opts.onError?.(e)
        })
      })
  }

  /**
   * 首次全量扫描：走一遍目录树，把每个文件作为 upsert 事件喂给上层。
   *
   * 与 rescan() 完全同一条路径——区别只是触发时机（chokidar ready）。
   * 两者共用一份实现，避免「初始扫描」和「手动重扫」行为漂移。
   */
  private async initialScan(): Promise<void> {
    if (this.stopped) return
    await this.rescan()
  }

  // ── 原生递归监听（Windows）─────────────────────────────

  /**
   * 用一个句柄监听整棵树。
   *
   * `fs.watch(root, { recursive: true })` 在 Windows 上就是
   * `ReadDirectoryChangesW(bWatchSubtree = TRUE)`：操作系统负责整棵子树的
   * 变更通知，**新建的子目录自动包含**，不需要我们逐个目录去挂。
   *
   * @returns 是否成功建立监听
   */
  private startNative(): boolean {
    const { root } = this.opts
    try {
      this.nativeWatcher = watchNative(toLongPath(root), {
        recursive: true,
        persistent: true
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.onLog?.('warn', `原生递归监听不可用（${message}），改用逐目录监听`)
      this.nativeWatcher = null
      return false
    }

    this.nativeWatcher.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err))
      this.handleNativeError(e)
    })
    /*
     * change：内容被改写；rename：创建 / 删除 / 改名。
     *
     * 两者都不能直接当作「新增」或「删除」——rename 只说「这个名字动了」，
     * 到底是建了还是删了，只能 stat 一次才知道。所以统一走
     * onNativeEvent → 稳定窗口 → stat 判定。
     */
    this.nativeWatcher.on('change', (_event, filename) => this.onNativeEvent(filename))
    this.nativeWatcher.on('rename', (_event, filename) => this.onNativeEvent(filename))

    this.opts.onLog?.('info', '已启用整树单句柄监听（实时）')

    // 兜底：周期全树比对，补上丢掉的变更（不管首扫不首扫都要挂）
    this.startSafetyScan()

    if (this.initialDone && this.pollSnapshot.size > 0) {
      /*
       * 已有入库的基准快照 → 不重扫整盘。
       *
       * 直接把「就绪」上报，放行等待中的对账；增量监听照常实时工作。
       * 漏掉的变化由上面的周期兜底比对补齐，不会永久丢失。
       */
      this.opts.onReady?.(this.pollSnapshot.size)
      return true
    }

    // 首次全树：把磁盘现状喂给上层，同时建立差异比对的基准
    void this.scanAndCompare(true).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      this.opts.onError?.(e)
    })
    return true
  }

  /**
   * 原生监听的一条事件。
   *
   * 两件事：给这条路径排一个稳定窗口；以及做**突发检测**——
   * 一秒内超过阈值就说明正在批量拷东西，那时候 Windows 的变更缓冲
   * 几乎一定会溢出（事件被丢弃、不报错、不重发），必须在安静之后
   * 对涉及的目录补扫一遍。
   */
  private onNativeEvent(rawName: string | Buffer | null): void {
    if (this.stopped) return
    // 平台可能给 Buffer（编码未定时），统一转成字符串
    const filename = rawName === null ? null : typeof rawName === 'string' ? rawName : rawName.toString()
    if (!filename) {
      // 平台没给名字（或缓冲溢出丢了信息）：只能靠兜底比对
      this.scheduleSafetyScanSoon(BURST_SETTLE_MS)
      return
    }

    const rel = filename.replace(/\\/g, '/')
    if (isExcluded(rel, this.opts.exclude)) return
    if (hasIgnoredSegment(rel)) return
    // 根目录自身的事件（没有相对路径）交给兜底比对
    if (rel === '') return

    const abs = join(this.opts.root, rel)
    const key = abs.toLowerCase()

    this.trackBurst(rel)

    const existing = this.nativeTimers.get(key)
    if (existing) clearTimeout(existing)
    this.nativeTimers.set(
      key,
      setTimeout(() => {
        this.nativeTimers.delete(key)
        void this.resolveNative(abs)
      }, NATIVE_SETTLE_MS)
    )
  }

  /** 突发计数；跨过阈值就记下涉及的顶层目录，安静后补扫 */
  private trackBurst(rel: string): void {
    const now = Date.now()
    if (now - this.burstWindowAt > NATIVE_BURST_WINDOW_MS) {
      this.burstWindowAt = now
      this.burstCount = 0
    }
    this.burstCount++
    if (this.burstCount < NATIVE_BURST_LIMIT) return

    // 只记这次突发的顶层目录：拷贝通常是「往某个目录里塞东西」，
    // 补扫那个目录就够，不必扫整盘
    const top = rel.split('/')[0]
    if (top) this.burstDirs.add(top)
    this.scheduleSafetyScanSoon(BURST_SETTLE_MS)
  }

  /**
   * 稳定窗口到期后判定这个路径到底是什么。
   *
   * 判定的核心是「文件是不是还在写」：还在写就等下一轮，
   * 连续两轮 size 与 mtime 都没变才算写完。等不下去（大文件拷了
   * 十几秒仍只有一个事件）就先发出去——上传阶段还有一次 mtime 复核
   * 兜底（变了就重传），不会把半个文件当成完整内容传上去。
   */
  private async resolveNative(absPath: string): Promise<void> {
    if (this.stopped) return
    const rel = relativize(this.opts.root, absPath)
    if (rel === null || rel === '') return

    let prev: { size: number; mtimeMs: number } | null = null
    for (let round = 0; round < NATIVE_STABLE_ROUNDS; round++) {
      let st
      try {
        st = await ioGovernor.run(() => stat(toLongPath(absPath)))
      } catch {
        // 不在了 → 删除。目录被删时其下文件各自也会走到这里
        await this.emitEvent({
          type: 'remove',
          relPath: rel,
          absPath,
          origin: 'change'
        })
        return
      }

      if (st.isDirectory()) {
        // 目录事件只关心「空目录要不要在远端建出来」
        await this.emitEvent({
          type: 'upsert',
          relPath: rel,
          absPath,
          origin: 'change',
          isDir: true
        })
        return
      }

      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        this.discovered.add(absPath.toLowerCase())
        await this.emitEvent({
          type: 'upsert',
          relPath: rel,
          absPath,
          origin: 'change'
        })
        return
      }

      prev = { size: st.size, mtimeMs: st.mtimeMs }
      await sleep(NATIVE_STABLE_STEP_MS)
    }

    // 等了足够久还在变：先交出去，交上层用 mtime 复核挡住半截文件
    this.discovered.add(absPath.toLowerCase())
    await this.emitEvent({ type: 'upsert', relPath: rel, absPath, origin: 'change' })
  }

  /** 处理原生监听的 error */
  private handleNativeError(err: Error): void {
    const message = err.message
    this.opts.onLog?.('error', `整树监听出错：${message}`)
    this.opts.onError?.(err)

    /*
     * 监听本身坏了（句柄被回收、路径被卸载）→ 降到定时比对。
     *
     * 注意不能只重建监听：如果盘已经断开，重建会立刻再失败一次；
     * 而定时比对至少还能在盘回来之后自己恢复。
     */
    if (/ENOSPC|EMFILE|ENFILE|EPERM|EINVAL|too many open files/i.test(message)) {
      this.degradeToPolling(`整树监听不可用（${message.slice(0, 80)}）`)
      return
    }
    // 其它错误（偶发的崩溃）→ 重建一次监听
    void this.nativeWatcher?.close()
    this.nativeWatcher = null
    if (!this.stopped) this.startNative()
  }

  /** 启动周期性全树兜底比对 */
  private startSafetyScan(): void {
    const period = this.opts.safetyScanMs ?? DEFAULT_SAFETY_SCAN_MS
    if (period <= 0) return
    if (this.safetyTimer) clearInterval(this.safetyTimer)
    this.safetyTimer = setInterval(() => {
      void this.scanAndCompare(false)
    }, Math.max(60_000, period))
    this.safetyTimer.unref?.()
  }

  /**
   * 尽快补一轮比对（突发结束、事件丢信息时用）。
   *
   * 有最小间隔：一次拷贝会连着触发很多次，不能每次都扫全盘。
   */
  private scheduleSafetyScanSoon(delayMs = BURST_SETTLE_MS): void {
    if (this.burstTimer) return
    const since = Date.now() - this.lastSafetyAt
    const wait = Math.max(delayMs, SAFETY_MIN_GAP_MS - since)
    this.burstTimer = setTimeout(() => {
      this.burstTimer = null
      void this.scanAndCompare(false)
      // 补扫完，攒下的突发目录就不用再单独处理了
      this.burstDirs.clear()
    }, wait)
    this.burstTimer.unref?.()
  }

  /**
   * 全树（或子树）指纹比对。
   *
   * 这是 native / poll 两种模式共用的收敛机制：遍历磁盘，
   * 与上一轮的 `size:mtime` 指纹比，只把真正变化的路径交给上层。
   *
   * @param initial 首次全树：把每个文件都当作新增发出去，并建立基准
   */
  private async scanAndCompare(initial: boolean, onProgress?: (done: number) => void): Promise<number> {
    if (this.stopped) return 0
    if (this.comparing) return 0
    this.comparing = true
    this.lastSafetyAt = Date.now()

    try {
      const current = new Map<string, string>()
      let count = 0

      await scanLocalTree({
        root: this.opts.root,
        exclude: this.opts.exclude,
        shouldStop: () => this.stopped,
        withStat: true,
        onFile: async (rel, abs, done, info) => {
          const fingerprint = `${info?.size ?? 0}:${Math.round(info?.mtimeMs ?? 0)}`
          current.set(rel, fingerprint)
          count = done

          const prev = this.pollSnapshot.get(rel)
          if (!initial && prev === fingerprint) return

          this.discovered.add(abs.toLowerCase())
          await this.emitEvent({
            type: 'upsert',
            relPath: rel,
            absPath: abs,
            origin: 'change',
            isDir: false
          })

          if (done % POLL_YIELD_EVERY === 0) {
            onProgress?.(done)
            this.opts.onProgress?.(done)
            await tick()
          }
        }
      })

      if (this.stopped) return count

      // 上一轮有、这一轮没有 → 删除了
      for (const rel of this.pollSnapshot.keys()) {
        if (current.has(rel)) continue
        const abs = join(this.opts.root, rel)
        await this.emitEvent({ type: 'remove', relPath: rel, absPath: abs, origin: 'change' })
      }

      this.pollSnapshot.clear()
      for (const [rel, fp] of current) this.pollSnapshot.set(rel, fp)

      await Promise.all(this.rescanInflight)
      this.rescanInflight.length = 0

      if (this.stopped) return count
      this.initialDone = true
      this.lastReadyAt = Date.now()
      this.opts.onScanEnd?.(count, initial)
      if (initial) {
        this.opts.onReady?.(count)
        this.opts.onLog?.('info', `本地扫描完成，共 ${count} 个文件`)
      }
      return count
    } finally {
      this.comparing = false
    }
  }

  stop(): void {
    /*
     * 先把「已停止」标记打上，再关 watcher。
     *
     * chokidar 的 close() 是异步的，在它真正 resolve 之前 watcher
     * 仍在派发事件。这些事件会走完防抖窗口 → 触发 onEvent →
     * 进上传队列 —— 用户点了「暂停同步」，文件却还在传。
     *
     * 光靠 `this.watcher = null` 挡不住：事件回调里检查的是
     * 自己的引用，不是这个字段。所以用一个显式标志位，
     * 在事件入口就把它拦掉。
     */
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
    this.pendingAbs.clear()
    void this.watcher?.close()
    this.watcher = null
    void this.nativeWatcher?.close()
    this.nativeWatcher = null
    for (const t of this.nativeTimers.values()) clearTimeout(t)
    this.nativeTimers.clear()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer)
      this.safetyTimer = null
    }
    if (this.burstTimer) {
      clearTimeout(this.burstTimer)
      this.burstTimer = null
    }
    this.burstDirs.clear()
    this.pollSnapshot.clear()
    this.initialDone = false
  }

  // ── 监控模式 ──────────────────────────────────────────

  /**
   * 处理 chokidar 的 error 事件。
   *
   * 两件事：
   * 1. **降噪**。整块盘同步时同一类错误会成片出现（截图里几十条
   *    `EMFILE ... watch Z:\...`），逐条写库+推前端只会把真正有用的
   *    信息淹掉，还额外给已经卡住的主线程加活。
   * 2. **判定不可用 → 降级到轮询**。短时间内密集出现句柄/监听类错误，
   *    说明这台机器上实时监听根本建不起来，再重试也只是重复失败。
   */
  private handleWatchError(err: Error): void {
    const message = err.message
    const isHandleIssue =
      isResourceExhausted(err) ||
      /too many open files|scandir|unknown error, watch|EMFILE|ENFILE/i.test(message)

    // 与句柄无关的错误（权限、路径消失）：报一次就够，且不参与降级判定
    if (!isHandleIssue) {
      this.opts.onError?.(err)
      this.opts.onLog?.('error', `监控出错：${message}`)
      return
    }

    const now = Date.now()
    if (this.watchErrorSince === 0 || now - this.watchErrorSince > WATCH_ERROR_WINDOW_MS) {
      this.watchErrorSince = now
      this.watchErrorCount = 1
      this.watchErrorLogged = 0
    } else {
      this.watchErrorCount++
    }

    if (this.watchErrorLogged < WATCH_ERROR_LOG_MAX) {
      this.watchErrorLogged++
      this.opts.onError?.(err)
      this.opts.onLog?.('error', `监控出错：${message}`)
      if (this.watchErrorLogged === WATCH_ERROR_LOG_MAX) {
        this.opts.onLog?.(
          'warn',
          '同类监控错误后续不再逐条记录（实时监听的句柄数已接近上限）'
        )
      }
    }

    if (this.watchErrorCount >= WATCH_ERROR_LIMIT && this.mode === 'watch') {
      this.degradeToPolling(
        `实时监听无法建立（${this.watchErrorCount} 次句柄不足：${message.slice(0, 80)}）`
      )
    }
  }

  /**
   * 从实时监听降级为定时比对。
   *
   * 不能只是「关掉 chokidar 然后什么都不做」——那等于彻底不监控了。
   * 降级后立刻做一轮完整遍历（把当前目录树喂给上层，该传的照传），
   * 然后按固定间隔做差异比对。
   */
  private degradeToPolling(reason: string): void {
    if (this.mode === 'poll') return
    this.mode = 'poll'
    void this.watcher?.close()
    this.watcher = null
    // 原生监听也要关掉：留着它只会继续丢事件，白占一个句柄
    void this.nativeWatcher?.close()
    this.nativeWatcher = null
    for (const t of this.nativeTimers.values()) clearTimeout(t)
    this.nativeTimers.clear()
    this.opts.onModeChange?.('poll', reason)
    this.opts.onLog?.(
      'warn',
      `已切换为定时比对模式：${reason}。` +
        `实时监听在整盘 / 网络盘上会耗尽文件句柄，改用每 ${Math.round(
          (this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) / 1000
        )} 秒遍历一次目录树比对变化（文件改动最多延迟这么久被发现）。`
    )
    this.startPolling()
  }

  /** 启动轮询：先做一轮完整遍历，再按间隔做差异比对 */
  private startPolling(): void {
    if (this.pollTimer || this.stopped) return
    if (this.mode !== 'poll') return
    /*
     * 有已入库的基准快照 → 跳过首轮完整遍历，直接进入周期比对。
     *
     * 首轮遍历在整盘场景下是 5~10 分钟的 stat 风暴，重启 / 重新开始同步
     * 时不该每次都重跑一遍——快照已经在上次跑过了。
     */
    if (this.initialDone && this.pollSnapshot.size > 0) {
      this.opts.onReady?.(this.pollSnapshot.size)
    } else {
      void this.pollOnce(true).catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err))
        this.opts.onError?.(e)
      })
    }
    const interval = Math.max(5_000, this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.pollTimer = setInterval(() => {
      void this.pollOnce(false).catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err))
        this.opts.onError?.(e)
      })
    }, interval)
    this.pollTimer.unref?.()
  }

    /**
   * 比对一轮（定时比对与兜底比对共用）。
   *
   * 只是 scanAndCompare 的别名：保留这个名字是因为它读起来更直白——
   * 「轮询一轮」说的就是这件事。
   */
  private pollOnce(initial: boolean, onProgress?: (done: number) => void): Promise<number> {
    return this.scanAndCompare(initial, onProgress)
  }

/**
   * 强制全量重扫一次。
   *
   * 为什么要有这个方法，而不是靠「停掉再重建 watcher」实现：
   *
   * 重建有两个硬伤：
   * 1. chokidar 的 `close()` 是异步的。旧实例的 close 还没走完，
   *    新实例就已经在同一个目录上起了——两个 watcher 同时监听，
   *    新实例可能收不到初始 `add` 事件（目录已被旧实例标记为已就绪）。
   * 2. 重建会把 `initialDone` 复位、`scannedCount` 从 0 重新数，
   *    界面上的「已扫描 N 个文件」数字在重扫期间**看起来毫无变化**，
   *    用户点完按钮看到的就是「什么都没发生」。
   *
   * 这里的做法是**不重建**：自己走一遍目录树，把每个文件作为
   * `upsert` 事件重新喂给上层。上层（Planner）拿它跟清单比对，
   * 该传的还是传、该跳过的还是跳过——但用户能看到计数变化、
   * 能看到队列里新增的任务，行为是**可观察**的。
   *
   * 顺带把「本地文件已被删除」的情况也识别出来：
   * 重扫时顺便对照清单，发现清单里有、磁盘上没有的，产出 `remove` 事件。
   *
   * @param onProgress 每发现一个文件回调一次（已扫描计数）。
   *   目录树事先数不出总量，所以只能给计数、不给百分比——
   *   但有反馈比没反馈好，界面不会看着像卡死。
   */
  async rescan(onProgress?: (done: number) => void): Promise<number> {
    /*
     * 同一时刻只允许一轮扫描。
     *
     * 启动后 chokidar ready 会自动跑一轮；用户紧接着点「扫描本地」
     * 会再发起一轮——两轮并行只是把同样的事件发两遍，
     * 白白多读两遍盘、多耗一倍句柄。这里直接复用进行中的那一轮。
     */
    if (this.scanPromise) return this.scanPromise
    /*
     * 轮询 / 原生模式下「扫描本地」走比对那一套：
     * 它会顺带更新差异快照，否则下一轮比对会把所有文件当成变化再发一遍。
     */
    if (this.mode === 'poll' || this.mode === 'native') {
      this.scanPromise = this.pollOnce(true, onProgress).finally(() => {
        this.scanPromise = null
      })
      return this.scanPromise
    }
    this.scanPromise = this.doRescan(onProgress).finally(() => {
      this.scanPromise = null
    })
    return this.scanPromise
  }

  private async doRescan(onProgress?: (done: number) => void): Promise<number> {
    const root = this.opts.root
    // -1 表示「没扫描」而不是「扫到 0 个文件」，两者在界面上是两件事
    if (!root) return -1

    this.rescanInflight.length = 0

    const count = await scanLocalTree({
      root,
      exclude: this.opts.exclude,
      shouldStop: () => this.stopped,
      onFile: async (rel, abs, done) => {
        this.discovered.add(abs.toLowerCase())
        onProgress?.(done)
        await this.emitEvent({
          type: 'upsert',
          relPath: rel,
          absPath: abs,
          origin: 'change',
          isDir: false
        })
      }
    })

    // 把窗口里剩下的收干净，否则上层还在处理时我们就报了「就绪」
    await Promise.all(this.rescanInflight)
    this.rescanInflight.length = 0

    if (this.stopped) return count

    this.lastReadyAt = Date.now()
    this.opts.onReady?.(count)
    this.opts.onLog?.('info', `本地扫描完成，共 ${count} 个文件`)
    return count
  }

  /**
   * 把一条扫描事件交给上层，并按窗口做背压。
   *
   * 为什么要有窗口：上层处理一个文件要 stat、查清单、可能写库，都是异步的。
   * 一次重扫如果发完就走，五万个事件会同时推进 Planner，
   * 同一时刻五万个 `stat` 在飞——句柄当场被吃光（EMFILE），
   * 事件循环也被微任务淹没，表现就是「点任何按钮都没反应」。
   */
  private async emitEvent(event: WatchEvent): Promise<void> {
    const ret = this.opts.onEvent(event)
    if (ret && typeof ret.then === 'function') {
      this.rescanInflight.push(
        ret.catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err))
          this.opts.onError?.(e)
        })
      )
    }
    if (this.rescanInflight.length >= RESCAN_WINDOW) {
      const oldest = this.rescanInflight.shift()
      if (oldest) await oldest
    }
  }

  // ── 内部 ──────────────────────────────────────────────

  private shouldIgnore(absPath: string): boolean {
    const rel = relativize(this.opts.root, absPath)
    // 根目录本身不忽略；不在根内的路径交给上层判断
    if (rel === null || rel === '') return false
    if (isExcluded(rel, this.opts.exclude)) return true
    if (hasIgnoredSegment(rel)) return true
    return false
  }

  /**
   * 事件归一化：同一路径的连续事件在防抖窗口内合并。
   *
   * 合并规则：窗口内最后到达的事件类型胜出。
   * 这样「先 unlink 后 add」（编辑器保存）会收敛成 upsert，
   * 而「先 add 后 unlink」收敛成 remove。
   */
  private onFsEvent(absPath: string, type: WatchEventType, isDir: boolean): void {
    // 已停止：close() 未完成期间到达的残余事件，一律丢弃
    if (this.stopped) return
    const key = absPath.toLowerCase()
    const debounceMs = this.opts.debounceMs ?? 500

    /*
     * 「已发现的文件数」在事件到达时就记。
     *
     * 以前 scannedCount 是在防抖窗口结束（500ms 后）才 ++，
     * 而 chokidar 的 ready 事件在初始 add 全部投递完就立刻触发——
     * 那一刻计数还是 0，于是「本地扫描就绪，发现 0 个文件」。
     * 概览页的「已扫描 N 个文件」也跟着显示 0。
     *
     * 用一个独立的集合按**路径**去重：change 事件改的是同一个文件，
     * 不该重复计数；而 rescan() 自己算的 fileCount 也不会跟它打架。
     */
    if (!isDir) this.discovered.add(key)

    // origin 在原始事件到达时就定格：防抖窗口可能跨越 ready 边界，
    // 等到窗口结束时再判断会把初始扫描的事件误标成增量事件。
    this.pending.set(key, { type, origin: this.initialDone ? 'change' : 'initial', isDir })
    this.pendingAbs.set(key, absPath)

    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)

    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        const final = this.pending.get(key)
        const finalAbs = this.pendingAbs.get(key)
        this.pending.delete(key)
        this.pendingAbs.delete(key)
        if (!final || !finalAbs) return

        const rel = relativize(this.opts.root, finalAbs)
        if (rel === null || rel === '') return

        this.opts.onEvent({
          type: final.type,
          relPath: rel,
          absPath: finalAbs,
          origin: final.origin,
          isDir: final.isDir
        })
      }, debounceMs)
    )
  }
}

/**
 * 只走一遍本地目录树，不建任何监控。
 *
 * 这是「扫描本地」按钮的底座：扫描是**只读巡检**，
 * 不该启动同步、也不该为了数一遍文件就把 chokidar 挂起来
 * （整块盘上有几千个目录，每个目录一个 watch 句柄）。
 *
 * 与 `Watcher.rescan()` 共用同一套遍历与排除规则，
 * 区别只在于它不产出事件——上线后两者的行为不会漂移。
 */
export interface LocalScanOptions {
  root: string
  exclude: string[]
  /**
   * 每发现一个文件调用一次；返回 Promise 时会被等待（背压）。
   *
   * `info` 只在 `withStat: true` 时提供——那时每个文件多一次 stat，
   * 用来做「大小/修改时间」的差异判定（轮询模式必需）。
   * 只数文件数量（「扫描本地」按钮）不需要它，省掉这一轮 stat。
   */
  onFile?: (
    rel: string,
    abs: string,
    done: number,
    info?: { size: number; mtimeMs: number }
  ) => void | Promise<void>
  /** 返回 true 时中止扫描 */
  shouldStop?: () => boolean
  /**
   * 是否连每个文件的大小/修改时间一起读出来。
   *
   * stat 走 IO 闸门：轮询一轮可能要对几万个文件 stat，
   * 不纳入限流的话，同时跑着的哈希/上传会被抢掉句柄。
   */
  withStat?: boolean
  /**
   * 计算相对路径与排除规则的基准目录；默认等于 `root`。
   *
   * 用途：只重扫某个子树时，`root` 是子目录，但排除规则和事件里的
   * 相对路径必须按**同步根**算，否则 `**\/node_modules/**` 这类规则
   * 会在子树扫描里失效，上层也会收到错位的相对路径。
   */
  base?: string
  /**
   * 并发 stat 的数量（仅 `withStat` 生效）。
   *
   * 为什么需要：SMB / 网络盘上单次 stat 是一次网络往返，
   * **串行 stat 的吞吐被往返延迟锁死**——实测同一块 NAS 上
   * 串行 60 文件/秒，4 路并发 209 文件/秒（3.5 倍）。
   * 并发再高（8/16/32）没有收益，说明瓶颈在服务端，
   * 所以默认取 4，且最终仍受 IO 闸门约束。
   */
  statConcurrency?: number
}

/** 并发跑一批异步任务，保持结果顺序 */
async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}


export async function scanLocalTree(opts: LocalScanOptions): Promise<number> {
  const { root } = opts
  if (!root) return 0
  const base = opts.base ?? root

  // 排除规则预编译一次：每个文件现解析 glob 会让六万文件的扫描多烧两秒 CPU
  const exclude = getExcludeMatcher(opts.exclude)
  let count = 0

  /**
   * 待 stat 的批次。
   *
   * 攒一批并行 stat，再**顺序**回调——这样既拿到并发吞吐，
   * 又保持 onFile 的调用顺序稳定（上层按顺序写库，行为可预期）。
   */
  const batch: Array<{ rel: string; abs: string }> = []
  const STAT_BATCH = 64
  const statConcurrency = Math.max(1, Math.min(8, opts.statConcurrency ?? 4))

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return
    const items = batch.splice(0)
    const infos = await runPool(items, statConcurrency, async (item) => {
      try {
        const st = await ioGovernor.run(() => stat(toLongPath(item.abs)))
        return { size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        // stat 失败（被删/被占用/句柄不足）：这一轮当它不存在，
        // 下一轮再看——不能因为一个文件读不到就中断整次遍历
        return null
      }
    })

    for (let i = 0; i < items.length; i++) {
      if (opts.shouldStop?.()) return
      const info = infos[i]
      if (!info) continue
      count++
      const ret = opts.onFile?.(items[i].rel, items[i].abs, count, info)
      if (ret && typeof ret.then === 'function') await ret
    }
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || opts.shouldStop?.()) return

    let entries: Dirent[]
    try {
      entries = await readdir(toLongPath(dir), { withFileTypes: true })
    } catch {
      // 目录读不到（权限、已被删除、被占用）→ 跳过这一支
      return
    }

    for (const entry of entries) {
      if (opts.shouldStop?.()) return
      const abs = join(dir, entry.name)
      const rel = relativize(base, abs)
      if (rel === null || rel === '') continue
      if (exclude.test(rel)) continue
      if (hasIgnoredSegment(rel)) continue

      if (entry.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      // 不跟随符号链接与目录联接，避免循环
      if (!entry.isFile()) continue

      if (!opts.withStat) {
        count++
        const ret = opts.onFile?.(rel, abs, count)
        if (ret && typeof ret.then === 'function') await ret
        continue
      }

      batch.push({ rel, abs })
      if (batch.length >= STAT_BATCH) await flushBatch()
    }
  }

  await walk(root, 0)
  await flushBatch()
  return count
}

/** 简单等待；只在 native 模式的稳定窗口里用，量很小 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
