import type { OpenListClient, RemoteObject } from '../openlist/client'
import type { Manifest } from '../db/manifest'
import type { AppConfig, DiffKind, ScanKind, ScanTrigger } from '@shared/types'

/**
 * 远端对账器（计划书 §6.5）。
 *
 * 职责：周期性列举远端文件树 → 写入 remote_snapshot → 与 files 表比对
 *      → 产出 diffs → 需要修正的差异回流进 Planner。
 *
 * 为什么必须有它：只扫本地无法发现「远端被外部删除」——
 * 你在 OpenList 网页端删了文件，本地 mtime 未变，清单认为已同步，
 * 于是永远不会重传，造成静默的备份缺失。
 *
 * 三条硬约束：
 * - refresh 必须为 true，否则读到的是服务端目录缓存，发现不了外部删除
 *   （代价：需要目标目录写权限，否则 403）
 * - 目录列举并发 ≤ 2（默认 1）。夸克侧限速按账号共享，并发只招风控
 * - 单次对账有超时上限，超时保留剩余目录到下一轮
 */

export interface ReconcilerOptions {
  client: OpenListClient
  manifest: Manifest
  config: AppConfig
  /** 差异处理器：把需要修正的差异交给 Planner */
  onDiff?: (diff: {
    kind: DiffKind
    localPath: string | null
    remotePath: string
  }) => void
}

export interface ReconcileResult {
  scanId: number
  scannedDirs: number
  scannedFiles: number
  diffCount: number
  timedOut: boolean
  error?: string
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly opts: ReconcilerOptions) {}

  /** 按配置的周期启动定时对账 */
  start(): void {
    const { enabled, intervalHours, onStartup } = this.opts.config.remoteScan
    if (!enabled) return

    if (onStartup) {
      // 异步执行，不阻塞启动
      void this.run('startup').catch(() => undefined)
    }

    const ms = Math.max(1, intervalHours) * 60 * 60 * 1000
    this.timer = setInterval(() => {
      void this.run('timer').catch(() => undefined)
    }, ms)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 手动触发一次对账 */
  async runNow(): Promise<ReconcileResult> {
    return this.run('manual')
  }

  private async run(trigger: ScanTrigger): Promise<ReconcileResult> {
    if (this.running) {
      throw new Error('对账已在进行中')
    }
    this.running = true

    const { manifest, config } = this.opts
    const scanId = manifest.startScan('remote', trigger)
    const deadline = Date.now() + config.remoteScan.timeoutMinutes * 60_000

    let scannedDirs = 0
    let scannedFiles = 0
    let diffCount = 0
    let timedOut = false

    try {
      const root = config.remoteRoot
      const seen = new Set<string>()
      const remoteFiles = new Map<string, RemoteObject>()

      // 广度优先遍历远端树。并发受限为 maxConcurrency（默认 1）
      const queue: string[] = [root]
      const inFlight = new Set<string>()

      while (queue.length > 0 || inFlight.size > 0) {
        if (Date.now() > deadline) {
          timedOut = true
          break
        }

        // 填充并发槽位
        while (queue.length > 0 && inFlight.size < config.remoteScan.maxConcurrency) {
          const dir = queue.shift()!
          if (inFlight.has(dir)) continue
          inFlight.add(dir)

          void this.listDir(dir, config.remoteScan.refresh)
            .then((entries) => {
              scannedDirs++
              for (const entry of entries) {
                const full = joinRemote(root, dir, entry.name)
                if (entry.isDir) {
                  // 跳过排除目录（回收站等）
                  if (isExcluded(full, config)) continue
                  queue.push(full)
                } else {
                  scannedFiles++
                  remoteFiles.set(full, entry)
                  seen.add(full)
                  manifest.upsertRemoteSnapshot({
                    remotePath: full,
                    remoteSize: entry.size,
                    remoteMtime: parseModified(entry.modified),
                    isDir: false,
                    scanId
                  })
                }
              }
            })
            .finally(() => {
              inFlight.delete(dir)
            })
        }

        // 让出事件循环，等待在途请求完成
        if (inFlight.size > 0) await sleep(50)
      }

      // 与本地清单比对
      const localFiles = manifest.listFiles({ limit: 100_000 })
      const localByRemote = new Map<string, (typeof localFiles)[number]>()
      for (const f of localFiles) {
        if (f.remotePath) localByRemote.set(f.remotePath, f)
      }

      // 远端有、本地无 → remote_only
      for (const [remotePath, obj] of remoteFiles) {
        const local = localByRemote.get(remotePath)
        if (!local) {
          manifest.recordDiff({
            kind: 'remote_only',
            localPath: null,
            remotePath,
            localSize: null,
            remoteSize: obj.size,
            localMtime: null,
            remoteMtime: parseModified(obj.modified)
          })
          diffCount++
          continue
        }

        // 两边都有：比对大小与修改时间
        const remoteMtime = parseModified(obj.modified)
        if (local.remoteSize !== obj.size) {
          manifest.recordDiff({
            kind: 'size_mismatch',
            localPath: local.localPath,
            remotePath,
            localSize: local.localSize,
            remoteSize: obj.size,
            localMtime: local.mtimeMs,
            remoteMtime
          })
          diffCount++
          this.opts.onDiff?.({
            kind: 'size_mismatch',
            localPath: local.localPath,
            remotePath
          })
        } else if (Math.abs((local.mtimeMs ?? 0) - (remoteMtime ?? 0)) > 2000) {
          // 仅时间不同 —— 弱信号，只记录不处理
          manifest.recordDiff({
            kind: 'mtime_mismatch',
            localPath: local.localPath,
            remotePath,
            localSize: local.localSize,
            remoteSize: obj.size,
            localMtime: local.mtimeMs,
            remoteMtime
          })
          diffCount++
        } else {
          manifest.markVerified(local.localPath)
        }
      }

      // 本地有、远端无 → missing_remote（最危险的一类）
      for (const local of localFiles) {
        if (!local.remotePath) continue
        if (local.state === 'deleted') continue
        if (seen.has(local.remotePath)) continue
        if (remoteFiles.has(local.remotePath)) continue

        manifest.recordDiff({
          kind: 'missing_remote',
          localPath: local.localPath,
          remotePath: local.remotePath,
          localSize: local.localSize,
          remoteSize: null,
          localMtime: local.mtimeMs,
          remoteMtime: null
        })
        diffCount++
        this.opts.onDiff?.({
          kind: 'missing_remote',
          localPath: local.localPath,
          remotePath: local.remotePath
        })
      }

      manifest.finishScan(scanId, timedOut ? 'cancelled' : 'done', {
        scanned: scannedDirs,
        changed: diffCount,
        errors: 0
      })

      return { scanId, scannedDirs, scannedFiles, diffCount, timedOut }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.finishScan(scanId, 'failed', { scanned: scannedDirs, changed: diffCount, errors: 1 }, message)
      manifest.log('error', `远端对账失败：${message}`)
      return { scanId, scannedDirs, scannedFiles, diffCount, timedOut: false, error: message }
    } finally {
      this.running = false
    }
  }

  private async listDir(path: string, refresh: boolean): Promise<RemoteObject[]> {
    const res = await this.opts.client.list(path, { refresh })
    return res.content ?? []
  }
}

// ── 工具函数 ────────────────────────────────────────────

/** 拼接远端路径，保持 POSIX 分隔 */
function joinRemote(root: string, dir: string, name: string): string {
  const base = dir === root ? root : dir
  return `${base.replace(/\/+$/, '')}/${name}`
}

function parseModified(modified: string | undefined): number | null {
  if (!modified) return null
  const t = Date.parse(modified)
  return Number.isNaN(t) ? null : t
}

/** 回收站与排除目录不参与比对 */
function isExcluded(path: string, config: AppConfig): boolean {
  const trashRoot = config.trashRoot
  if (trashRoot && path.includes(`/${trashRoot}/`)) return true
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type { ScanKind }
