import { describe, expect, it, vi, afterEach } from 'vitest'
import { OpenListClient } from '../src/main/openlist/client'

/**
 * OpenList v4 请求体契约测试。
 *
 * 这组断言锁住的是**实测**（对真实 OpenList 实例逐条跑过）出来的请求格式，
 * 不是从文档抄的。任何一处写错，服务端会返回 400/403/401/404，
 * 而症状往往出现在很远的地方（删不掉文件、重命名静默失败、
 * 大文件分片上传 404、下载一律 401），排查成本很高。
 *
 * 契约来源：
 *   remove  → server/handles/fsmanage.go:369  RemoveReq{Dir string, Names []string}
 *   move    → server/handles/fsmanage.go:59   MoveCopyReq{SrcDir, DstDir, Names}
 *   rename  → server/handles/fsmanage.go:304  RenameReq{Path, Name, Overwrite}
 *   分片    → server/router.go:307             /multipart/*（不在 /api/fs/ 下）
 *   下载    → server/router.go:48              /d/*path 挂 signCheck，缺 sign → 401
 *   get     → server/handles/fsread.go:251     响应字段平铺，没有 meta 嵌套
 */

interface Call {
  url: string
  init: RequestInit
}

/** 简单桩：所有请求都返回同一个 JSON */
function stubJson(response: unknown, status = 200): { calls: Call[] } {
  return stubRoutes({ '*': response }, status)
}

/**
 * 按 URL 片段分派的桩。
 * key 里带 `*` 的按子串匹配，其余按包含匹配；
 * value 可以是固定值，也可以是 (url, init) => 值 的函数。
 */
function stubRoutes(
  routes: Record<string, unknown | ((url: string, init: RequestInit) => unknown)>,
  status = 200,
  contentType = 'application/json'
): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    let payload: unknown = null
    for (const [pattern, value] of Object.entries(routes)) {
      const hit = pattern === '*' ? true : url.includes(pattern)
      if (hit) {
        payload = typeof value === 'function' ? value(url, init) : value
        break
      }
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => JSON.stringify({ code: 200, data: payload })
    }
  })
  return { calls }
}

/** 远端目录列表响应 */
const EMPTY_LIST = { content: [], total: 0, provider: 'Quark' }
/** 远端文件元信息响应（stat 用） */
const FILE_META = { name: 'a.txt', size: 3, is_dir: false, sign: 'SIG' }

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body))
}

function newClient(): OpenListClient {
  return new OpenListClient({
    baseUrl: 'http://127.0.0.1:5244',
    username: 'admin',
    password: 'pw'
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('内网地址绕过系统代理直连', () => {
  it('内网主机走直连 dispatcher（不受 HTTP_PROXY 影响）', async () => {
    // 实机背景：用户机器上装了代理软件（HTTP_PROXY=127.0.0.1:1028），
    // Electron 的 fetch 会跟随系统代理，把内网请求送进代理 → fetch failed。
    // OpenList 通常就在内网，所以内网地址必须显式直连。
    const { calls } = stubJson({})
    const client = new OpenListClient({
      baseUrl: 'http://192.168.100.10:5244',
      username: 'admin',
      password: 'pw'
    })
    await client.list('/qh')

    const init = calls[0].init as RequestInit & { dispatcher?: unknown }
    expect(init.dispatcher, '内网地址必须带直连 dispatcher').toBeTruthy()
  })

  it('公网地址不强制直连（尊重用户的代理设置）', async () => {
    const { calls } = stubJson({})
    const client = new OpenListClient({
      baseUrl: 'https://openlist.example.com',
      username: 'admin',
      password: 'pw'
    })
    await client.list('/')

    const init = calls[0].init as RequestInit & { dispatcher?: unknown }
    expect(init.dispatcher, '公网地址不该被强制直连').toBeUndefined()
  })

  it('内网网段判定覆盖常见私有地址', () => {
    // 判定逻辑在 client.ts 内部，这里通过行为间接验证：
    // 192.168.x 与 10.x 与 localhost 都应当被当作内网
    const cases = ['http://127.0.0.1:5244', 'http://10.0.0.5:5244', 'http://192.168.1.20:5244']
    for (const url of cases) {
      const { calls } = stubJson({})
      const client = new OpenListClient({ baseUrl: url, username: 'a', password: 'b' })
      void client.list('/')
      const init = calls[0].init as RequestInit & { dispatcher?: unknown }
      expect(init.dispatcher, `${url} 应走直连`).toBeTruthy()
    }
  })
})

describe('remove 的请求体：dir 是目录字符串，names 是文件名', () => {
  it('完整路径被拆成「父目录 + 文件名」', async () => {
    const { calls } = stubJson({})
    await newClient().remove(['/qh/a.txt', '/qh/b.txt'])

    expect(calls[0].url).toContain('/api/fs/remove')
    const body = bodyOf(calls[0])
    expect(body.dir).toBe('/qh')
    expect(body.names).toEqual(['a.txt', 'b.txt'])
    // dir 不是布尔——早期实现传 false，服务端直接 400
    expect(body.dir).not.toBe(false)
  })

  it('不同父目录分批提交（服务端只认单个目录）', async () => {
    const { calls } = stubJson({})
    await newClient().remove(['/qh/x/a.txt', '/qh/y/b.txt'])

    expect(calls.length).toBe(2)
    expect(bodyOf(calls[0])).toEqual({ dir: '/qh/x', names: ['a.txt'] })
    expect(bodyOf(calls[1])).toEqual({ dir: '/qh/y', names: ['b.txt'] })
  })

  it('空数组不发请求', async () => {
    const { calls } = stubJson({})
    await newClient().remove([])
    expect(calls.length).toBe(0)
  })
})

describe('move 的请求体：同目录改名走 rename，跨目录走 move', () => {
  it('同目录改名 → POST /api/fs/rename，body 为 {path, name, overwrite}', async () => {
    const { calls } = stubJson({})
    await newClient().move('/qh/old.txt', '/qh/new.txt')

    expect(calls[0].url).toContain('/api/fs/rename')
    expect(calls[0].init.method).toBe('POST')
    expect(bodyOf(calls[0])).toEqual({
      path: '/qh/old.txt',
      name: 'new.txt',
      overwrite: true
    })
  })

  it('跨目录移动 → POST /api/fs/move，body 为 {src_dir, dst_dir, names}', async () => {
    // stat 返回存在的对象，让 move 之后的「等目标就绪」立即通过
    const { calls } = stubRoutes({ '/api/fs/get': FILE_META, '*': EMPTY_LIST })
    await newClient().move('/qh/a.txt', '/trash/stamp/a.txt')

    const moveCall = calls.find((c) => c.url.includes('/api/fs/move'))
    expect(moveCall).toBeDefined()
    expect(bodyOf(moveCall!)).toEqual({
      src_dir: '/qh',
      dst_dir: '/trash/stamp',
      names: ['a.txt']
    })
  })

  it('跨目录移动不会误发 rename', async () => {
    const { calls } = stubRoutes({ '/api/fs/get': FILE_META, '*': EMPTY_LIST })
    await newClient().move('/qh/a.txt', '/trash/a.txt')
    expect(calls.some((c) => c.url.includes('/api/fs/rename'))).toBe(false)
  })

  it('mkdirp 逐级建目录，每级都要等上一级就绪', async () => {
    // 目录建好后才「能被列举」——逼着 mkdirp 逐级等待，不能连着建。
    //
    // 判定用的是「列举目标目录自身」而不是 stat：
    // 实测 stat 对刚建出的目录立即可查（meta 已登记），
    // 但那不代表夸克侧真的能往里写。
    const created = new Set<string>(['/qh'])
    const { calls } = stubRoutes({
      // 列举：目录还没建好时抛错（服务端对不存在的目录就是这么回）
      '/api/fs/list': (_url, init) => {
        const p = JSON.parse(String(init.body)).path as string
        // 远端根下挂着存储挂载点
        if (p === '/') return { content: [{ name: 'qh', size: 0, is_dir: true }] }
        if (created.has(p)) return EMPTY_LIST
        throw new Error('failed get objs: failed get dir: object not found')
      },
      '/api/fs/mkdir': (_url, init) => {
        created.add(JSON.parse(String(init.body)).path as string)
        return {}
      },
      '*': EMPTY_LIST
    })
    await newClient().mkdirp('/qh/a/b/c')

    const mkdirs = calls.filter((c) => c.url.includes('/api/fs/mkdir'))
    expect(mkdirs.map((c) => bodyOf(c).path)).toEqual(['/qh/a', '/qh/a/b', '/qh/a/b/c'])
  })

  it('mkdirp 判就绪时不会刷新父目录（刷新会抹掉刚上传的兄弟文件）', async () => {
    // 实测：目录列表是快照缓存，refresh:true 会用夸克侧当时的真实列表
    // 整体替换缓存。文件还没在夸克落盘时（PUT 返回 200 只表示 OpenList
    // 收下了字节流），它会被这次刷新从缓存里抹掉，之后连 Get 都读不到。
    //
    // 对同步程序的危害：刚上传成功的文件被误判成「不存在」，
    // 校验失败 → 反复重传。所以建目录时只能读缓存，不能刷新。
    const created = new Set<string>(['/qh'])
    const { calls } = stubRoutes({
      '/api/fs/list': (_url, init) => {
        const p = JSON.parse(String(init.body)).path as string
        const body = JSON.parse(String(init.body))
        if (body.refresh === true) {
          throw new Error('refresh 不该出现在建目录链路上')
        }
        if (created.has(p)) return EMPTY_LIST
        throw new Error('failed get objs: failed get dir: object not found')
      },
      '/api/fs/mkdir': (_url, init) => {
        created.add(JSON.parse(String(init.body)).path as string)
        return {}
      },
      '*': EMPTY_LIST
    })
    await newClient().mkdirp('/qh/x/y')

    const refreshCalls = calls.filter(
      (c) => c.url.includes('/api/fs/list') && bodyOf(c).refresh === true
    )
    expect(refreshCalls, '建目录链路不得刷新任何目录').toHaveLength(0)
  })
})

describe('分片上传端点挂在 /multipart 下，不在 /api/fs 下', () => {
  it('init / chunk / complete / status / abort 都用 /multipart/*', async () => {
    const { calls } = stubJson({ upload_id: 'u1', parts: [] })
    const client = newClient()

    await client.multipartInit('/qh/big.bin', {
      size: 10,
      md5: 'm',
      sha1: 's',
      lastModifiedMs: 1
    })
    await client.multipartChunk(
      'u1',
      0,
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]))
          c.close()
        }
      })
    )
    await client.multipartStatus('u1')
    await client.multipartComplete('u1')
    await client.multipartAbort('u1')

    const urls = calls.map((c) => c.url)
    expect(urls.some((u) => u.includes('/api/fs/multipart'))).toBe(false)
    expect(urls.some((u) => u.includes('/multipart/init'))).toBe(true)
    expect(urls.some((u) => u.includes('/multipart/chunk'))).toBe(true)
    expect(urls.some((u) => u.includes('/multipart/complete'))).toBe(true)
    expect(urls.some((u) => u.includes('/multipart/status'))).toBe(true)
    expect(urls.some((u) => u.includes('/multipart/abort'))).toBe(true)
  })
})

describe('list 的响应归一化', () => {
  it('把 OpenList 的 snake_case 字段映射成内部结构', async () => {
    stubJson({
      content: [
        {
          name: 'dir',
          size: 0,
          is_dir: true,
          modified: '2026-11-01T00:00:00Z',
          sign: 'sig-dir',
          hash_info: null
        },
        {
          name: 'a.txt',
          size: 12,
          is_dir: false,
          modified: '2026-11-01T00:00:00Z',
          sign: 'sig-a',
          hash_info: { MD5: 'abc', 'SHA-1': 'def' }
        }
      ],
      total: 2,
      provider: 'Quark'
    })

    const res = await newClient().list('/qh')

    expect(res.provider).toBe('Quark')
    expect(res.total).toBe(2)
    expect(res.content[0].isDir).toBe(true)
    expect(res.content[1].isDir).toBe(false)
    expect(res.content[1].size).toBe(12)
    expect(res.content[1].sign).toBe('sig-a')
    // hash_info 的值在真实响应里是字符串
    expect(res.content[1].hashInfo).toEqual({ MD5: 'abc', 'SHA-1': 'def' })
    // hash_info 为 null 时不应留下空对象
    expect(res.content[0].hashInfo).toBeUndefined()
  })
})

describe('stat 读取平铺响应', () => {
  it('data 里没有 meta 嵌套层，字段是平铺的', async () => {
    stubJson({
      name: 'a.txt',
      size: 41,
      is_dir: false,
      modified: '2026-11-01T00:00:00Z',
      sign: 'sig-a',
      hash_info: null,
      raw_url: 'http://x/p/qh/a.txt?sign=sig-a'
    })

    const obj = await newClient().stat('/qh/a.txt')

    expect(obj).not.toBeNull()
    expect(obj!.size).toBe(41)
    expect(obj!.isDir).toBe(false)
    expect(obj!.sign).toBe('sig-a')
    expect(obj!.rawUrl).toBe('http://x/p/qh/a.txt?sign=sig-a')
  })
})

describe('下载必须带 sign', () => {
  it('hashRemote 在 URL 上附加 sign 查询参数', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      // 先 stat 拿 sign，再下载
      if (url.includes('/api/fs/get')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              code: 200,
              data: { name: 'a.txt', size: 3, is_dir: false, sign: 'SIG123' }
            })
        }
      }
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let done = false
            return {
              read: async () => {
                if (done) return { done: true }
                done = true
                return { done: false, value: new Uint8Array([97, 98, 99]) }
              }
            }
          }
        },
        text: async () => ''
      }
    })

    const res = await newClient().hashRemote('/qh/a.txt')

    const downloadUrl = urls.find((u) => u.includes('/d/qh/a.txt'))
    expect(downloadUrl).toBeDefined()
    expect(downloadUrl).toContain('sign=SIG123')
    expect(res).not.toBeNull()
    expect(res!.size).toBe(3)
  })

  it('下载前实时 stat 取签名，不信任 list 缓存里的旧签名', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      // 先列一次目录，缓存里会带上一个**陈旧**签名
      if (url.includes('/api/fs/list')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              code: 200,
              data: {
                content: [{ name: 'a.txt', size: 3, is_dir: false, sign: 'STALE' }],
                total: 1,
                provider: 'Quark'
              }
            })
        }
      }
      if (url.includes('/api/fs/get')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              code: 200,
              data: { name: 'a.txt', size: 3, is_dir: false, sign: 'FRESH' }
            })
        }
      }
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let done = false
            return {
              read: async () => {
                if (done) return { done: true }
                done = true
                return { done: false, value: new Uint8Array([97]) }
              }
            }
          }
        },
        text: async () => ''
      }
    })

    const client = newClient()
    await client.list('/qh')
    await client.hashRemote('/qh/a.txt')

    const downloadUrl = urls.find((u) => u.includes('/d/qh/a.txt'))
    expect(downloadUrl).toContain('sign=FRESH')
    expect(downloadUrl).not.toContain('STALE')
  })
})

describe('改配置必须原地生效（不能只换引用）', () => {
  // 实机背景：用户在界面上改了 OpenList 连接信息，
  // 引擎把 this.client 换成了新实例，而 Planner / Transfer 仍握着旧引用。
  // 结果是「连接检查显示正常（用新地址），上传却打到了旧地址」——
  // 实机表现为一律 connect ECONNREFUSED 127.0.0.1:5244（默认值）。
  it('reconfigure 之后请求打向新地址', async () => {
    const { calls } = stubJson({})
    const client = newClient()

    client.reconfigure({
      baseUrl: 'http://192.168.100.10:5244',
      username: 'admin',
      password: 'pw'
    })
    await client.list('/qh')

    expect(calls[0].url).toContain('192.168.100.10:5244')
    expect(calls[0].url).not.toContain('127.0.0.1')
  })

  it('reconfigure 之后 endpoint 反映新地址', () => {
    const client = newClient()
    expect(client.endpoint).toBe('http://127.0.0.1:5244')
    client.reconfigure({
      baseUrl: 'http://192.168.100.10:5244/',
      username: 'admin',
      password: 'pw'
    })
    // 末尾斜杠要归一化
    expect(client.endpoint).toBe('http://192.168.100.10:5244')
  })

  it('配置没变时不作废已登录的 token', async () => {
    const { calls } = stubJson({ token: 'T' })
    const client = newClient()
    await client.login()
    const before = calls.length

    client.reconfigure({
      baseUrl: 'http://127.0.0.1:5244',
      username: 'admin',
      password: 'pw'
    })
    await client.list('/qh')

    // 没有重新登录，说明 token 被保留
    expect(calls.length).toBe(before + 1)
    const auth = calls[before].init.headers as Record<string, string>
    expect(auth['Authorization']).toBe('T')
  })

  it('换了服务端必须重新登录（旧 token 不再有效）', async () => {
    const { calls } = stubJson({ token: 'T' })
    const client = newClient()
    await client.login()

    client.reconfigure({
      baseUrl: 'http://192.168.100.10:5244',
      username: 'admin',
      password: 'pw'
    })
    await client.list('/qh')

    // 没有 Authorization 头 → 说明 token 已被清空，需要重新登录
    const auth = calls[1].init.headers as Record<string, string>
    expect(auth['Authorization']).toBeUndefined()
  })
})
