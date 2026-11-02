import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Watcher } from '../src/main/watcher/watcher'

/**
 * 「开始同步」复用已入库基准快照，不再强制全盘重扫。
 *
 * 用户三条反馈的共同根因：
 * 1. 点「开始同步」卡顿——startSync 无条件 scanAndCompare(true) 全盘遍历，
 *    stat 风暴跟上传抢主线程；
 * 2. 同步过程中又自动扫描本地——同一个全盘遍历；
 * 3. 已完成的内容变到已跳过——全盘遍历把每个文件重新喂给 Planner，
 *    L1 命中走 recordSkip，把任务状态从 synced 覆盖成 skipped。
 *
 * 现在：清单非空时把 size:mtime 指纹灌给 Watcher 当基准，
 * 跳过首次全盘遍历；只有清单为空（真·首次）才全盘扫。
 */

describe('Watcher 复用入库快照（跳过首扫）', () => {
  let dir: string
  let root: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-snapshot-'))
    root = join(dir, 'sync')
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'sub', 'b.txt'), 'b')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('传入非空快照时，start 不触发 onEvent（不重扫）', async () => {
    const events: string[] = []
    const ready: number[] = []
    const w = new Watcher({
      root,
      exclude: [],
      mode: 'poll', // 用 poll 保证不依赖真实文件系统监听，行为确定
      onEvent: (e) => events.push(e.relPath),
      onReady: (n) => ready.push(n),
      initialSnapshot: new Map([
        ['a.txt', '1:0'],
        ['sub/b.txt', '1:0']
      ])
    })
    w.start()

    // 不重扫 → onEvent 应该一条都没有，onReady 直接上报快照条数
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toHaveLength(0)
    expect(ready).toEqual([2])
    w.stop()
  })

  it('传入空快照时，仍全盘扫一遍（真·首次使用）', async () => {
    const events: string[] = []
    const w = new Watcher({
      root,
      exclude: [],
      mode: 'poll',
      onEvent: (e) => events.push(e.relPath),
      initialSnapshot: new Map()
    })
    w.start()

    // 空快照 → 走首轮全量遍历，两个文件都发事件
    await new Promise((r) => setTimeout(r, 1500))
    expect(events.sort()).toEqual(['a.txt', 'sub/b.txt'])
    w.stop()
  })

  it('不传 initialSnapshot 时行为不变（首次全扫）', async () => {
    const events: string[] = []
    const w = new Watcher({
      root,
      exclude: [],
      mode: 'poll',
      onEvent: (e) => events.push(e.relPath)
    })
    w.start()

    await new Promise((r) => setTimeout(r, 1500))
    expect(events.sort()).toEqual(['a.txt', 'sub/b.txt'])
    w.stop()
  })
})
