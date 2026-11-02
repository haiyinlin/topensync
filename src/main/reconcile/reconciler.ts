import type { OpenListClient, RemoteObject } from '../openlist/client'
import type { Manifest } from '../db/manifest'
import {
  isExcluded as matchesGlob,
  isOpenListTempMarker,
  relativizeRemote,
  joinRemote as joinRemotePath
} from '../watcher/paths'
import { join } from 'path'
import { tick } from '../io/tick'
import type { AppConfig, DiffEntry, DiffKind, ScanKind, ScanTrigger } from '@shared/types'

/**
 * 远端对账器。
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
  /**
   * 取当前配置。
   *
   * 必须是**函数**而不是配置对象：配置可以在运行时改。
   *
   * 以前这里存的是构造那一刻的快照，而 Reconciler 只在
   * 「远端扫描参数 / 远端根 / OpenList 连接信息」变化时才重建。
   * 于是用户只改了「回收站目录」（trashRoot）时，对账器不重建，
   * 远端多余文件仍被移到**旧的**回收站路径；
   * 更糟的是，旧回收站目录不再被排除规则覆盖，
   * 下轮对账会把旧回收站里的文件全判成「仅远端存在」的差异。
   */
  getConfig?: () => AppConfig
  /**
   * 配置快照（兼容旧调用方）。
   *
   * 只在 `getConfig` 缺席时使用——那意味着配置在运行期不会变。
   */
  config?: AppConfig
  /** 差异处理器：把需要修正的差异交给 Planner */
  onDiff?: (diff: {
    kind: DiffKind
    localPath: string | null
    remotePath: string
  }) => void
  /**
   * 差异落库后的通知：把**完整**的差异条目推给渲染进程。
   *
   * 与 onDiff 分开是刻意的：
   * - onDiff 是「机器动作」通道，只在需要自动修复时才触发
   * - onDiffRecorded 是「人看的」通道，每条差异都要推，
   *   否则用户在对账页看不到任何东西
   *
   * 以前只有前者，且只有 size_mismatch / missing_remote 两种会触发，
   * 于是「远端有、本地无」这种差异从来不会出现在界面上。
   */
  onDiffRecorded?: (diff: DiffEntry) => void
  /**
   * 下载请求：需要把远端文件拉到本地时回调。
   *
   * 由 Planner 接管，才能在任务表里显示为「下载」类别并支持进度与取消。
   */
  onPull?: (params: { relPath: string; remotePath: string; size: number }) => void
  /**
   * 一轮对账结束时的回调（无论成功失败都会调）。
   *
   * 以前统计只在「手动对账」那条路径上回写，
   * 定时与启动触发的对账跑完什么痕迹都不留——
   * 概览页永远显示「尚未执行对账」，用户根本不知道它其实在跑。
   */
  onComplete?: (result: ReconcileResult) => void
  /**
   * 遍历过程中的进度回调。
   *
   * 存在的理由同上：远端树可能很大，一轮对账要几十秒，
   * 期间界面没反馈就像卡死。
   */
  onProgress?: (progress: { dirs: number; files: number }) => void
  /**
   * 探测本地是否真的存在某个文件，并带回它的元信息。
   *
   * 用来区分两种「远端有、清单里没有」的情况：
   * 1. 本地确实没有 → 真的是「仅远端存在」（remote_only）
   * 2. 本地有，只是清单里还没记（上传还在排队 / 刚跑完还没落库）
   *    → 这不是差异，只是状态还没同步上
   *
   * 不区分就会出假差异：全新环境首次运行时清单是空的，
   * 对账把远端一切判成「仅远端存在」，用户照着提示点「移入回收站」
   * 就会把好好的远端文件删掉。
   *
   * 为什么返回元信息而不只是布尔值：认领（adoptRemote）需要本地文件的
   * **大小**——「同名 + 同大小」是两个条件，缺一个都不能认领。
   *
   * @returns 本地不存在时返回 null；存在时返回 { size, mtimeMs }
   */
  probeLocal?: (relPath: string) => { size: number; mtimeMs: number } | null
  /**
   * 「现在忙不忙」的探针。
   *
   * 对账和同步会同时跑（用户点完「开始同步」再点「对账远端」）。
   * 对账本身是**纯 CPU + SQLite** 的循环，一旦它把主线程占满，
   * 同步那边的事件处理、上传进度回报、界面点击全都被排到后面——
   * 用户看到的就是「一开对账整个程序就卡住」。
   *
   * 返回 true 时对账会在分片之间多睡一会儿，把主线程让给同步。
   * 这是「后台任务」应有的礼貌，而不是限速。
   */
  isBusy?: () => boolean
}

/** 一个目录里最多连续写多少条快照就让出一次事件循环 */
const ENTRY_CHUNK = 200
/** 忙时的额外让路时长 */
const BUSY_YIELD_MS = 40

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

  /**
   * 取当前配置。
   *
   * 优先用 `getConfig`（实时读）；没有它就退回 `config` 快照
   * ——那说明调用方明确表示配置在运行期不会变。
   */
  private currentConfig(): AppConfig {
    if (this.opts.getConfig) return this.opts.getConfig()
    if (this.opts.config) return this.opts.config
    throw new Error('Reconciler 缺少配置来源（getConfig 或 config）')
  }
  /** 本次对账已自动处置的差异数；受 autoFixLimit 约束 */
  private autoFixed = 0

  constructor(private readonly opts: ReconcilerOptions) {}

  /**
   * 按配置的周期启动定时对账。
   *
   * @param opts.deferStartup 为 true 时**不**立刻跑「启动即对账」那一轮，
   *   只排定时器。调用方（Engine）会在本地首轮扫描与上传队列都安静下来
   *   之后自己调 `runStartup()`。
   *
   *   为什么必须能延后：点「开始同步」的瞬间，本地正在遍历整棵目录树
   *   （几万次 stat + 事件处理 + 写库），对账同时挂着整套远端遍历与
   *   差异比对——两边抢同一个主线程和同一个 SQLite 连接，
   *   结果就是界面完全失去响应。分开跑，总耗时几乎不变，但界面一直是活的。
   */
  start(opts: { deferStartup?: boolean } = {}): void {
    const { enabled, intervalHours, onStartup } = this.currentConfig().remoteScan
    if (!enabled) return
    // 重复调用（改配置后重建实例之外的情况）不该排出两个定时器
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    if (onStartup && !opts.deferStartup) {
      // 异步执行，不阻塞启动
      void this.run('startup').catch(() => undefined)
    }

    const ms = Math.max(1, intervalHours) * 60 * 60 * 1000
    this.timer = setInterval(() => {
      void this.run('timer').catch(() => undefined)
    }, ms)
    this.timer.unref?.()
  }

  /**
   * 跑一轮「启动即对账」。
   *
   * 由 Engine 在预热结束后调用（见 start 的 deferStartup）。
   * 已在跑时直接复用，不抛「对账已在进行中」——这条路径是内部触发的，
   * 抛错只会在日志里留下一句没人能处理的异常。
   */
  async runStartup(): Promise<ReconcileResult | null> {
    if (this.running) return null
    if (!this.currentConfig().remoteScan.onStartup) return null
    return this.run('startup')
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
    this.autoFixed = 0

    const { manifest } = this.opts
    // 实时取配置：用户在 UI 里改了回收站目录等参数后要立刻生效
    const config = this.currentConfig()
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

      // 本地清单先读出来：判断「某个目录本该有文件却列不出来」要用它做基准
      const localFiles = manifest.listFiles({ limit: 100_000 })

      // 每个远端目录按本地清单预期会有多少文件
      const expectedByDir = new Map<string, number>()
      for (const f of localFiles) {
        if (!f.remotePath || f.state === 'deleted') continue
        const dir = remoteDirname(f.remotePath)
        expectedByDir.set(dir, (expectedByDir.get(dir) ?? 0) + 1)
      }

      /**
       * 本轮列举结果不可信的目录。
       *
       * 两种情况算不可信：
       * 1. 列举抛错（如目录被缓存刷新抹掉 → object not found）
       * 2. 列举返回空列表，但本地清单显示这个目录本该有文件
       *
       * 这些目录下的文件**一律不判「远端缺失」**。
       * 宁可漏一轮重传，也不能把整棵树误判成丢失——那会白白再上行一遍，
       * 严重时是一轮全量重传。
       */
      const unreliableDirs = new Set<string>()

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
            .then(async (entries) => {
              scannedDirs++

              // 空列表但本地清单说这里有文件 → 结果不可信
              if (entries.length === 0 && (expectedByDir.get(dir) ?? 0) > 0) {
                unreliableDirs.add(dir)
                manifest.log(
                  'warn',
                  `远端目录 ${dir} 列举结果为空，但本地清单显示其下有文件，本轮不判定其内容`
                )
                this.opts.onProgress?.({ dirs: scannedDirs, files: scannedFiles })
                return
              }

              /*
               * 一个目录里可能有几千个条目（用户把整个盘根设成远端根时尤其常见）。
               *
               * 以前这里是一个纯同步的 for 循环，每个文件一次
               * `upsertRemoteSnapshot`（同步 SQLite 写）。三千个条目就是
               * 三千次同步写，期间主线程**完全不动**——所有点击、
               * 上传进度回报、哈希回调都排在后面。
               *
               * 现在按 ENTRY_CHUNK 分片，每片之后让出一次事件循环。
               * 总耗时不变，但界面全程可交互。
               */
              const ingestStart = scannedFiles
              for (let i = 0; i < entries.length; i++) {
                const entry = entries[i]
                const full = joinRemote(root, dir, entry.name)
                if (entry.isDir) {
                  // 跳过排除目录（回收站等）——不进队列，其下内容也不会被遍历
                  if (isExcluded(full, config)) continue
                  queue.push(full)
                  continue
                }
                // 文件也要过排除规则：形如 `**/.DS_Store` 的规则匹配的是文件
                if (isExcluded(full, config)) continue
                /*
                 * OpenList 覆盖上传的内部标记文件。
                 *
                 * `xxx.openlist_to_delete` 是服务端覆盖过程中的中间态，
                 * 不是用户的文件。留着它会凭空多出一条「仅远端存在」差异，
                 * 路径还带个怪后缀——用户点「下载到本地」会下载出
                 * 一个叫 `数据.csv.openlist_to_delete` 的文件。
                 */
                if (isOpenListTempMarker(entry.name)) {
                  manifest.log('warn', `忽略 OpenList 临时标记文件：${full}`)
                  continue
                }
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

                if ((i + 1) % ENTRY_CHUNK === 0) {
                  this.opts.onProgress?.({ dirs: scannedDirs, files: scannedFiles })
                  await this.yieldIfBusy()
                }
              }
              if (scannedFiles === ingestStart) {
                // 全是目录 / 全被排除：也该让出一次，避免连续几个大目录把主线程连着占住
                await this.yieldIfBusy()
              }

              /*
               * 每处理完一个目录就报一次进度。
               *
               * 远端树事先数不出总量（要遍历才知道），
               * 所以用「已扫描 N 个目录 / M 个文件」的形式反馈——
               * 有反馈比没反馈好，界面不会看着像卡死。
               */
              this.opts.onProgress?.({ dirs: scannedDirs, files: scannedFiles })
            })
            .catch((err: unknown) => {
              // 列举失败必须兜住：否则这里会变成未处理的 promise 拒绝，
              // 而该目录会被静默跳过 → 其下所有文件被判「远端缺失」→ 全量重传。
              unreliableDirs.add(dir)
              const message = err instanceof Error ? err.message : String(err)
              manifest.log('warn', `远端目录列举失败，本轮不判定其内容：${dir}（${message}）`)
            })
            .finally(() => {
              inFlight.delete(dir)
            })
        }

        // 让出事件循环，等待在途请求完成
        if (inFlight.size > 0) await sleep(50)
      }

      // 与本地清单比对
      const localByRemote = new Map<string, (typeof localFiles)[number]>()
      for (const f of localFiles) {
        if (f.remotePath) localByRemote.set(f.remotePath, f)
      }

      // 比对阶段也报进度：这一步是纯 CPU 循环，文件多时也要好几秒
      this.opts.onProgress?.({ dirs: scannedDirs, files: scannedFiles })

      // 远端有、本地无 → remote_only
      /*
       * 比对阶段同样是纯 CPU 循环（几万条 × 查表 + 写差异表），
       * 全同步跑完会独占主线程十几秒。按片让出，界面保持可交互。
       */
      const remoteEntries = [...remoteFiles]
      for (let i = 0; i < remoteEntries.length; i++) {
        if (i > 0 && i % ENTRY_CHUNK === 0) await this.yieldIfBusy()
        const [remotePath, obj] = remoteEntries[i]
        const local = localByRemote.get(remotePath)
        if (!local) {
          /*
           * localPath 记「它本该在本地哪个位置」。
           *
           * 不是 null——null 会让这一条差异在清单页无从显示，
           * 也让「下载到本地」找不到落点（那条路径必抛「没有对应的本地路径」）。
           * 反推规则与 Planner 一致：远端路径相对远端根 = 本地相对路径。
           */
          const relPath = relativizeRemote(config.remoteRoot, remotePath)

          /*
           * 清单里没有这条记录，**不等于**本地没有这个文件。
           *
           * 全新环境首次运行时清单是空的，本地文件却实实在在躺在那儿
           * （可能正排队等着上传，或刚传完还没落库）。
           * 这时候把它判成「仅远端存在」会出两个坏结果：
           *   - 界面上冒出一堆假差异，吓一跳
           *   - 用户照着提示点「移入回收站」，把好好的远端文件删了
           *
           * 所以要先探一下本地：本地确实在 → 这不是差异，是状态没同步上。
           */
          const localProbe = relPath ? this.opts.probeLocal?.(relPath) ?? null : null
          if (localProbe) {
            /*
             * 「同名 + 同大小」→ 认领。
             *
             * 两个条件必须同时成立：路径（相对远端根）相同、大小相同。
             * 只比名字会把 `a/x.jpg` 和 `b/x.jpg` 混为一谈，所以按**相对路径**比。
             *
             * 认领之后写入同步基准，下一轮扫描的 L1 快筛直接命中 → 零上行。
             * 这正是「换了台设备 / 清过 userData 就整批重传一遍」的解法。
             *
             * ⚠️ 这是**弱认定**：只比了大小，没读内容。
             * 所以 verify_level 记 'size'，界面上能看出来；
             * synced_md5/synced_sha1 保持 NULL（没校验内容不能谎称哈希确认）。
             */
            if (config.remoteScan.adoptByNameAndSize && localProbe.size === obj.size) {
              const adopted = manifest.adoptRemote({
                localPath: relPath,
                localSize: localProbe.size,
                mtimeMs: localProbe.mtimeMs,
                remotePath,
                remoteSize: obj.size
              })
              if (adopted) {
                manifest.log(
                  'info',
                  `远端已有同名同大小文件 ${remotePath}，已认领为已同步（未校验内容）`
                )
              }
              continue
            }

            manifest.log(
              'info',
              `远端文件 ${remotePath} 在本地也存在但清单尚未记录，本轮不判为差异`
            )
            continue
          }

          const entry = manifest.recordDiff({
            kind: 'remote_only',
            localPath: relPath || null,
            remotePath,
            localSize: null,
            remoteSize: obj.size,
            localMtime: null,
            remoteMtime: parseModified(obj.modified)
          })
          diffCount++
          this.opts.onDiffRecorded?.(entry)
          await this.applyRemoteOnlyPolicy(remotePath, obj.size)
          continue
        }

        // 两边都有：比对大小与修改时间
        const remoteMtime = parseModified(obj.modified)
        if (local.remoteSize !== obj.size) {
          const entry = manifest.recordDiff({
            kind: 'size_mismatch',
            localPath: local.localPath,
            remotePath,
            localSize: local.localSize,
            remoteSize: obj.size,
            localMtime: local.mtimeMs,
            remoteMtime
          })
          diffCount++
          this.opts.onDiffRecorded?.(entry)
          this.opts.onDiff?.({
            kind: 'size_mismatch',
            localPath: local.localPath,
            remotePath
          })
        } else {
          /*
           * 两侧都在、大小一致 → 内容判定通过。
           *
           * 「修改时间不同」**不再**单独列为差异：复制、解压、跨设备同步
           * 都会改 mtime，而内容可能一模一样。把它列进对账清单只会制造噪声，
           * 用户要回答的是「这个文件在不在」「两边是不是同一份」。
           */
          manifest.markVerified(local.localPath)
        }
      }

      // 本地有、远端无 → missing_remote（最危险的一类）
      for (let i = 0; i < localFiles.length; i++) {
        // 这一步每条都可能要发一个远端请求（confirmMissing），
        // 让出的间隔取小一点，别让界面在复核阶段长时间停顿
        if (i > 0 && i % 50 === 0) await this.yieldIfBusy()
        const local = localFiles[i]
        if (!local.remotePath) continue
        if (local.state === 'deleted') continue
        if (seen.has(local.remotePath)) continue
        if (remoteFiles.has(local.remotePath)) continue

        // 所属目录本轮列举不可信 → 不能判它「缺失」
        if (isUnderAnyDir(local.remotePath, unreliableDirs)) continue

        // ⚠️ 「远端没有」这个结论必须复核后才能成立。
        //
        // OpenList 的目录列表是快照缓存，`refresh:true` 会用夸克侧当时的
        // 真实列表整体替换缓存。若某个文件还没在夸克落盘
        //（PUT 返回 200 只表示 OpenList 收下了字节流，夸克侧要再过约 1 秒），
        // 它会被这次刷新从缓存里抹掉——于是「刚上传成功的文件」被误判成丢失。
        //
        // 误判的后果是重传：白白再上行一遍。更糟的是这会形成死循环
        // （上传 → 校验 → 对账判缺失 → 重传 → …）。
        //
        // 所以这里刷新父目录后再确认一次：确实不在才算真的缺失。
        if (!(await this.opts.client.confirmMissing(local.remotePath))) {
          // 复核后其实还在 → 是缓存假阴性，不算差异
          continue
        }

        const entry = manifest.recordDiff({
          kind: 'missing_remote',
          localPath: local.localPath,
          remotePath: local.remotePath,
          localSize: local.localSize,
          remoteSize: null,
          localMtime: local.mtimeMs,
          remoteMtime: null
        })
        diffCount++
        this.opts.onDiffRecorded?.(entry)
        this.opts.onDiff?.({
          kind: 'missing_remote',
          localPath: local.localPath,
          remotePath: local.remotePath
        })
      }

      manifest.finishScan(scanId, timedOut ? 'cancelled' : 'done', {
        /*
         * 存**文件数**，不是目录数。
         *
         * 界面上「上次扫描 N 个文件」说的是文件数（引擎用的是
         * scannedFiles）。这里存目录数的话，重启后回读出来的数字
         * 会跟运行中显示的对不上——同一轮对账，两个数。
         */
        scanned: scannedFiles,
        changed: diffCount,
        errors: 0
      })

      const result = { scanId, scannedDirs, scannedFiles, diffCount, timedOut }
      this.opts.onComplete?.(result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.finishScan(scanId, 'failed', { scanned: scannedFiles, changed: diffCount, errors: 1 }, message)
      manifest.log('error', `远端对账失败：${message}`)
      const result = {
        scanId,
        scannedDirs,
        scannedFiles,
        diffCount,
        timedOut: false,
        error: message
      }
      this.opts.onComplete?.(result)
      return result
    } finally {
      this.running = false
    }
  }

  private async listDir(path: string, refresh: boolean): Promise<RemoteObject[]> {
    const res = await this.opts.client.list(path, { refresh })
    return res.content ?? []
  }

  /**
   * 让出主线程一次；同步正在忙时多让一会儿。
   *
   * 对账是后台任务，它跑多久不重要，重要的是别把前台卡住。
   */
  private async yieldIfBusy(): Promise<void> {
    await tick()
    if (this.opts.isBusy?.()) {
      await new Promise<void>((resolve) => setTimeout(resolve, BUSY_YIELD_MS))
    }
  }

  /**
   * 按 `remoteOnlyPolicy` 处置「仅远端存在」的文件。
   *
   * 三档：
   * - `record-only`（默认）：只记录差异，不动作。避免误删其他设备刚上传的内容
   * - `pull`：下载到本地同步目录
   * - `delete`：移入远端回收站
   *
   * `pull` 与 `delete` 都是破坏性方向的自动动作，因此受 autoFixLimit 约束——
   * 一次对账不该引发大批下载或删除。
   */
  private async applyRemoteOnlyPolicy(remotePath: string, size: number): Promise<void> {
    const { manifest } = this.opts
    const config = this.currentConfig()
    const policy = config.remoteScan.remoteOnlyPolicy
    if (policy === 'record-only') return

    if (this.autoFixed >= config.remoteScan.autoFixLimit) {
      manifest.log(
        'warn',
        `对账自动修复已达上限 ${config.remoteScan.autoFixLimit}，其余远端多出文件仅记录`
      )
      return
    }

    try {
      if (policy === 'pull') {
        // 远端路径 → 本地相对路径 → 本地绝对路径
        const rel = relativizeRemote(config.remoteRoot, remotePath)
        if (!rel) return
        /*
         * 交给 Planner 排下载任务，而不是自己 downloadTo。
         *
         * 自己下载的话，用户在传输队列里看不到这个文件——
         * 队列是用户判断「同步是否正常」的唯一依据，
         * 少了一段下载过程却不说，出了错根本无从查起。
         */
        if (this.opts.onPull) {
          this.opts.onPull({ relPath: rel, remotePath, size })
        } else {
          // 没有挂上下载通道（单测场景）时退化为直接下载
          await this.opts.client.downloadTo(remotePath, join(config.syncRoot, rel))
        }
        this.autoFixed++
        manifest.log('info', `已从远端下载到本地：${remotePath}`)
        return
      }

      if (policy === 'delete') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const rel = relativizeRemote(config.remoteRoot, remotePath)
        // 回收站必须落在 remoteRoot 之下：远端根上往往只有存储挂载点，
        // 在根上建目录会得到 "storage not found"。
        const dest = joinRemotePath(
          config.remoteRoot,
          `${config.trashRoot}/${stamp}/${rel}`
        )
        await this.opts.client.move(remotePath, dest)
        this.autoFixed++
        manifest.log('info', `远端多出文件已移入回收站：${remotePath}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      manifest.log('error', `处置远端多出文件失败 ${remotePath}：${message}`)
    }
  }
}

// ── 工具函数 ────────────────────────────────────────────

/** 拼接远端路径，保持 POSIX 分隔 */
function joinRemote(root: string, dir: string, name: string): string {
  const base = dir === root ? root : dir
  return `${base.replace(/\/+$/, '')}/${name}`
}

/** 远端路径的父目录；根路径归一为 '/' */
function remoteDirname(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

/**
 * 该路径是否位于任一不可信目录之下。
 *
 * 用于「目录列举不可信 → 其下文件一律不判远端缺失」。
 * 目录边界按整段比较，避免 `/a` 误匹配 `/ab`。
 */
function isUnderAnyDir(path: string, dirs: Set<string>): boolean {
  for (const dir of dirs) {
    if (path === dir) return true
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    if (path.startsWith(prefix)) return true
  }
  return false
}

function parseModified(modified: string | undefined): number | null {
  if (!modified) return null
  const t = Date.parse(modified)
  return Number.isNaN(t) ? null : t
}

/**
 * 回收站与排除目录不参与比对。
 *
 * 排除规则作用于**相对远端根的路径**（如 `_trash/**`），
 * 而不是完整远端路径——后者带根目录前缀，规则写起来别扭。
 */
function isExcluded(path: string, config: AppConfig): boolean {
  const trashRoot = config.trashRoot
  if (trashRoot && hasSegment(path, trashRoot)) return true

  const rel = relativizeRemote(config.remoteRoot, path)
  if (rel === '') return false

  const patterns = config.remoteScan.exclude
  if (patterns.length === 0) return false
  return matchesGlob(rel, patterns)
}

/**
 * 路径中是否存在某个完整的目录段。
 *
 * 用「整段相等」而不是 `includes`：
 * `_trash` 不该匹配到 `my_trash_backup` 这种名字里恰好含它的目录。
 */
function hasSegment(path: string, segment: string): boolean {
  return path.split('/').some((s) => s === segment)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type { ScanKind }
