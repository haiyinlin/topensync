/**
 * 本地文件 IO 闸门。
 *
 * 为什么需要它：
 *
 * 同步一个 6 万文件的目录时，`stat` / `open` 的调用点有三处会同时开火——
 * 事件处理（每个文件一次 stat）、哈希（每个文件一个读流）、上传（每个文件
 * 一个读流）。这三处各自都有自己的并发上限，但**加起来没有上限**，
 * 而且事件处理那条根本没有上限。
 *
 * 实测后果：真实用户把 `Z:\`（一整块盘，5.8 万个文件）设为同步根，
 * 直接打出 118 次
 * `EMFILE: too many open files, open 'Z:\download\...jpg'`，
 * 连 `fs.watch` 都建不起来了（`too many open files, watch ...`）。
 * 更麻烦的是这个错误发生在**驱动器側**：句柄耗尽之后，
 * 连一个全新的进程 `stat('Z:/download')` 都会失败
 * （实测 200 次里 158 次 EMFILE），盘要缓一阵才能恢复。
 *
 * 所以这里做两件事：
 *
 * 1. **限流**：全进程共用一个信号量，同一时刻最多开 N 个文件。
 *    这是硬约束，不随调用点增加而失控。
 * 2. **冷却**：一旦真的撞上 EMFILE，就在全进程范围内暂停开新句柄，
 *    指数退避（0.8s → 30s）。空转重试只会让盘更缓不过来。
 *
 * 注意闸门**不吞异常**：限流是限流，错误照旧抛给调用方，
 * 由上层决定是「重试」还是「判失败」。
 */

/** 是不是「句柄不够」这一类错误 */
export function isResourceExhausted(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EMFILE' || code === 'ENFILE'
}

/**
 * 从错误文案判断句柄耗尽。
 *
 * 有些路径只能拿到字符串（Transfer 把异常收敛成 `{ ok:false, error }`，
 * 保住 code 要改一整条返回链）。这些文案是 Node 与 libuv 的固定措辞，
 * 匹配它是安全的——匹配不上只是少了一次「冷却重试」，不会误判成成功。
 */
export function isResourceExhaustedMessage(message: string | null | undefined): boolean {
  if (!message) return false
  return message.startsWith('EMFILE') || message.startsWith('ENFILE') || message.includes('too many open files')
}

/** 首次冷却时长。够短，不至于让正常任务明显停顿 */
const BASE_COOLDOWN_MS = 800
/** 冷却上限。再长用户会以为程序卡死了 */
const MAX_COOLDOWN_MS = 30_000
/** 默认并发额度 */
const DEFAULT_LIMIT = 8

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface IoGovernorStats {
  /** 当前正在进行的文件操作数 */
  active: number
  /** 历史峰值 */
  peak: number
  /** 额度上限 */
  limit: number
  /** 排队等待的任务数 */
  waiting: number
  /** 是否处于 EMFILE 冷却期 */
  coolingDown: boolean
  /** 累计撞上句柄耗尽的次数 */
  exhausted: number
}

export class IoGovernor {
  private limit = DEFAULT_LIMIT
  private active = 0
  private peak = 0
  private readonly waiters: Array<() => void> = []
  private cooldownUntil = 0
  private cooldownMs = 0
  private streak = 0
  private exhaustedCount = 0

  /** 调整额度。上传/哈希并发度提高时可以放宽，但别超过驱动器的承受力 */
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get stats(): IoGovernorStats {
    return {
      active: this.active,
      peak: this.peak,
      limit: this.limit,
      waiting: this.waiters.length,
      coolingDown: this.coolingDown,
      exhausted: this.exhaustedCount
    }
  }

  get coolingDown(): boolean {
    return Date.now() < this.cooldownUntil
  }

  get remainingCooldownMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now())
  }

  /**
   * 在闸门内执行一次文件操作。
   *
   * 撞上 EMFILE 时自动进入冷却并把异常原样抛出——
   * 调用方据此决定重试，而不是把它当成「文件本身有问题」判死。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      const result = await fn()
      // 连续成功一次就把退避阶梯往下压：说明盘已经缓过来了
      this.streak = 0
      return result
    } catch (err) {
      if (isResourceExhausted(err)) this.penalize()
      throw err
    } finally {
      this.release()
    }
  }

  /** 记录一次句柄耗尽，并返回本次冷却时长 */
  penalize(): number {
    this.exhaustedCount++
    this.streak = Math.min(this.streak + 1, 6)
    this.cooldownMs = Math.min(BASE_COOLDOWN_MS * 2 ** (this.streak - 1), MAX_COOLDOWN_MS)
    this.cooldownUntil = Date.now() + this.cooldownMs
    return this.cooldownMs
  }

  private async acquire(): Promise<void> {
    /*
     * 冷却期内一个句柄都不开。
     *
     * 这段等待必须是**先于排队**的：如果先排队拿到额度再等冷却，
     * 排队的那几个已经占着额度空转，别的任务连排都排不进来。
     */
    while (this.coolingDown) {
      await sleep(Math.min(this.remainingCooldownMs, 250))
    }

    if (this.active < this.limit) {
      this.bump()
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    this.active--
    // 直接把额度交接给下一个排队者，避免「先全放完再抢」造成的并发抖动
    const next = this.waiters.shift()
    if (next) {
      this.bump()
      next()
    }
  }

  private bump(): void {
    this.active++
    if (this.active > this.peak) this.peak = this.active
  }

  /** 仅测试用：把闸门恢复到初始状态 */
  resetForTest(): void {
    this.active = 0
    this.peak = 0
    this.waiters.length = 0
    this.cooldownUntil = 0
    this.cooldownMs = 0
    this.streak = 0
    this.exhaustedCount = 0
    this.limit = DEFAULT_LIMIT
  }
}

/** 全进程共用一把闸门 */
export const ioGovernor = new IoGovernor()
