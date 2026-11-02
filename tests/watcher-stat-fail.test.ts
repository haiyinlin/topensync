import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 「本地扫描到下一轮，就把已完成给清了」的根因回归。
 *
 * 根因：`scanLocalTree` 里 stat 失败的文件（网络盘抖动、句柄不足）
 * 以前 `if (!info) continue` 直接跳过，缺席本轮 `current` 快照。
 * `scanAndCompare` 用「上一轮有、这一轮没有」判定文件被删除，于是
 * 下一轮就把这个只是「瞬时读不到」的文件误判成「已删除」，发出
 * remove 事件 → handleRemoval → 状态写成 deleted。
 *
 * 修复：stat 失败的文件**仍然回调**（info = null），让上层继承上一轮
 * 指纹而非判删除。本测试锁住这个行为。
 */

// 让指定路径 stat「瞬时读不到」的集合
const failingPaths = new Set<string>()

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: vi.fn((p: unknown) => {
      const path = String(p).replace(/\\\\\?\\/g, '')
      if (failingPaths.has(path)) {
        return Promise.reject(new Error('EBUSY: resource busy or locked'))
      }
      return actual.stat(p as never)
    })
  }
})

import { scanLocalTree } from '../src/main/watcher/watcher'

describe('scanLocalTree 对 stat 失败文件的处理', () => {
  let dir: string
  let root: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-statfail-'))
    root = join(dir, 'sync')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ok.txt'), 'ok')
    writeFileSync(join(root, 'flaky.txt'), 'flaky')
    failingPaths.clear()
  })

  afterEach(() => {
    failingPaths.clear()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stat 失败的文件仍然回调 onFile，且 info 为 null（而不是被静默跳过）', async () => {
    const seen: Array<{ rel: string; info: unknown }> = []
    failingPaths.add(join(root, 'flaky.txt'))

    const count = await scanLocalTree({
      root,
      exclude: [],
      withStat: true,
      onFile: (rel, _abs, _done, info) => {
        seen.push({ rel, info })
      }
    })

    // 两个文件都回调了（失败的也回调）
    expect(count).toBe(2)
    expect(seen).toHaveLength(2)

    const ok = seen.find((s) => s.rel === 'ok.txt')
    const flaky = seen.find((s) => s.rel === 'flaky.txt')

    // 正常文件 info 是 size+mtime
    expect(ok).toBeTruthy()
    expect(ok?.info).toBeTruthy()
    expect((ok?.info as { size: number }).size).toBeGreaterThan(0)

    // stat 失败的文件 info 为 null——这是「读不到」的信号，不是「不存在」
    expect(flaky?.info).toBeNull()
  })

  it('stat 失败不会改变 count（失败文件仍计入遍历总数）', async () => {
    failingPaths.add(join(root, 'flaky.txt'))

    const count = await scanLocalTree({
      root,
      exclude: [],
      withStat: true,
      onFile: () => undefined
    })

    expect(count).toBe(2)
  })
})
