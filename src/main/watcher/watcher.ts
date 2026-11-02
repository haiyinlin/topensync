import chokidar, { type FSWatcher } from 'chokidar'
import { readdir } from 'fs/promises'
import type { Dirent } from 'fs'
import { join } from 'path'
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
  onError?: (err: Error) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
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

  constructor(private readonly opts: WatcherOptions) {}

  get isWatching(): boolean {
    return this.watcher !== null
  }

  get lastScanAt(): number | null {
    return this.lastReadyAt
  }

  start(): void {
    if (this.watcher) return
    const { root } = this.opts
    this.stopped = false

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
        this.opts.onError?.(e)
        this.opts.onLog?.('error', `监控出错：${e.message}`)
      })
      .on('ready', () => {
        this.initialDone = true
        this.lastReadyAt = Date.now()
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
    this.initialDone = false
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
  /** 每发现一个文件调用一次；返回 Promise 时会被等待（背压） */
  onFile?: (rel: string, abs: string, done: number) => void | Promise<void>
  /** 返回 true 时中止扫描 */
  shouldStop?: () => boolean
}

export async function scanLocalTree(opts: LocalScanOptions): Promise<number> {
  const { root } = opts
  if (!root) return 0

  // 排除规则预编译一次：每个文件现解析 glob 会让六万文件的扫描多烧两秒 CPU
  const exclude = getExcludeMatcher(opts.exclude)
  let count = 0

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
      const rel = relativize(root, abs)
      if (rel === null || rel === '') continue
      if (exclude.test(rel)) continue
      if (hasIgnoredSegment(rel)) continue

      if (entry.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      // 不跟随符号链接与目录联接，避免循环
      if (!entry.isFile()) continue

      count++
      const ret = opts.onFile?.(rel, abs, count)
      if (ret && typeof ret.then === 'function') await ret
    }
  }

  await walk(root, 0)
  return count
}
