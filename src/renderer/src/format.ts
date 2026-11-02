/**
 * 界面上的数字格式化。
 *
 * 单独放一个模块，而不是散在各页面里各自导出——
 * 之前 `formatSize` 在 Queue.tsx、`formatSpeed` 在 Overview.tsx，
 * 而这两个页面又互相 import，成了一个循环依赖。
 * 顶栏也要显示速率，再从这里引一次就转不开了。
 */

/** 字节数 → 人类可读的大小 */
export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

/**
 * 字节/秒 → 人类可读的速率。
 *
 * 单位用 B/s、KB/s、MB/s、GB/s——不是 bit。
 * 用户看的是「每秒传了多少」，位速率会让人对不上文件大小。
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
