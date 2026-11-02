import type { TaskBatch, TransferTask } from '@shared/types'

/**
 * 任务推送的攒批器。
 *
 * 为什么需要它：一次本地扫描会把**每个**文件都变成一条任务——
 * 六万个文件就是六万次状态变化。每次都直接推给渲染进程有两个代价：
 *
 * 1. 六万次 IPC 跨进程序列化；
 * 2. 渲染层每收到一条都要遍历整个任务数组去替换同 id 项。
 *    六万条 × 六万次遍历 = 三十多亿次操作（实测三十多分钟）。
 *
 * 攒批之后：
 * - 同一个 id 在一个窗口内的多次变化自然合并成最后那条——
 *   中间态（pending → hashing → skipped）本来也没人需要看到；
 * - 推送次数从「文件数」降到「窗口数」，通常小两个数量级。
 *
 * 淘汰通知（`removed`）与任务更新共用同一个批次：
 * 两者必须原子地一起到达渲染层，否则会出现
 * 「刚删掉的任务又在下一批里被加回来」这种错位。
 */
export class TaskBatcher {
  private readonly pending = new Map<string, TransferTask>()
  private readonly removed = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly emit: (batch: TaskBatch) => void,
    private readonly delayMs = 80
  ) {}

  /** 收下一个任务变化（同 id 覆盖） */
  push(task: TransferTask): void {
    if (this.disposed) return
    this.pending.set(task.id, task)
    this.schedule()
  }

  /**
   * 报告被淘汰的任务 id。
   *
   * 同时从待推缓冲里抹掉它们——否则会出现「这一批里既有它的更新、
   * 又说它被删了」，渲染层先加后删，白做一次。
   */
  remove(ids: string[]): void {
    if (this.disposed || ids.length === 0) return
    for (const id of ids) {
      this.pending.delete(id)
      this.removed.add(id)
    }
    this.schedule()
  }

  /** 立即推一次（退出前用，保证最后那批状态不丢） */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
  }

  /** 停止接收并清掉待推内容 */
  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.removed.clear()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
    // 定时器不该拖住进程退出
    this.timer.unref?.()
  }

  private flush(): void {
    if (this.pending.size === 0 && this.removed.size === 0) return
    const batch: TaskBatch = {
      upserts: [...this.pending.values()],
      removed: [...this.removed]
    }
    this.pending.clear()
    this.removed.clear()
    this.emit(batch)
  }
}
