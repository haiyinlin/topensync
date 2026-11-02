import { stat } from 'fs/promises'
import type { Manifest } from '../db/manifest'
import type { FileEntry } from '@shared/types'

/**
 * 重命名识别。
 *
 * ## 为什么需要
 *
 * 文件管理器改名时，文件系统层面发生的是**两件独立的事**：
 * 旧路径消失 + 新路径出现。chokidar 也因此报两条事件。
 *
 * 如果按字面处理，就是「删远端旧文件 + 传新文件」——
 * 一次 2GB 的改名会变成「删掉远端 2GB + 重新上行 2GB」，
 * 而文件内容其实一个字节都没变。
 *
 * ## 判定依据
 *
 * 首选 **inode**（Windows 上是文件索引号）：同一个文件改名时 inode 不变，
 * 而路径变。且 inode 只要 stat 一次就有，不用读文件内容。
 *
 * 但 inode 不是万能的：
 * - 跨卷移动（从 D 盘拖到 E 盘）会得到新的 inode
 * - 有些文件系统（部分网络盘、FAT32）根本不提供稳定的 inode
 *
 * 因此备选是 **size + 内容哈希** 组合：哈希相同即内容相同。
 * 代价是要读一遍文件——所以只在 inode 不可用时才走这条路。
 *
 * ## 误判防护
 *
 * 「删了 A 又建了个内容相同的新文件 A」在 inode 层面会被误判成重命名。
 * 这类操作语义上就是重命名（远端结果一致），所以可以接受。
 * 但若旧路径与新路径**在同一目录**且**改名幅度极小**（如 `a.txt` → `b.txt`），
 * 需额外确认两者不是同路径的自我替换。
 */

export interface RenameCandidate {
  /** 旧路径（相对同步根） */
  oldRelPath: string
  /** 新路径（相对同步根） */
  newRelPath: string
  /** 旧路径对应的远端路径 */
  oldRemotePath: string
  /** 判定依据，写进日志便于排查 */
  reason: 'inode' | 'hash'
}

export interface RenameDetectorOptions {
  manifest: Manifest
  /** 候选窗口（毫秒）：两次事件的间隔超过它就不再考虑重命名 */
  windowMs: number
  /** 读取本地 inode（字符串：Windows 文件索引号超出 2^53） */
  getInode: (absPath: string) => Promise<string | null>
  /** 计算本地文件哈希（仅在 inode 不可用时使用） */
  hashFile: (absPath: string) => Promise<{ md5: string; sha1: string; size: number }>
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * 记录一次「本地路径消失」。
 *
 * 删除事件先不立即执行——要等 renameWindowMs，看有没有「新路径出现」
 * 与之配对。窗口内配上了就是重命名，否则按普通删除处理。
 */
export interface PendingRemoval {
  relPath: string
  /** 消失时刻 */
  at: number
  /** 消失时的文件信息（从清单取） */
  entry: FileEntry | null
}

export class RenameDetector {
  /** 待配对的删除事件，按时间从早到晚 */
  private readonly pending = new Map<string, PendingRemoval>()

  constructor(private readonly opts: RenameDetectorOptions) {}

  /**
   * 登记一次本地删除。
   *
   * 返回 true 表示调用方**暂缓**删除动作（等待重命名配对）；
   * false 表示可以直接执行删除。
   */
  registerRemoval(relPath: string, entry: FileEntry | null): boolean {
    if (this.opts.windowMs <= 0) return false

    this.pending.set(relPath, { relPath, at: Date.now(), entry })
    return true
  }

  /**
   * 是否有配对成功。命中时从待配对表移除该删除记录。
   */
  private take(relPath: string): PendingRemoval | null {
    const found = this.pending.get(relPath)
    if (found) this.pending.delete(relPath)
    return found ?? null
  }

  /**
   * 清理**已经不再可能被配对**的删除记录。
   *
   * ⚠️ 这里绝不能删掉「已过窗口」的记录。
   *
   * 过期的删除不是废数据，而是**还没执行的删除**——它要由 drainExpired()
   * 交给上层真正落到远端（移入回收站或删除）。
   * 若在这里把它删掉，等于把用户的删除请求静默吞掉：
   * 本地文件没了，远端副本却永远留在那里。
   *
   * 所以过期的记录一律保留在表里，只是不再参与 match() 的配对
   * （由 match 内部按时间窗过滤）。
   */
  private prune(): void {
    // 目前没有需要在这里清理的记录：配对成功的由 take() 移除，
    // 过期的由 drainExpired() 移除。
  }

  /** 某条待配对记录是否仍在配对窗口内 */
  private inWindow(item: PendingRemoval, now: number): boolean {
    return now - item.at <= this.opts.windowMs
  }

  /**
   * 判断某个「新增」路径是否为某个「删除」的重命名。
   *
   * 命中则返回候选；未命中返回 null。
   */
  async match(
    newRelPath: string,
    newAbsPath: string
  ): Promise<RenameCandidate | null> {
    this.prune()
    if (this.pending.size === 0) return null

    // 只在窗口内的记录里找配对。过期的记录已经等太久，
    // 此刻配上了语义也不对（用户可能已经以为它被删了）。
    const now = Date.now()
    const candidates = [...this.pending.values()].filter(
      (r) => this.inWindow(r, now) && r.relPath !== newRelPath
    )
    if (candidates.length === 0) return null

    // 先试 inode：便宜且可靠
    const inode = await this.opts.getInode(newAbsPath)
    if (inode !== null && inode !== '') {
      for (const removal of candidates) {
        const oldInode = removal.entry?.localInode
        if (oldInode === null || oldInode === undefined) continue
        if (oldInode === inode) {
          this.take(removal.relPath)
          this.opts.onLog?.(
            'info',
            `识别到重命名：${removal.relPath} → ${newRelPath}（inode 匹配）`
          )
          return {
            oldRelPath: removal.relPath,
            newRelPath,
            oldRemotePath: removal.entry?.remotePath ?? '',
            reason: 'inode'
          }
        }
      }
    }
    // inode 对不上 → 退到「同大小 + 同哈希」
    // 只在候选数量可控时做，避免为每次新增都读一遍文件
    if (candidates.length > 8) return null

    let newStat: { size: number } | null = null
    try {
      newStat = await stat(newAbsPath)
    } catch {
      return null
    }

    for (const removal of candidates) {
      const old = removal.entry
      if (!old) continue
      if (old.syncedSize !== newStat.size) continue
      if (!old.md5) continue

      const hashes = await this.opts.hashFile(newAbsPath)
      if (hashes.md5 !== old.md5) continue

      this.take(removal.relPath)
      this.opts.onLog?.('info', `识别到重命名：${removal.relPath} → ${newRelPath}（内容哈希匹配）`)
      return {
        oldRelPath: removal.relPath,
        newRelPath,
        oldRemotePath: old.remotePath ?? '',
        reason: 'hash'
      }
    }

    return null
  }

  /**
   * 取出已过窗口、可以真正执行删除的记录。
   *
   * 调用方在延迟窗口结束后调用，把这些删除真正落到远端。
   */
  drainExpired(): PendingRemoval[] {
    this.prune()
    const expired: PendingRemoval[] = []
    for (const [path, item] of this.pending) {
      if (Date.now() - item.at > this.opts.windowMs) {
        expired.push(item)
        this.pending.delete(path)
      }
    }
    return expired
  }

  /** 清空待配对表（配置变更、停止时用） */
  clear(): void {
    this.pending.clear()
  }
}
