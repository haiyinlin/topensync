import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Watcher, type WatchEvent } from '../src/main/watcher/watcher'

/**
 * 「扫描本地」按钮的行为测试。
 *
 * 用户反馈：「扫描本地按钮也没生效」。
 *
 * 根因：以前这个动作走的是「停掉 watcher + 新建一个」。
 * chokidar 的 close() 是异步的，旧实例还没关完新实例就在同一目录上起了，
 * 于是新实例可能收不到初始事件；而扫描计数又是从 0 重新数的，
 * 界面上「已扫描 N 个文件」在重扫期间看起来毫无变化——
 * 用户点完按钮看到的就是「什么都没发生」。
 *
 * 现在的做法是 `rescan()`：不重建 watcher，直接走一遍目录树。
 */

describe('Watcher 强制重扫', () => {
  let dir: string
  let root: string
  let events: WatchEvent[]
  let watcher: Watcher

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-rescan-'))
    root = join(dir, 'sync')
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    writeFileSync(join(root, 'sub', 'c.txt'), 'c')

    events = []
    watcher = new Watcher({
      root,
      exclude: ['**/node_modules/**'],
      onEvent: (e) => events.push(e)
    })
  })

  afterEach(() => {
    watcher.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rescan 会把目录树里的每个文件都作为 upsert 事件发出', async () => {
    const count = await watcher.rescan()

    expect(count).toBe(3)
    const paths = events.map((e) => e.relPath).sort()
    expect(paths).toEqual(['a.txt', 'b.md', 'sub/c.txt'])
    expect(events.every((e) => e.type === 'upsert')).toBe(true)
  })

  it('rescan 会触发 onReady，让界面上的扫描计数可见地变化', async () => {
    const readyCounts: number[] = []
    const w = new Watcher({
      root,
      exclude: [],
      onEvent: () => undefined,
      onReady: (n) => readyCounts.push(n)
    })

    await w.rescan()

    expect(readyCounts).toHaveLength(1)
    expect(readyCounts[0]).toBe(3)
    w.stop()
  })

  it('rescan 尊重排除规则', async () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.js'), 'x')

    const count = await watcher.rescan()

    expect(count).toBe(3)
    expect(events.some((e) => e.relPath.includes('node_modules'))).toBe(false)
  })

  it('rescan 不重建 watcher 实例，重复调用不会叠加监听', async () => {
    await watcher.rescan()
    events.length = 0
    await watcher.rescan()

    // 每次 rescan 各发一次，不会因为「重建了 watcher」而翻倍
    expect(events.filter((e) => e.relPath === 'a.txt')).toHaveLength(1)
  })

  it('rescan 能发现新增的文件', async () => {
    await watcher.rescan()
    events.length = 0

    writeFileSync(join(root, 'new.txt'), 'new')
    const count = await watcher.rescan()

    expect(count).toBe(4)
    expect(events.some((e) => e.relPath === 'new.txt')).toBe(true)
  })
})
