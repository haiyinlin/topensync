import { readdir, stat, rm } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'

/**
 * 存储占用与缓存清理。
 *
 * 数据目录（`app.getPath('userData')`）里混着两类东西：
 * - **数据库**：`manifest.db`（含 `-wal` / `-shm`）——同步清单，
 *   删了就要重新全盘扫描，属于「不能随便清」的数据。
 * - **缓存**：Electron / Chromium 运行时建的 `Cache`、`Code Cache`、
 *   `GPUCache`、`DawnGraphiteCache`、`DawnWebGPUCache`、`blob_storage`
 *   等目录——纯提速用，删了下次启动重建，**清理是安全的**。
 *
 * 这里把两类分开统计、分开处理：界面展示占用，缓存可一键清除，
 * 数据库只读不删。
 */

/** 缓存目录名（相对 userData）。这些目录删除后 Chromium 会自动重建 */
const CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'Network'
])

export interface StorageDirInfo {
  name: string
  bytes: number
  fileCount: number
}

export interface StorageInfo {
  /** 数据目录绝对路径 */
  dataDir: string
  /** 数据库文件大小（manifest.db + -wal + -shm），字节 */
  databaseBytes: number
  /** 数据库明细（每个文件） */
  databaseFiles: StorageDirInfo[]
  /** 缓存总大小，字节 */
  cacheBytes: number
  /** 缓存目录明细 */
  cacheDirs: StorageDirInfo[]
  /** 诊断包目录大小，字节 */
  diagnosticsBytes: number
}

/** 递归统计目录大小（含文件数）。读不到就当 0，不让一个坏目录卡死整个统计 */
async function dirSize(dir: string): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0
  let fileCount = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        const sub = await dirSize(abs)
        bytes += sub.bytes
        fileCount += sub.fileCount
      } else if (entry.isFile()) {
        try {
          const st = await stat(abs)
          bytes += st.size
          fileCount++
        } catch {
          // 文件在统计期间被删/被占用 → 跳过
        }
      }
    }
  } catch {
    // 目录不存在或不可读 → 整支跳过
  }
  return { bytes, fileCount }
}

/** 读数据目录，算出数据库与缓存的占用 */
export async function getStorageInfo(): Promise<StorageInfo> {
  const dataDir = app.getPath('userData')

  // 数据库文件：manifest.db 及它的 WAL/SHM 伴生文件
  const databaseFiles: StorageDirInfo[] = []
  let databaseBytes = 0
  for (const name of ['manifest.db', 'manifest.db-wal', 'manifest.db-shm']) {
    try {
      const st = await stat(join(dataDir, name))
      databaseFiles.push({ name, bytes: st.size, fileCount: 1 })
      databaseBytes += st.size
    } catch {
      // 文件不存在（比如首次运行还没有 -wal）
    }
  }

  // 缓存目录
  const cacheDirs: StorageDirInfo[] = []
  let cacheBytes = 0
  for (const name of CACHE_DIRS) {
    const { bytes, fileCount } = await dirSize(join(dataDir, name))
    if (bytes > 0 || fileCount > 0) {
      cacheDirs.push({ name, bytes, fileCount })
      cacheBytes += bytes
    }
  }

  // 诊断包目录
  const diag = await dirSize(join(dataDir, 'diagnostics'))

  return {
    dataDir,
    databaseBytes,
    databaseFiles,
    cacheBytes,
    cacheDirs,
    diagnosticsBytes: diag.bytes
  }
}

export interface ClearCacheResult {
  /** 释放的字节数 */
  freedBytes: number
  /** 清理掉的目录 */
  removedDirs: string[]
  /** 清理失败（仍残留）的目录 */
  failedDirs: string[]
}

/**
 * 清除缓存目录。
 *
 * 只删白名单里的缓存目录，不碰数据库、配置、诊断包、日志。
 * 删除失败（目录被占用等）不中断——逐目录记下来，返回给界面如实展示。
 */
export async function clearCache(): Promise<ClearCacheResult> {
  const dataDir = app.getPath('userData')
  let freedBytes = 0
  const removedDirs: string[] = []
  const failedDirs: string[] = []

  for (const name of CACHE_DIRS) {
    const abs = join(dataDir, name)
    const before = await dirSize(abs)
    if (before.bytes === 0 && before.fileCount === 0) continue

    try {
      await rm(abs, { recursive: true, force: true })
      removedDirs.push(name)
      freedBytes += before.bytes
    } catch {
      failedDirs.push(name)
    }
  }

  return { freedBytes, removedDirs, failedDirs }
}

/** 人性化的字节格式化，给界面直接显示用 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = -1
  do {
    value /= 1024
    i++
  } while (value >= 1024 && i < units.length - 1)
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`
}
