import { describe, expect, it, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 速率统计的口径测试。
 *
 * 锁住一个真实反馈：「上传下载速率、峰值、平均一个都没体现」。
 *
 * 根因有两条，都在 `Engine.recordSpeed` / `getSpeedStats`：
 *
 * 1. 只在「1 秒窗口关闭」时结算当前速率与峰值——而单个文件往往
 *    几百毫秒就传完了，窗口永远等不到关闭的时刻，于是三个数全是 0。
 * 2. 平均速率除以「从引擎构造到现在的总时长」，把挂机时间也算进去。
 *    开着程序挂两小时再同步，平均速率被摊薄到接近 0。
 */

const userDataDir = mkdtempSync(join(tmpdir(), 'topensync-speed-'))

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

type SpeedProbe = {
  recordSpeed: (bytes: number) => void
  resetSpeedStats: () => void
}

let Engine: typeof import('../src/main/engine').Engine

beforeAll(async () => {
  Engine = (await import('../src/main/engine')).Engine
})

describe('传输速率统计', () => {
  let engine: InstanceType<typeof Engine>

  beforeEach(() => {
    engine = new Engine({})
  })

  afterEach(() => {
    engine.stop()
  })

  const probe = (e: InstanceType<typeof Engine>): SpeedProbe =>
    e as unknown as SpeedProbe

  it('单个小文件传完就有速率，不需要等满 1 秒窗口', () => {
    // 一次 1 MB 的传输（单次 PUT 就是传完才报一次）
    probe(engine).recordSpeed(1024 * 1024)

    const speed = engine.getStats().speed
    // 关键回归：以前这里全是 0
    expect(speed.current).toBeGreaterThan(0)
    expect(speed.avg).toBeGreaterThan(0)
    expect(speed.totalBytes).toBe(1024 * 1024)
  })

  it('峰值只认可够长的窗口，不被几毫秒的突发刷成天文数字', () => {
    // 窗口才开了不到 250ms，这样的一次性大块不该计入峰值
    probe(engine).recordSpeed(200 * 1024 * 1024)

    const speed = engine.getStats().speed
    expect(speed.current).toBeGreaterThan(0)
    // 峰值保持 0：这不算「线路跑多快」的证据
    expect(speed.max).toBe(0)
    // 当前速率被分母兜底钳住：最多按 100ms 折算，不会出现几十 GB/s
    expect(speed.current).toBeLessThanOrEqual((200 * 1024 * 1024 * 1000) / 100)
  })

  it('平均速率不含空闲时间', async () => {
    probe(engine).recordSpeed(1024 * 1024)
    const first = engine.getStats().speed

    // 模拟挂机：之后没有任何字节进来
    await new Promise((r) => setTimeout(r, 60))

    const later = engine.getStats().speed
    // 平均速率的分母是「有流量的那段时长」，不该被空闲时间摊薄
    expect(later.avg).toBe(first.avg)
    // 空闲超过阈值后，当前速率归零（传输已经停了）
    await new Promise((r) => setTimeout(r, 1600))
    expect(engine.getStats().speed.current).toBe(0)
  })

  it('重置后回到零', () => {
    probe(engine).recordSpeed(1024 * 1024)
    expect(engine.getStats().speed.totalBytes).toBeGreaterThan(0)

    probe(engine).resetSpeedStats()
    const speed = engine.getStats().speed
    expect(speed.current).toBe(0)
    expect(speed.max).toBe(0)
    expect(speed.avg).toBe(0)
    expect(speed.totalBytes).toBe(0)
  })
})
