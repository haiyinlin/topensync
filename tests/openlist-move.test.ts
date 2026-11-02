import { describe, expect, it, vi, afterEach } from 'vitest'
import { OpenListClient } from '../src/main/openlist/client'

/**
 * 远端删除（移入回收站）的可靠性测试。
 *
 * 锁住的是两个真实踩过的坑：
 *
 *   1. **目录被建两遍**
 *      移入回收站会先后两次走到 mkdirp：一次是调用方预建目录，
 *      一次是 move 内部自己建。夸克侧建目录是异步的，等就绪要轮询，
 *      不缓存就白白多花好几秒。
 *
 *   2. **「移动成功」是假的**
 *      OpenList 的 move 返回 200 只表示「已受理」，源文件还在原地；
 *      而服务端目录列表是快照缓存，缓存里可能**仍然留着**源文件，
 *      于是「源还在」会被一直判定为真。
 *      以前 waitForGone 超时后返回 false，而上层把 false 当成成功——
 *      用户看到「已删除」，远端文件却好好躺着。
 *
 *      现在：等不到消失就刷新一次用真实列表判定；仍等不到就**报错**，
 *      绝不静默成功。
 */
describe('OpenListClient 的目录创建', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(response: unknown): { calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 200, data: response })
      }
    })
    return { calls }
  }

  it('同一目录第二次创建时不再重复发请求', async () => {
    // 列表里已经能看到这个目录 → 全程不需要 mkdir
    const { calls } = stubFetch({ content: [{ name: 'x', is_dir: true }], total: 1 })
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.mkdirp('/qh/x')
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await client.mkdirp('/qh/x')
    // 第二次直接命中缓存，连 list 都不该再发
    expect(calls.length).toBe(afterFirst)
  })

  it('不同路径互不影响（缓存按目录逐条记）', async () => {
    const { calls } = stubFetch({ content: [{ name: 'x', is_dir: true }], total: 1 })
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.mkdirp('/qh/x')
    const afterFirst = calls.length
    await client.mkdirp('/qh/x/y')
    // 新的一级要走一次列表
    expect(calls.length).toBeGreaterThan(afterFirst)
  })
})

describe('OpenListClient.waitForGone', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('源文件从列表里消失时返回 true', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ code: 200, data: { content: [{ name: 'other.txt' }], total: 1 } })
    }))
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await expect(client.waitForGone('/qh/a.txt', 2000)).resolves.toBe(true)
  })

  it('缓存里一直留着源文件时，刷新一次后仍找不到就返回 false', async () => {
    const listCalls: { refresh: boolean }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      listCalls.push({ refresh: body.refresh === true })
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ code: 200, data: { content: [{ name: 'a.txt' }], total: 1 } })
      }
    })
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    // refreshAfterMs=0 → 立刻刷新；总超时 1.2 秒 → 判定为「没消失」
    const gone = await client.waitForGone('/qh/a.txt', 1200, { refreshAfterMs: 0 })
    expect(gone).toBe(false)
    // 必须真的刷新过一次，否则就是拿过期缓存做的判定
    expect(listCalls.some((c) => c.refresh)).toBe(true)
  })

  it('父目录都读不到时视为已消失', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 500, message: 'object not found' })
    }))
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await expect(client.waitForGone('/qh/a.txt', 2000)).resolves.toBe(true)
  })
})

describe('OpenListClient.move 的成功判定', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('源文件没消失时报错，不静默当成功', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 200, data: { content: [], total: 0 } })
    }))
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })
    // 源还在原地 → 移动不算完成
    vi.spyOn(client, 'waitForGone').mockResolvedValue(false)
    vi.spyOn(client, 'waitForEntry').mockResolvedValue(true)

    await expect(client.move('/qh/a.txt', '/qh/_trash/stamp/a.txt')).rejects.toThrow(
      /移动后源文件仍在原处/
    )
  })

  it('源文件确实消失时正常返回', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 200, data: { content: [], total: 0 } })
    }))
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })
    vi.spyOn(client, 'waitForGone').mockResolvedValue(true)
    vi.spyOn(client, 'waitForEntry').mockResolvedValue(true)

    await expect(client.move('/qh/a.txt', '/qh/_trash/stamp/a.txt')).resolves.toBeUndefined()
  })
})
