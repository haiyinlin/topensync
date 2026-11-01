import { describe, expect, it, vi, afterEach } from 'vitest'
import { OpenListClient } from '../src/main/openlist/client'

/**
 * OpenList 客户端的接口契约测试。
 *
 * 这两个断言锁住的是两个真实踩过的坑：
 *   1. per_page: 0 会返回空列表（server/handles/fsread.go:215）
 *   2. refresh: true 需要写权限，否则 403（server/handles/fsread.go:93）
 *
 * 任何人改动列举逻辑时，这个测试会先失败。
 */
describe('OpenListClient.list', () => {
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

  it('必须传足够大的 per_page，不能是 0', async () => {
    const { calls } = stubFetch({ content: [], total: 0, provider: 'QuarkOpen' })
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.list('/quark-backup')

    const body = JSON.parse(String(calls[0].init.body))
    expect(body.per_page).toBeGreaterThan(0)
    // 具体的下限：至少能容纳一个超大目录
    expect(body.per_page).toBeGreaterThanOrEqual(99999)
    expect(body.page).toBe(1)
    expect(body.path).toBe('/quark-backup')
  })

  it('refresh:true 必须被透传（对账依赖它发现远端被外部删除）', async () => {
    const { calls } = stubFetch({ content: [], total: 0, provider: 'QuarkOpen' })
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.list('/quark-backup', { refresh: true })

    const body = JSON.parse(String(calls[0].init.body))
    expect(body.refresh).toBe(true)
  })

  it('refresh 默认为 false（走服务端目录缓存）', async () => {
    const { calls } = stubFetch({ content: [], total: 0, provider: 'QuarkOpen' })
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.list('/quark-backup')

    const body = JSON.parse(String(calls[0].init.body))
    expect(body.refresh).toBe(false)
  })
})

describe('OpenListClient 的凭据过期处理', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  interface Stubbed {
    calls: { url: string; init: RequestInit }[]
    logins: number
    lists: number
  }

  /** 第一次列举返回 401，之后正常；每次登录发一个新 token */
  function stubExpired(listCalls = 1): Stubbed {
    const calls: { url: string; init: RequestInit }[] = []
    let logins = 0
    let lists = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/api/auth/login')) {
        logins++
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 200, data: { token: `token-${logins}` } })
        }
      }
      lists++
      if (lists <= listCalls) {
        return { ok: false, status: 401, text: async () => 'unauthorized' }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ code: 200, data: { content: [], total: 0, provider: 'QuarkOpen' } })
      }
    })
    return {
      calls,
      get logins() {
        return logins
      },
      get lists() {
        return lists
      }
    }
  }

  function authOf(call: { init: RequestInit }): string | undefined {
    return (call.init.headers as Record<string, string>)?.['Authorization']
  }

  it('401 时自动重新登录并用新 token 重试一次', async () => {
    const stub = stubExpired(1)
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.login()
    const res = await client.list('/quark-backup')

    expect(res.content).toEqual([])
    // 一次显式登录 + 一次因 401 触发的重登
    expect(stub.logins).toBe(2)

    const listCalls = stub.calls.filter((c) => c.url.includes('/api/fs/list'))
    expect(listCalls.length).toBe(2)
    // 首次带旧 token，重试必须带新 token
    expect(authOf(listCalls[0])).toBe('token-1')
    expect(authOf(listCalls[1])).toBe('token-2')
  })

  it('持续 401 时只重试一次，不无限递归', async () => {
    const stub = stubExpired(99)
    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    await client.login()
    await expect(client.list('/quark-backup')).rejects.toThrow()

    const listCalls = stub.calls.filter((c) => c.url.includes('/api/fs/list'))
    expect(listCalls.length).toBe(2)
    // 重登只发生一次
    expect(stub.logins).toBe(2)
  })

  it('流式请求体不重放：401 后刷新 token 并抛出，由上层重新发起', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    let logins = 0
    let puts = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/api/auth/login')) {
        logins++
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 200, data: { token: `token-${logins}` } })
        }
      }
      puts++
      return { ok: false, status: 401, text: async () => 'unauthorized' }
    })

    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })
    await client.login()

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      }
    })

    await expect(
      client.putFile('/quark-backup/a.txt', body, {
        size: 3,
        md5: 'm',
        sha1: 's',
        lastModifiedMs: 1730000000000
      })
    ).rejects.toMatchObject({ status: 401 })

    // 流已被消费，不能原地重放：PUT 只发了一次，但 token 已刷新
    expect(puts).toBe(1)
    expect(logins).toBe(2)
  })
})

describe('OpenListClient.putFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('必须同时发送 MD5 与 SHA1 双哈希头，以及 Content-Length', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: {} }) }
    })

    const client = new OpenListClient({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      }
    })

    await client.putFile('/quark-backup/a.txt', body, {
      size: 3,
      md5: 'md5hash',
      sha1: 'sha1hash',
      lastModifiedMs: 1730000000000
    })

    const headers = calls[0].init.headers as Record<string, string>
    expect(calls[0].url).toContain('/api/fs/put')
    expect(calls[0].init.method).toBe('PUT')
    // 缺任一哈希 → 服务端缓存整个文件并失去秒传
    expect(headers['X-File-Md5']).toBe('md5hash')
    expect(headers['X-File-Sha1']).toBe('sha1hash')
    // 缺长度 → 服务端 size=-1，触发整文件落盘
    expect(headers['Content-Length']).toBe('3')
    expect(headers['Last-Modified']).toBe('1730000000000')
    // 刻意不设 As-Task（会强制整文件落盘）
    expect(headers['As-Task']).toBeUndefined()
  })
})
