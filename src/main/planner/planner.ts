import { randomUUID } from 'crypto'
import { stat } from 'fs/promises'
import type { Manifest } from '../db/manifest'
import type { Transfer } from '../transfer/transfer'
import type { FileHashes } from '../hash/hashes'
import { hashFile } from '../hash/hashes'
import type { OpenListClient } from '../openlist/client'
import { absolutize, isExcluded, joinRemote } from '../watcher/paths'
import type { AppConfig, DiffKind, TransferTask } from '@shared/types'

/**
 * Planner——两条扫描通道的汇合点。
 *
 * 本地变更（Watcher）和远端差异（Reconciler）最终都从这里走**同一条**
 * 上传路径，不写第二套上传逻辑。
 *
 * 流水线分两级，各自独立限流：
 *
 *   事件 → [L1 快筛] → 哈希池(hashConcurrency) → 上传池(uploadConcurrency) → 完成
 *            ↑
 *      size+mtime 与上次成功同步一致 → 直接跳过，零上行
 *
 * L1 快筛是省用户上行的**主力**。
 * 服务端秒传（L2）只作用于 OpenList→夸克那一段，不是这里的重点。
 */

export type EnqueueReason = 'watch' | 'diff' | 'recovery' | 'retry'

export interface PlannerOptions {
  manifest: Manifest
  transfer: Transfer
  /** 远端客户端（建目录、删除、回收站移动） */
  client: OpenListClient
  /** 读当前配置（配置可在运行时改，故用函数而非快照） */
  getConfig: () => AppConfig
  onTask?: (task: TransferTask) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** L1 命中计数变化 */
  onSkip?: (count: number) => void
}

interface QueueItem {
  relPath: string
  absPath: string
  size: number
  mtimeMs: number
  reason: EnqueueReason
  attempts: number
  hashes?: FileHashes
}

interface DeleteItem {
  relPath: string
  remotePath: string
  size: number
}

export class Planner {
  private readonly hashQueue: QueueItem[] = []
  private readonly uploadQueue: QueueItem[] = []
  private readonly deleteQueue: DeleteItem[] = []
  /** 任务表：key 是任务 id */
  private readonly tasks = new Map<string, TransferTask>()
  /** 相对路径 → 任务 id */
  private readonly taskIdByPath = new Map<string, string>()
  /** 已在远端创建过的目录，避免每个文件都重复 mkdir */
  private readonly knownRemoteDirs = new Set<string>()
  private running = false
  private pumping = false
  private skippedThisRun = 0
  /** 本次会话的删除计数，用于熔断 */
  private deleteCount = 0
  private deleteBytes = 0
  /** 本次对账已自动修复的差异数 */
  private autoFixed = 0

  constructor(private readonly opts: PlannerOptions) {}

  // ── 生命周期 ──────────────────────────────────────────

  start(): void {
    this.running = true
    void this.pump()
  }

  stop(): void {
    this.running = false
    this.hashQueue.length = 0
    this.uploadQueue.length = 0
  }

  get isRunning(): boolean {
    return this.running
  }

  get skippedCount(): number {
    return this.skippedThisRun
  }

  getTasks(): TransferTask[] {
    return [...this.tasks.values()]
  }

  /** 按相对路径取任务（进度回调用它把字节数对应回任务） */
  getTaskByPath(relPath: string): TransferTask | null {
    const id = this.taskIdByPath.get(relPath)
    return id ? (this.tasks.get(id) ?? null) : null
  }

  // ── 入口：本地扫描事件 ─────────────────────────────────

  /** 处理一个归一化后的文件事件；exists=false 表示本地已被删除。 */
  async handleEvent(relPath: string, exists: boolean): Promise<void> {
    if (!this.running) return
    const config = this.opts.getConfig()
    if (!config.syncRoot) return
    if (isExcluded(relPath, config.exclude)) return

    if (!exists) {
      this.handleRemoval(relPath, config)
      return
    }

    const absPath = absolutize(config.syncRoot, relPath)

    // 跳过占位文件与占用中的文件：读它们会触发云盘客户端拉取正文
    const probe = await this.probe(absPath)
    if (!probe.ok) {
      if (probe.reason) this.opts.onLog?.('warn', `跳过 ${relPath}：${probe.reason}`)
      return
    }

    // ── L1 快筛 ──
    // 基准是「上次成功同步时的 size + mtime」。命中即完全不上传。
    if (this.opts.manifest.isUnchanged(relPath, probe.size, probe.mtimeMs)) {
      this.skippedThisRun++
      this.opts.onSkip?.(this.skippedThisRun)
      this.opts.manifest.setState(relPath, 'synced')
      return
    }

    this.opts.manifest.upsertFile({
      localPath: relPath,
      localSize: probe.size,
      mtimeMs: probe.mtimeMs,
      state: 'pending'
    })

    this.enqueue({
      relPath,
      absPath,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      reason: 'watch',
      attempts: 0
    })
  }

  // ── 入口：远端对账差异回流 ─────────────────────────────

  /**
   * 远端对账产生的差异回流。
   *
   * 默认立场「本地为准」：
   * - missing_remote / size_mismatch → 重新入队上传（受 autoFixLimit 约束）
   * - remote_only / mtime_mismatch  → 只记录，不动作
   */
  async handleDiff(diff: {
    kind: DiffKind
    localPath: string | null
    remotePath: string
  }): Promise<void> {
    const config = this.opts.getConfig()
    if (config.remoteScan.conflictPolicy !== 'local-wins') return

    if (diff.kind !== 'missing_remote' && diff.kind !== 'size_mismatch') {
      if (diff.kind === 'remote_only') {
        this.opts.onLog?.('info', `远端多出文件（按策略不动作）：${diff.remotePath}`)
      }
      return
    }

    if (this.autoFixed >= config.remoteScan.autoFixLimit) {
      this.opts.onLog?.(
        'warn',
        `对账自动修复已达上限 ${config.remoteScan.autoFixLimit}，其余差异仅记录待人工确认`
      )
      return
    }
    if (!diff.localPath) return

    const absPath = absolutize(config.syncRoot, diff.localPath)
    const probe = await this.probe(absPath)
    if (!probe.ok) return

    this.autoFixed++
    this.opts.onLog?.(
      'info',
      `对账发现${diff.kind === 'missing_remote' ? '远端缺失' : '内容不符'}，重新上传 ${diff.localPath}`
    )

    this.enqueue({
      relPath: diff.localPath,
      absPath,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      reason: 'diff',
      attempts: 0
    })
  }

  // ── 手动重试 / 取消 ───────────────────────────────────

  retry(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state === 'uploading' || task.state === 'hashing') return

    const config = this.opts.getConfig()
    const absPath = absolutize(config.syncRoot, task.localPath)
    this.touch(task.localPath, { state: 'queued', errorMsg: null, progress: 0 })
    this.enqueue({
      relPath: task.localPath,
      absPath,
      size: task.size,
      mtimeMs: 0,
      reason: 'retry',
      attempts: 0
    })
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.state === 'done') return
    this.touch(task.localPath, { state: 'canceled' })
  }

  // ── 内部：入队与流水线 ─────────────────────────────────

  private enqueue(item: QueueItem): void {
    // 同一路径已在队列中就不重复排
    if (this.hashQueue.some((q) => q.relPath === item.relPath)) return
    if (this.uploadQueue.some((q) => q.relPath === item.relPath)) return

    this.hashQueue.push(item)
    this.touch(item.relPath, { state: 'queued' })
    void this.pump()
  }

  /**
   * 调度泵：把哈希池与上传池各自喂到并发上限。
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      let hashActive = 0
      let uploadActive = 0

      while (this.running) {
        const config = this.opts.getConfig()
        const hashLimit = Math.max(1, config.hashConcurrency)
        const uploadLimit = Math.max(1, config.uploadConcurrency)

        while (hashActive < hashLimit && this.hashQueue.length > 0) {
          const item = this.hashQueue.shift()!
          hashActive++
          void this.runHashStage(item)
            .catch((err) => this.handleFatal(item, err))
            .finally(() => {
              hashActive--
              void this.pump()
            })
        }

        while (uploadActive < uploadLimit && this.uploadQueue.length > 0) {
          const item = this.uploadQueue.shift()!
          uploadActive++
          void this.runUploadStage(item)
            .catch((err) => this.handleFatal(item, err))
            .finally(() => {
              uploadActive--
              void this.pump()
            })
        }

        if (hashActive === 0 && uploadActive === 0) break
        await sleep(50)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 哈希阶段：读一次文件同时产出 MD5 + SHA1 */
  private async runHashStage(item: QueueItem): Promise<void> {
    const manifest = this.opts.manifest
    manifest.setState(item.relPath, 'hashing')

    const hashes = await hashFile(item.absPath)
    item.hashes = hashes

    manifest.setState(item.relPath, 'hashed', { md5: hashes.md5, sha1: hashes.sha1 })
    this.touch(item.relPath, {
      state: 'hashing',
      md5Prefix: hashes.md5.slice(0, 8),
      sha1Prefix: hashes.sha1.slice(0, 8)
    })

    this.uploadQueue.push(item)
  }

  /** 上传阶段：单次 PUT 或分片，由 Transfer 内部按大小分流 */
  private async runUploadStage(item: QueueItem): Promise<void> {
    const { manifest, transfer } = this.opts
    const config = this.opts.getConfig()

    const remotePath = joinRemote(config.remoteRoot, item.relPath)

    // 先写清单再上传：上传成功后 Transfer 会把 state 置为 synced
    const fileId = manifest.upsertFile({
      localPath: item.relPath,
      localSize: item.size,
      mtimeMs: item.mtimeMs,
      remotePath,
      state: 'uploading'
    })

    this.touch(item.relPath, {
      state: 'uploading',
      remotePath,
      size: item.size,
      fileId,
      mode: item.size > config.singlePutMaxBytes ? 'multipart' : 'single'
    })

    await this.ensureRemoteDirs(remotePath)

    const result = await transfer.upload({
      fileId,
      relPath: item.relPath,
      absPath: item.absPath,
      remotePath,
      hashes: item.hashes
    })

    if (result.ok) {
      this.touch(item.relPath, { state: 'done', progress: 1, speed: 0, errorMsg: null })
      manifest.log('info', `已同步 ${item.relPath} → ${remotePath}`, fileId, remotePath)
      return
    }

    // 失败重试
    item.attempts++
    const maxAttempts = config.retry.maxAttempts
    if (item.attempts < maxAttempts && this.running) {
      this.touch(item.relPath, {
        state: 'queued',
        attempts: item.attempts,
        errorMsg: result.error ?? '上传失败'
      })
      manifest.setState(item.relPath, 'pending', { errorMsg: result.error ?? '上传失败' })
      this.opts.onLog?.(
        'warn',
        `上传失败（第 ${item.attempts}/${maxAttempts} 次），将重试：${item.relPath}`
      )
      await sleep(backoff(config.retry.baseDelayMs, item.attempts))
      this.hashQueue.push(item)
      return
    }

    this.touch(item.relPath, {
      state: 'failed',
      attempts: item.attempts,
      errorMsg: result.error ?? '上传失败'
    })
  }

  private handleFatal(item: QueueItem, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.opts.manifest.setState(item.relPath, 'error', { errorMsg: message })
    this.touch(item.relPath, { state: 'failed', errorMsg: message })
    this.opts.onLog?.('error', `处理 ${item.relPath} 失败：${message}`)
  }

  // ── 删除处理 ──────────────────────────────────────────

  /**
   * 本地文件被删除。
   *
   * 三档策略：trash（移入远端回收站）/ delete（直接删）/ keep（不动）。
   * 熔断：单次会话内删除数或删除字节数超限即暂停删除队列。
   */
  private handleRemoval(relPath: string, config: AppConfig): void {
    const manifest = this.opts.manifest
    const entry = manifest.getFile(relPath)
    manifest.setState(relPath, 'deleted')

    if (config.deletePolicy === 'keep') return
    if (!entry?.remotePath) return

    this.deleteQueue.push({
      relPath,
      remotePath: entry.remotePath,
      size: entry.remoteSize ?? entry.localSize
    })
    void this.pumpDeletes()
  }

  private async pumpDeletes(): Promise<void> {
    const config = this.opts.getConfig()

    while (this.deleteQueue.length > 0) {
      if (this.deleteCount >= config.maxDeletesPerRun) {
        this.opts.onLog?.(
          'error',
          `删除熔断：本次会话删除数已达上限 ${config.maxDeletesPerRun}，暂停删除队列`
        )
        this.deleteQueue.length = 0
        return
      }
      if (this.deleteBytes >= config.maxDeleteBytesPerRun) {
        this.opts.onLog?.(
          'error',
          `删除熔断：本次会话删除字节数已达上限 ${config.maxDeleteBytesPerRun}，暂停删除队列`
        )
        this.deleteQueue.length = 0
        return
      }

      const item = this.deleteQueue.shift()!
      try {
        if (config.deletePolicy === 'trash') {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const dest = `/${config.trashRoot}/${stamp}/${item.relPath}`
          await this.opts.client.move(item.remotePath, dest)
        } else {
          await this.opts.client.remove([item.remotePath])
        }
        this.deleteCount++
        this.deleteBytes += item.size
        this.opts.manifest.log('info', `已处理远端删除 ${item.remotePath}`, undefined, item.remotePath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.opts.onLog?.('error', `远端删除失败 ${item.remotePath}：${message}`)
      }
    }
  }

  // ── 恢复 ──────────────────────────────────────────────

  /**
   * 启动时恢复未完成的任务。
   *
   * 上次退出时处于 uploading / error 的文件重新入队。
   * 哈希若已记录则复用（省一次读盘），否则重算。
   */
  recoverPending(): number {
    const manifest = this.opts.manifest
    const config = this.opts.getConfig()
    const pending = manifest.listFilesByStates(['uploading', 'error', 'hashed', 'pending'])

    for (const entry of pending) {
      const absPath = absolutize(config.syncRoot, entry.localPath)
      const item: QueueItem = {
        relPath: entry.localPath,
        absPath,
        size: entry.localSize,
        mtimeMs: entry.mtimeMs,
        reason: 'recovery',
        attempts: 0
      }
      // 已有有效哈希则直接进上传阶段，避免重复读盘
      if (entry.md5 && entry.sha1) {
        item.hashes = { md5: entry.md5, sha1: entry.sha1, size: entry.localSize }
        this.uploadQueue.push(item)
      } else {
        this.hashQueue.push(item)
      }
    }
    return pending.length
  }

  // ── 远端目录 ──────────────────────────────────────────

  /** 逐级创建远端目录；已存在或无权创建时忽略 */
  private async ensureRemoteDirs(remotePath: string): Promise<void> {
    const parts = remotePath.split('/').filter(Boolean)
    let current = ''
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i]
      if (this.knownRemoteDirs.has(current)) continue
      try {
        await this.opts.client.mkdir(current)
      } catch {
        // 已存在或无权创建时忽略：目录可能已由别的文件建好
      }
      this.knownRemoteDirs.add(current)
    }
  }

  // ── 文件探针 ──────────────────────────────────────────

  /**
   * 读取文件元信息。
   *
   * 读不到就跳过，不反复重试：
   * - EBUSY / EPERM：文件被其他进程占用（常见于 Office、网盘客户端）
   * - ENOENT：可能刚被删除，交给 unlink 事件处理
   * - 云盘占位文件：stat 成功但读取会触发云盘客户端拉正文，跳过
   */
  private async probe(absPath: string): Promise<{
    ok: boolean
    reason?: string
    size: number
    mtimeMs: number
  }> {
    try {
      const st = await stat(absPath)
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { ok: false, reason: `文件被占用（${code}）`, size: 0, mtimeMs: 0 }
      }
      if (code === 'ENOENT') {
        return { ok: false, reason: '文件已不存在', size: 0, mtimeMs: 0 }
      }
      return { ok: false, reason: (err as Error).message, size: 0, mtimeMs: 0 }
    }
  }

  // ── 任务表 ────────────────────────────────────────────

  /** 更新某个相对路径对应的任务，并推给 UI */
  private touch(relPath: string, patch: Partial<TransferTask>): void {
    let id = this.taskIdByPath.get(relPath)
    if (!id) {
      id = randomUUID()
      this.taskIdByPath.set(relPath, id)
    }
    const existing = this.tasks.get(id)

    const task: TransferTask = {
      id,
      fileId: patch.fileId ?? existing?.fileId ?? 0,
      localPath: relPath,
      remotePath: patch.remotePath ?? existing?.remotePath ?? '',
      size: patch.size ?? existing?.size ?? 0,
      mode: patch.mode ?? existing?.mode ?? 'single',
      state: patch.state ?? existing?.state ?? 'queued',
      chunksDone: patch.chunksDone ?? existing?.chunksDone ?? 0,
      chunksTotal: patch.chunksTotal ?? existing?.chunksTotal ?? 0,
      progress: patch.progress ?? existing?.progress ?? 0,
      speed: patch.speed ?? existing?.speed ?? 0,
      md5Prefix: patch.md5Prefix ?? existing?.md5Prefix ?? '',
      sha1Prefix: patch.sha1Prefix ?? existing?.sha1Prefix ?? '',
      errorMsg: patch.errorMsg !== undefined ? patch.errorMsg : (existing?.errorMsg ?? null),
      attempts: patch.attempts ?? existing?.attempts ?? 0
    }

    this.tasks.set(id, task)
    this.opts.onTask?.(task)
  }
}

function backoff(base: number, attempt: number): number {
  const exp = base * 2 ** Math.max(0, attempt - 1)
  return exp + Math.random() * base
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
