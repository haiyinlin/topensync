import chokidar, { type FSWatcher } from 'chokidar'
import { hasIgnoredSegment, isExcluded, relativize, toLongPath } from './paths'

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
}

export interface WatcherOptions {
  root: string
  /** 排除规则（glob） */
  exclude: string[]
  /** 同一路径的事件合并窗口（毫秒），默认 500 */
  debounceMs?: number
  onEvent: (event: WatchEvent) => void
  /** 首次全量扫描完成 */
  onReady?: (count: number) => void
  onError?: (err: Error) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** chokidar 递归深度上限，防止病态目录把进程拖死 */
const MAX_DEPTH = 24

export class Watcher {
  private watcher: FSWatcher | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 每个路径最后一次事件；防抖窗口结束时据此决定发 upsert 还是 remove */
  private readonly pending = new Map<string, { type: WatchEventType; origin: WatchEvent['origin'] }>()
  /** 防抖窗口内的原始路径，Windows 大小写不敏感 */
  private readonly pendingAbs = new Map<string, string>()
  private initialDone = false
  private scannedCount = 0
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

    this.watcher = chokidar.watch(toLongPath(root), {
      // 自行判定忽略项：chokidar 的 glob 匹配对 Windows 路径分隔符不友好
      ignored: (p: string) => this.shouldIgnore(p),
      persistent: true,
      // 首次全量扫描交给 Planner 与清单比对，不靠事件本身
      ignoreInitial: false,
      // 编辑器「删除+重建」合并为单次 change
      atomic: true,
      // 写完成判定：文件停止变化 2 秒才算写完
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      // 不跟随符号链接与目录联接
      followSymlinks: false,
      depth: MAX_DEPTH
    })

    this.watcher
      .on('add', (p) => this.onFsEvent(p, 'upsert'))
      .on('change', (p) => this.onFsEvent(p, 'upsert'))
      .on('unlink', (p) => this.onFsEvent(p, 'remove'))
      // 目录事件不触发上传：远端目录由上传时按需 mkdir 创建
      .on('addDir', () => undefined)
      .on('unlinkDir', () => undefined)
      .on('error', (err) => {
        const e = err instanceof Error ? err : new Error(String(err))
        this.opts.onError?.(e)
        this.opts.onLog?.('error', `监控出错：${e.message}`)
      })
      .on('ready', () => {
        this.initialDone = true
        this.lastReadyAt = Date.now()
        this.opts.onReady?.(this.scannedCount)
        this.opts.onLog?.('info', `本地扫描就绪，发现 ${this.scannedCount} 个文件`)
      })
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
    this.pendingAbs.clear()
    void this.watcher?.close()
    this.watcher = null
    this.initialDone = false
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
  private onFsEvent(absPath: string, type: WatchEventType): void {
    const key = absPath.toLowerCase()
    const debounceMs = this.opts.debounceMs ?? 500

    // origin 在原始事件到达时就定格：防抖窗口可能跨越 ready 边界，
    // 等到窗口结束时再判断会把初始扫描的事件误标成增量事件。
    this.pending.set(key, { type, origin: this.initialDone ? 'change' : 'initial' })
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

        if (final.type === 'upsert') this.scannedCount++
        this.opts.onEvent({
          type: final.type,
          relPath: rel,
          absPath: finalAbs,
          origin: final.origin
        })
      }, debounceMs)
    )
  }
}
