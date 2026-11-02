import { open, rm, rename, copyFile } from 'fs/promises'
import { createHash } from 'crypto'

/**
 * OpenList REST 客户端。
 *
 * 全部接口行为已对照 OpenList v4 源码 + 真实实例实测核实。
 * 下面几条是实测得出、违反直觉的硬约束，改动前务必重读：
 *
 * 1. 上传是 `PUT /api/fs/put`，**不是 POST**（server/router.go:304）。
 * 2. `per_page` 会被 `PageReq.Validate()` 修正：`per_page < 1` 一律改成
 *    `MaxInt`（取全量），**不是返回空数组**（internal/model/req.go:17）。
 *    实测 per_page=0 返回全量，与纸面推断相反。
 * 3. `refresh: true` 需要目标目录的写权限，否则返回 403
 *    （server/handles/fsread.go:97）。远端对账依赖它来发现外部删除。
 * 4. `POST /api/fs/remove` 的请求体是 `{dir: 目录, names: [文件名]}`——
 *    **dir 是目录字符串不是布尔**，names 里放的是文件名而不是完整路径
 *    （server/handles/fsmanage.go:369）。
 * 5. `POST /api/fs/move` 的请求体是 `{src_dir, dst_dir, names: [文件名]}`，
 *    同目录改名要用 `POST /api/fs/rename` `{path, name, overwrite}`
 *    （server/handles/fsmanage.go:59 / :304）。
 * 6. 分片上传的端点是 `/multipart/*`，**不在 `/api/fs/` 下**
 *    （server/router.go:307）。
 * 7. 下载走 `GET /d/<path>` 时必须带 `?sign=`，否则 401。
 *    路由挂了 `signCheck` 中间件（server/router.go:48），
 *    签名取自 list / get 响应里的 `sign` 字段。
 * 8. `POST /api/fs/get` 的响应字段是**平铺**的（name/size/is_dir/sign…），
 *    没有 `meta` 嵌套层（server/handles/fsread.go:251）。
 * 9. **落盘是异步的**：PUT 返回 200 只表示 OpenList 收下了字节流，
 *    夸克侧要再过约 1 秒才可见。这段窗口里 GET 返回「不存在」。
 *    → 判定存在性必须用「等待可见」（statWhenVisible），不能查一次就下结论。
 * 10. **目录列表是快照缓存，`refresh: true` 会整体替换它**：
 *    若某文件还没在夸克落盘，它会被这次刷新从缓存里抹掉，
 *    之后连 Get 都读不到，直到下一次 refresh 才找得回来。
 *    → 建目录/查目录一律不刷新；判定「远端缺失」必须刷新后复核。
 */

export interface OpenListClientOptions {
  baseUrl: string
  username: string
  password: string
  /** 单次请求超时（毫秒） */
  timeoutMs?: number
}

/** 客户端内部统一使用的远端对象（已从 OpenList 的 snake_case 归一化） */
export interface RemoteObject {
  name: string
  size: number
  modified: string
  isDir: boolean
  /** 下载鉴权签名；`GET /d` 必带 */
  sign?: string
  /** 驱动返回的远端哈希；夸克驱动通常为空 */
  hashInfo?: Record<string, string>
  /** 服务端给出的直链（自带 sign） */
  rawUrl?: string
}

export interface ListResult {
  content: RemoteObject[]
  total: number
  provider: string
}

/** OpenList v4 原始对象（字段名为 snake_case） */
interface RawObj {
  name: string
  size: number
  is_dir?: boolean
  modified?: string
  created?: string
  sign?: string
  thumb?: string
  type?: number
  hashinfo?: string
  hash_info?: Record<string, string> | null
  raw_url?: string
}

/** OpenList 原始对象 → 客户端内部结构 */
function toRemoteObject(raw: RawObj): RemoteObject {
  return {
    name: raw.name,
    size: raw.size ?? 0,
    modified: raw.modified ?? '',
    isDir: raw.is_dir === true,
    sign: raw.sign || undefined,
    hashInfo: raw.hash_info ?? undefined,
    rawUrl: raw.raw_url || undefined
  }
}

/** 远端路径的父目录；根路径归一为 '/' */
function remoteDirname(path: string): string {
  const i = path.lastIndexOf('/')
  if (i < 0) return '/'
  if (i === 0) return '/'
  return path.slice(0, i)
}

/** 远端路径的文件名 */
function remoteBasename(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 把错误及其 `cause` 链展开成可读文本。
 *
 * 为什么需要：Node/undici 的 fetch 在网络层出错时抛的 `TypeError: fetch failed`
 * 本身**不含任何原因**，真正的原因在 `err.cause` 里
 * （`ECONNRESET` / `UND_ERR_SOCKET` / `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` …）。
 * 只把 `err.message` 抛给用户，排查时等于两眼一黑。
 */
export function describeError(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  let depth = 0

  while (current && depth < 5) {
    const message = current instanceof Error ? current.message : String(current)
    const code = (current as { code?: unknown }).code
    parts.push(typeof code === 'string' && !message.includes(code) ? `${message} (${code})` : message)
    current = (current as { cause?: unknown }).cause
    depth++
  }

  return parts.join(' ← ')
}

/**
 * 判断错误是否表示「远端对象不存在」。
 */
function isNotFound(err: unknown): boolean {
  if (!(err instanceof OpenListError)) return false
  if (err.status === 404) return true
  const msg = (err.message ?? '').toLowerCase()
  return msg.includes('object not found') || msg.includes('not found')
}

/**
 * 判断错误是否表示「远端有个同名文件正在下载中，不允许覆盖」。
 *
 * 实测 OpenList 在这种情况下会拒绝 PUT，报
 * `file is doloading[存在同名文件]`（服务端把 downloading 拼错了）。
 *
 * 触发场景：远端已存在同名文件，而它此刻正被别的客户端下载
 * （用户在网页端点下载、或另一个程序在拉文件）。
 * 覆盖被拒 → 上传失败 → 重试也没用，重试三次都是同一个错。
 *
 * 遇到它要先把远端那个同名文件删掉，再重传。
 */
export function isSameNameDownloading(err: unknown): boolean {
  const msg = describeError(err).toLowerCase()
  return msg.includes('doloading') || msg.includes('存在同名文件')
}

/** 夸克单文件 20GB，分片接口建议值 */
const DEFAULT_LIST_PAGE_SIZE = 99999
const DEFAULT_TIMEOUT_MS = 60_000
/**
 * 等待文件可见时，刷新父目录的最小间隔（毫秒）。
 *
 * 实测上传后文件要过约 1~3 秒才进 OpenList 的目录缓存，
 * 期间 stat 一直返回「不存在」。刷新是逼缓存更新的唯一手段，
 * 但刷得太勤会白跑夸克接口（限速按账号共享），故设下限。
 */
const REFRESH_INTERVAL_MS = 1_200

/**
 * 判断一个 URL 是否指向内网地址。
 *
 * 为什么要判：OpenList 通常部署在**内网**（NAS、局域网服务器）。
 * 若用户机器上装了代理软件（公司 VPN、Clash、Shadowrocket 等），
 * 系统代理会把内网请求也送进代理——代理通常无法路由到内网，
 * 于是表现为「连不上」「fetch failed」，而地址明明是对的。
 *
 * 内网地址应当**绕过代理直连**。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()

  // localhost 与回环
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true

  // 私有网段
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    return false
  }

  // 常见内网域名
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true

  return false
}

/**
 * 直连用的 fetch 包装：内网地址强制不走系统代理。
 *
 * Node 内置 fetch（undici）默认**不读**代理环境变量，
 * 但 Electron 主进程里的 fetch 会跟随系统代理设置。
 * 所以这里显式指定一个不经过代理的 dispatcher。
 *
 * 实现方式：给 fetch 传入 `dispatcher` 选项，
 * 由 undici 的 Agent 直接建连，不做任何代理协商。
 */
let directAgent: unknown = null

function directFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require('undici') as { Agent: new (opts: unknown) => unknown }
    if (!directAgent) {
      directAgent = new undici.Agent({ connect: { timeout: 30_000 } })
    }
    // Node 的 RequestInit 已经声明了 dispatcher（类型来自内置 undici），
    // 这里要塞的是外部 undici 包的 Agent，两者类型不兼容但运行时兼容。
    return fetch(input, { ...init, dispatcher: directAgent } as unknown as RequestInit)
  } catch {
    /* 没有 undici 就用默认行为 */
    return fetch(input, init)
  }
}

/**
 * 按目标地址选择 fetch 方式。
 *
 * 内网地址走直连（绕开系统代理），其余走默认 fetch。
 */
function fetchFor(url: string, init: RequestInit): Promise<Response> {
  try {
    const host = new URL(url).hostname
    if (isPrivateHost(host)) return directFetch(url, init)
  } catch {
    /* URL 解析失败就按默认处理 */
  }
  return fetch(url, init)
}

export class OpenListError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'OpenListError'
  }
}

export class OpenListClient {
  private token = ''
  /** 正在执行登录，防止 401 触发的自动重登递归 */
  private authenticating = false
  /** 已经确认建好的远端目录，避免重复 mkdir 与重复等待就绪 */
  private readonly knownDirs = new Set<string>()
  /**
   * 正在进行的重新登录。
   *
   * 并发请求可能同时收到 401，用同一个 Promise 去重，
   * 避免几十个并发请求各自打一次登录接口。
   */
  private reauthInFlight: Promise<void> | null = null
  private baseUrl: string
  private username: string
  private password: string
  private timeoutMs: number

  constructor(opts: OpenListClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.username = opts.username
    this.password = opts.password
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 原地改配置。
   *
   * 为什么是「原地改」而不是「新建一个实例」：
   * Planner / Transfer / Reconciler 都在构造时拿到了 client 的引用。
   * 若换配置时新建实例，这些持有者就会继续用**旧地址**发请求——
   * 表现是「连接检查显示正常（用的是新 client），但上传打到了旧服务器」。
   * 全应用共用一个实例 + 原地改配置，从根上消除这类不一致。
   */
  reconfigure(opts: OpenListClientOptions): void {
    const nextBaseUrl = opts.baseUrl.replace(/\/+$/, '')
    const unchanged =
      nextBaseUrl === this.baseUrl &&
      opts.username === this.username &&
      opts.password === this.password

    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs

    // 配置没变就别动 token：清掉它会让在途请求无端 401
    if (unchanged) return

    this.baseUrl = nextBaseUrl
    this.username = opts.username
    this.password = opts.password
    // 换了服务端，旧 token 不再有效
    this.token = ''
    // 分片支持情况是「这台服务器」的属性，换了服务器必须重新探测
    this.multipartSupported = null
  }

  /** 当前配置（供诊断与日志使用） */
  get endpoint(): string {
    return this.baseUrl
  }

  // ── 认证 ─────────────────────────────────────────────
  /** 登录换取 JWT。token 有效期约 48h，过期需重新登录。 */
  async login(): Promise<void> {
    this.authenticating = true
    const previousToken = this.token
    this.token = ''
    try {
      const res = await this.request<{ token: string }>('POST', '/api/auth/login', {
        body: { username: this.username, password: this.password },
        allowAuthRetry: false
      })
      this.token = res.token
    } catch (err) {
      // 登录失败时恢复旧 token，让后续重试仍有机会用未过期的凭据
      this.token = previousToken
      throw err
    } finally {
      this.authenticating = false
    }
  }

  /**
   * 凭据过期后重新登录，并发调用共享同一次登录。
   */
  private reauth(): Promise<void> {
    if (!this.reauthInFlight) {
      this.reauthInFlight = this.login().finally(() => {
        this.reauthInFlight = null
      })
    }
    return this.reauthInFlight
  }

  // ── 上传 ─────────────────────────────────────────────
  /**
   * 单次流式上传。
   *
   * 必带头：
   * - Authorization
   * - File-Path（URL 编码的完整远端路径）
   * - Content-Length（缺失会导致服务端 size=-1 → 整文件落盘缓存）
   * - X-File-Md5 + X-File-Sha1（缺任一个 → 服务端缓存整个文件并失去秒传）
   * - Last-Modified（毫秒时间戳，保证 OpenList 中显示的修改时间正确）
   *
   * 刻意不设 As-Task：那会强制服务端把整文件先落盘到临时目录。
   */
  async putFile(
    remotePath: string,
    body: ReadableStream<Uint8Array>,
    opts: {
      size: number
      md5: string
      sha1: string
      lastModifiedMs: number
      overwrite?: boolean
      signal?: AbortSignal
      /**
       * 流式进度回调（累计已发送字节数）。
       *
       * 单次 PUT 的大文件（服务端不支持分片时，几百 MB 也只能走这一条路）
       * 整段传输可能持续几十秒到几分钟。没有这个回调，上层就只能在
       * 传输**结束**后才知道发生了多少流量——期间速率显示一直是 0，
       * 用户看到的就是「正在上传却显示 0 B/s」。
       */
      onProgress?: (sent: number) => void
    }
  ): Promise<void> {
    // 包一层字节计数：每读出一块就上报累计发送字节，让单次 PUT 也有实时速率
    let sent = 0
    const counted = opts.onProgress
      ? body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              sent += chunk.byteLength
              controller.enqueue(chunk)
              opts.onProgress?.(sent)
            }
          })
        )
      : body

    await this.request('PUT', '/api/fs/put', {
      headers: {
        'File-Path': encodeURI(remotePath),
        'Content-Length': String(opts.size),
        'X-File-Md5': opts.md5,
        'X-File-Sha1': opts.sha1,
        'Last-Modified': String(opts.lastModifiedMs),
        'Content-Type': 'application/octet-stream',
        Overwrite: opts.overwrite === false ? 'false' : 'true'
      },
      body: counted,
      signal: opts.signal,
      timeoutMs: Math.max(this.timeoutMs, opts.size / (1024 * 1024) * 1000 * 60)
    })
  }

  // ── 分片上传 ───────────────────────────────────────────
  /**
   * 服务端是否支持 multipart 分片上传。
   *
   * 实测发现：**不是所有 OpenList 构建都有 /multipart 路由**。
   * 用户实例（dev 版）请求 /multipart/init 会落到前端 SPA 的 index.html 上
   * —— HTTP 200 + text/html，看起来"成功"实则根本没有这个路由。
   * 这类服务端只能用单次 PUT 传大文件（实测 12MB 单次 PUT 正常落地）。
   *
   * 所以这里用 GET /multipart/status 探测：路由存在时返回 JSON，
   * 不存在时返回 HTML 兜底页。
   */
  private multipartSupported: boolean | null = null

  async probeMultipart(): Promise<boolean> {
    if (this.multipartSupported !== null) return this.multipartSupported

    try {
      const res = await fetchFor(`${this.baseUrl}/multipart/status?upload_id=probe`, {
        method: 'GET',
        headers: this.token ? { Authorization: this.token } : {}
      })
      const contentType = res.headers.get('content-type') ?? ''
      // 落到 SPA 兜底页说明没有这个路由
      this.multipartSupported = contentType.includes('json')
    } catch {
      this.multipartSupported = false
    }
    return this.multipartSupported
  }

  async multipartInit(
    remotePath: string,
    opts: {
      size: number
      md5: string
      sha1: string
      lastModifiedMs: number
      chunkSize?: number
      overwrite?: boolean
    }
  ): Promise<{ upload_id: string; resumed: boolean }> {
    const headers: Record<string, string> = {
      'File-Path': encodeURI(remotePath),
      'X-File-Size': String(opts.size),
      'X-File-Md5': opts.md5,
      'X-File-Sha1': opts.sha1,
      'Last-Modified': String(opts.lastModifiedMs),
      Overwrite: opts.overwrite === false ? 'false' : 'true'
    }
    // 服务端 chunk 上限为管理设置 MultipartChunkSize（默认 10MB），
    // 客户端只能更小不能更大，下限 1MB。不传则用服务端默认值。
    if (opts.chunkSize) headers['X-Chunk-Size'] = String(opts.chunkSize)

    // 服务端没有 multipart 路由时，这里会静默拿到 SPA 的 HTML，
    // 必须先探测并明确报错，否则调用方会把 HTML 当成响应解析。
    if (!(await this.probeMultipart())) {
      throw new OpenListError(
        '服务端不支持 multipart 分片上传（缺少 /multipart 路由），请改用单次 PUT',
        501
      )
    }

    return this.request('POST', '/multipart/init', { headers })
  }

  /**
   * 上传单个分片。
   * - 429：服务端接收窗口已满，需退避后重试
   * - 409：同一分片正在传输中，需等待后用 status 确认
   */
  async multipartChunk(
    uploadId: string,
    chunkIndex: number,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.request('PUT', '/multipart/chunk', {
      headers: {
        'X-Upload-Id': uploadId,
        'X-Chunk-Index': String(chunkIndex)
      },
      body,
      signal
    })
  }

  /** 查询已接收分片，用于断点续传 */
  async multipartStatus(uploadId: string): Promise<{ parts: number[] }> {
    return this.request('GET', `/multipart/status?upload_id=${encodeURIComponent(uploadId)}`)
  }

  async multipartComplete(uploadId: string): Promise<void> {
    await this.request('POST', '/multipart/complete', {
      headers: { 'X-Upload-Id': uploadId }
    })
  }

  async multipartAbort(uploadId: string): Promise<void> {
    await this.request('POST', '/multipart/abort', {
      headers: { 'X-Upload-Id': uploadId }
    })
  }

  // ── 目录与元数据 ─────────────────────────────────────
  /**
   * 列举目录。
   *
   * @param refresh true 表示穿透服务端目录缓存。远端对账**必须**为 true，
   *   否则读到的是缓存快照，发现不了"远端被外部删除"。
   *   注意 true 需要目标目录写权限，否则 403。
   */
  async list(
    path: string,
    opts: { refresh?: boolean; signal?: AbortSignal } = {}
  ): Promise<ListResult> {
    const data = await this.request<{
      content?: RawObj[]
      total?: number
      provider?: string
    }>('POST', '/api/fs/list', {
      body: {
        path,
        password: '',
        page: 1,
        // 实测 per_page < 1 会被服务端改成 MaxInt（即取全量），
        // 但传一个足够大的值意图更明确，且不受服务端默认值影响。
        per_page: DEFAULT_LIST_PAGE_SIZE,
        refresh: opts.refresh ?? false
      },
      signal: opts.signal
    })

    const content = (data?.content ?? []).map(toRemoteObject)

    return {
      content,
      total: data?.total ?? content.length,
      provider: data?.provider ?? 'unknown'
    }
  }

  /**
   * 批量删除。
   *
   * OpenList 的 RemoveReq 是 `{dir: 目录, names: [文件名]}`——
   * dir 是**目录字符串**，names 里放的是**文件名**而非完整路径。
   * 这里按父目录分组后逐目录提交，调用方仍可传完整路径数组。
   *
   * 注意：**目录必须为空**。OpenList 不会递归删除，
   * 目录非空时会报错。递归删除请用 removeTree。
   */
  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return

    const groups = new Map<string, string[]>()
    for (const path of paths) {
      const dir = remoteDirname(path)
      const name = remoteBasename(path)
      const bucket = groups.get(dir)
      if (bucket) bucket.push(name)
      else groups.set(dir, [name])
    }

    for (const [dir, names] of groups) {
      await this.request('POST', '/api/fs/remove', { body: { dir, names } })
    }
  }

  /**
   * 递归删除一个目录及其全部内容。
   *
   * OpenList 的 remove 端点**不做递归**：目录非空时会报错。
   * 所以要删整棵树，得先自底向上清空叶子。
   *
   * 用途：测试清理、回收站清理。
   * 生产代码里的「移入回收站」用的是 move（不删数据），不用这个。
   */
  async removeTree(path: string): Promise<void> {
    const children = await this.list(path).catch(() => null)
    if (!children) {
      // 目录不存在或列举失败 → 直接删这一层
      await this.remove([path]).catch(() => undefined)
      return
    }

    for (const child of children.content) {
      const childPath = `${path}/${child.name}`
      if (child.isDir) {
        await this.removeTree(childPath)
      } else {
        await this.remove([childPath]).catch(() => undefined)
      }
    }

    // 内容清空后再删目录本身
    await this.remove([path]).catch(() => undefined)
  }

  /**
   * 取单个远端对象的元信息。
   *
   * 用于上传后的校验：比对远端实际大小与哈希。
   * 响应字段是**平铺**的（name/size/is_dir/sign/…），没有 `meta` 嵌套层。
   * 远端不存在时返回 null（不是抛错）——「不存在」是正常状态而非异常。
   */
  async stat(remotePath: string): Promise<RemoteObject | null> {
    try {
      const res = await this.request<RawObj>('POST', '/api/fs/get', {
        body: { path: remotePath, password: '' }
      })
      if (!res || !res.name) return null
      return toRemoteObject(res)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  /**
   * 下载远端文件并流式计算哈希。
   *
   * 用于「深度校验」：夸克驱动不给远端哈希时，
   * 只有把文件拉回来重算才能确认内容一致。
   * 流量成本与文件大小成正比，因此调用方要限制体积。
   */
  async hashRemote(
    remotePath: string,
    sign?: string
  ): Promise<{ md5: string; sha1: string; size: number } | null> {
    const url = await this.downloadUrl(remotePath, sign)
    const headers: Record<string, string> = {
      ...(this.token ? { Authorization: this.token } : {})
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetchFor(url, { headers, signal: controller.signal })
      if (!res.ok || !res.body) return null

      const md5 = createHash('md5')
      const sha1 = createHash('sha1')
      let bytes = 0

      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytes += value.byteLength
          md5.update(value)
          sha1.update(value)
        }
      }

      return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), size: bytes }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 拼下载 URL，必要时带上 `?sign=`。
   *
   * 签名实时向服务端取（stat 一次），不用 list 缓存里的：
   * 目录缓存会滞后，里面可能还留着已删除条目的陈旧签名，用它下载会 401。
   *
   * 拿不到签名不报错——有些部署不启用签名校验，那种情况下直接访问即可。
   */
  private async downloadUrl(remotePath: string, sign?: string): Promise<string> {
    let resolved = sign
    if (!resolved) {
      try {
        // 等待可见：刚上传的文件在落盘窗口内 stat 查不到，
        // 那时既拿不到签名，下载也必然失败。
        const meta = await this.statWhenVisible(remotePath, 10_000)
        resolved = meta?.sign
      } catch {
        /* 拿不到签名就按无签名访问 */
      }
    }
    const base = `${this.baseUrl}/d${encodeURI(remotePath)}`
    return resolved ? `${base}?sign=${encodeURIComponent(resolved)}` : base
  }

  async mkdir(path: string): Promise<void> {
    await this.request('POST', '/api/fs/mkdir', { body: { path } })
  }

  /**
   * 递归建目录。
   *
   * OpenList 的 mkdir 不会自动建父目录，移到回收站这类操作
   * 需要先确保目标目录存在。
   *
   * 实测：**夸克驱动建目录是异步的**。接口返回 200 时目录还没在远端就绪，
   * 必须等它**能被列举**了，才能把它当作下一级的父目录。
   * 不等就绪就连着建下一级，后续上传/移动会静默落空
   *（接口照样返回成功，但东西没进去）。
   *
   * 判定不能用 stat：刚建出来的目录 stat 立即可查（meta 已登记），
   * 但那不代表远端侧真的能往里写。
   *
   * ⚠️ 判定也**不能刷新父目录**：见 dirHasEntry 的说明——
   * 刷新父目录会把还没在夸克落盘的兄弟文件从缓存里抹掉。
   * 所以这里列举的是**目标目录自身**：能列举成功即代表夸克侧已就绪。
   */
  async mkdirp(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      /*
       * 已经确认建好的目录直接跳过。
       *
       * 为什么需要这一层：移入回收站会先后两次走到这里——
       * 一次是调用方预建目录，一次是 move 内部自己建。
       * 没有缓存的话，第二轮会把整条链再列一遍、再等一遍就绪，
       * 白白多花好几秒（夸克侧建目录是异步的，等就绪要轮询）。
       */
      if (this.knownDirs.has(current)) continue
      const parent = remoteDirname(current)
      const name = remoteBasename(current)
      // 缓存里已经能看到 → 目录早就建好了，直接跳过
      if (await this.dirHasEntry(parent, name)) {
        this.knownDirs.add(current)
        continue
      }
      try {
        await this.mkdir(current)
      } catch {
        // 已存在或无权创建时忽略：目录可能已由别的文件建好
      }
      // 等它「能被列举」——列举成功代表夸克侧真的建好了
      await this.waitForDirReady(current)
      this.knownDirs.add(current)
    }
  }

  /**
   * 父目录里是否出现了这个名字。
   *
   * ⚠️ 这里**故意不用 refresh:true**。
   *
   * 实测（OpenList v4 + 夸克驱动）：目录列表是**快照缓存**，
   * `refresh:true` 会用夸克侧当时的真实列表整体替换缓存。
   * 若此时有文件还没在夸克落盘（PUT 返回 200 只表示 OpenList 收下了
   * 字节流，夸克侧要再过约 1 秒才可见），它就会被这次刷新
   * 从缓存里**抹掉**——之后连 `Get` 都读不到它，
   * 直到下一次 refresh 才找得回来。
   *
   * 实测复现：PUT 后立刻 refresh 父目录 → 列表为空、stat 返回 null；
   * 3 秒后再 refresh → 文件回来了。
   *
   * 这个坑对同步程序是致命的：刚上传完的文件若被误判为「不存在」，
   * 校验会判失败、上传会被反复重试。
   *
   * 因此这里只读**服务端缓存**（不刷新）：
   * 缓存滞后最多导致「目录还没建好也去建一次」（mkdir 幂等，无害），
   * 而不会误删别人的缓存条目。
   */
  private async dirHasEntry(dir: string, name: string): Promise<boolean> {
    try {
      const res = await this.list(dir)
      return res.content.some((c) => c.name === name)
    } catch {
      // 父目录本身不存在 → 名字肯定也不存在
      return false
    }
  }

  /**
   * 等目录「能被列举」——夸克侧真正建好的标志。
   *
   * 列举不存在的目录会抛 "failed get dir: object not found"，
   * 所以列举成功就是最可靠的就绪判据，且**不碰任何缓存**
   * （刷新父目录会误伤兄弟文件，见 dirHasEntry）。
   */
  private async waitForDirReady(path: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.dirReady(path)) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  /**
   * 目录是否已经「能被列举」——即夸克侧真的建好了。
   *
   * 列举一个不存在的目录会抛 "failed get dir: object not found"，
   * 所以「列举成功」就是最可靠的就绪判据，且**不碰任何缓存**。
   */
  async dirReady(path: string): Promise<boolean> {
    try {
      await this.list(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * 远端某一级是否已存在。
   *
   * 用 stat（/api/fs/get）而不是 list：list 读的是服务端目录缓存，
   * 会滞后，且可能还留着已删除条目的陈旧记录；stat 是实时的。
   * 实测刚建好的目录 stat 立即可查。
   */
  private async entryExists(remotePath: string): Promise<boolean> {
    try {
      return (await this.stat(remotePath)) !== null
    } catch {
      return false
    }
  }

  /**
   * 等待远端路径出现。
   *
   * 用于跨越「服务端受理但异步落盘」的边界。
   * 判定用「父目录列表里出现该名字」而不是 stat——
   * 夸克上刚建出来的深层目录，meta 往往还没就绪，
   * 但父目录列表已经能看到它。
   *
   * 超时不抛错：服务端已受理，硬失败反而会导致重复操作。
   */
  async waitForEntry(remotePath: string, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.entryExists(remotePath)) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  /**
   * 等远端文件**可见**并返回其元信息。
   *
   * 实测：夸克驱动下 `PUT /api/fs/put` 返回 200 后，文件要过约 1~3 秒
   * 才能被 `GET /api/fs/get` 查到——这段窗口里 stat 返回「不存在」。
   *
   * 上传后的校验、删除后的确认都依赖「远端已经能看到这个文件」，
   * 所以统一提供「等待可见」的能力，而不是各处自己 sleep 或立即判失败。
   *
   * ⚠️ 被动等待不够：OpenList 解析一个路径要先在**父目录的缓存列表**里
   * 找到它。目录缓存不会因为「文件上传了」而立刻更新，
   * 往往要等缓存自然刷新（实测数秒）才看得到新文件。
   * 所以这里**定期刷新父目录**，逼服务端用夸克侧的真实列表重建缓存——
   * 否则短超时（如下载取签名用的 10 秒）可能等不到文件出现。
   *
   * 刷新是安全的：它只用夸克侧的真实列表替换缓存，
   * 已落盘的文件照常出现，未落盘的暂时消失（各自的重试会把它等回来）。
   */
  async statWhenVisible(
    remotePath: string,
    timeoutMs = 20_000
  ): Promise<RemoteObject | null> {
    const deadline = Date.now() + timeoutMs
    const parent = remoteDirname(remotePath)
    let lastRefresh = 0

    for (;;) {
      const meta = await this.stat(remotePath)
      if (meta) return meta

      // 定期刷新父目录，逼缓存把新文件纳入
      const now = Date.now()
      if (now - lastRefresh >= REFRESH_INTERVAL_MS) {
        lastRefresh = now
        try {
          await this.list(parent, { refresh: true })
        } catch {
          // 父目录暂时读不到（可能正处在缓存替换的瞬间）→ 继续等
        }
      }

      if (now >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  /**
   * 刷新父目录后复查文件是否真的不存在。
   *
   * 用途：**排除缓存假阴性**。
   *
   * OpenList 的目录列表是快照缓存，`refresh:true` 会用夸克侧当时的
   * 真实列表整体替换缓存。若文件还没在夸克落盘（PUT 返回 200 只表示
   * OpenList 收下了字节流，夸克侧要再过约 1 秒才可见），
   * 它会被这次刷新从缓存里抹掉，之后连 Get 都读不到它。
   *
   * 实测复现：
   *   PUT → 立刻 refresh 父目录 → 列表为空、stat 返回 null
   *   3 秒后再 refresh → 文件回来了
   *
   * 所以「文件不存在」这个结论必须**刷新后复核**才能成立。
   * 对账据此判定「远端缺失」并触发重传——若不复核，
   * 就会把刚上传成功的文件误判成丢失，造成无休止的重传。
   *
   * ⚠️ 更严重的一层：**夸克驱动建目录也是异步的**。
   * 新建的目录要过约 3 秒才进父目录的列表，这期间刷新父目录
   * 会用「还没有它」的旧列表替换缓存 → 该目录连同整棵子树
   * 从 OpenList 视野里消失（`list` 抛 object not found）。
   * 此时若把「父目录读不到」当成「文件确实没了」，
   * 就会把**整棵树**误判成丢失并触发全量重传。
   *
   * 因此这里采取「宁可漏判、不可错杀」的阶梯判定：
   * **任何一步拿不到可信信息，就不判缺失。**
   *
   * 返回 true 表示**确实不存在**（刷新后仍然没有）。
   */
  async confirmMissing(remotePath: string): Promise<boolean> {
    const parent = remoteDirname(remotePath)
    const name = remoteBasename(remotePath)

    // ① 缓存列表里有 → 还在
    const cached = await this.list(parent).catch(() => null)
    if (cached === null) {
      // 父目录读不到。可能是缓存刚被刷新抹掉（目录暂时不可见），
      // 而不是文件真没了。不下结论——宁可漏一次重传，
      // 也不能把整棵子树误判成丢失。
      return false
    }
    if (cached.content.some((c) => c.name === name)) return false

    // ② stat 得到 → 还在
    if (await this.stat(remotePath)) return false

    // ③ 刷新父目录后再看
    const fresh = await this.list(parent, { refresh: true }).catch(() => null)
    if (fresh === null) return false
    if (fresh.content.some((c) => c.name === name)) return false

    // ④ 刷新结果可疑 → 再刷新一次，仍拿不到可信信息就不下结论。
    //
    // 「刷新前非空、刷新后为空」正是新建目录尚未进入父目录列表时的现象：
    // 这次刷新拿到的是夸克侧的旧列表，不足以说明文件真的没了。
    if (fresh.content.length === 0 && cached.content.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const again = await this.list(parent, { refresh: true }).catch(() => null)
      if (again === null) return false
      if (again.content.length === 0) return false
      if (again.content.some((c) => c.name === name)) return false
    }

    // ⑤ 刷新后仍然没有 → 确实缺失
    return (await this.stat(remotePath)) === null
  }

  /**
   * 移动 / 重命名。
   *
   * OpenList 把这两个动作拆成两个端点，且语义要分清：
   * - 同目录改名 → `POST /api/fs/rename` `{path: 完整文件路径, name: 新文件名}`
   * - 跨目录移动 → `POST /api/fs/move` `{src_dir, dst_dir, names: [文件名]}`
   *
   * **move 保持原文件名**（它只接受目标目录，不接受目标文件名）。
   * 所以「跨目录且要改名」必须两步：先 move 到目标目录，再 rename 改名字。
   * 实测跨目录 move 后文件落在 `dst_dir/原文件名`。
   *
   * 实测两个端点的**落盘时机不同**：
   * - rename 同步生效，返回后目标即可见
   * - move 异步落盘，返回 200 时文件还没到目标目录，实测需要 1~2 秒。
   *   所以 move 之后必须等目标出现，否则上层紧接着查目标会得到
   *   「不存在」的错误结论。
   */
  async move(src: string, dst: string): Promise<void> {
    const srcDir = remoteDirname(src)
    const dstDir = remoteDirname(dst)
    const srcName = remoteBasename(src)
    const dstName = remoteBasename(dst)

    // 同目录：直接改名
    if (srcDir === dstDir) {
      await this.requestWithCacheRepair(
        'POST',
        '/api/fs/rename',
        { path: src, name: dstName, overwrite: true },
        srcDir
      )
      await this.waitForGone(src)
      return
    }

    // 跨目录：目标父目录可能还不存在（如回收站时间戳目录）
    await this.mkdirp(dstDir)

    await this.requestWithCacheRepair(
      'POST',
      '/api/fs/move',
      { src_dir: srcDir, dst_dir: dstDir, names: [srcName] },
      srcDir
    )

    // move 保留原文件名，需要改名的话再补一次 rename
    if (srcName !== dstName) {
      const moved = `${dstDir}/${srcName}`
      await this.waitForEntry(moved)
      await this.requestWithCacheRepair(
        'POST',
        '/api/fs/rename',
        { path: moved, name: dstName, overwrite: true },
        dstDir
      )
    }

    await this.waitForEntry(dst)
    // 源必须真的消失了：move 是异步落盘，返回 200 时源还在原处。
    // 等它从源目录的列表里消失，才算这次移动真正完成。
    //
    // 等不到就必须**报错**，不能当成成功：
    // 静默成功的代价是用户看到「已删除」，远端文件却好好躺着。
    if (!(await this.waitForGone(src))) {
      throw new OpenListError(`移动后源文件仍在原处：${src} → ${dst}`, 0)
    }
  }

  /**
   * 发请求；若服务端说「找不到源对象」，刷新目录缓存后重试一次。
   *
   * 为什么要重试：OpenList 的目录列表是**快照缓存**，
   * `refresh:true` 会用夸克侧当时的真实列表整体替换缓存。
   * 若某个文件还没在夸克落盘（PUT 返回 200 只表示 OpenList 收下了
   * 字节流，夸克侧要再过约 1 秒才可见），它会被那次刷新从缓存里抹掉。
   *
   * 后果是 rename/move 直接失败：服务端在缓存里找不到源对象，
   * 报 "failed to get src object: object not found"。
   * 而文件其实好好地躺在夸克上——刷新缓存就能找回。
   *
   * 所以这里：失败 → 刷新源目录 → 重试一次。
   * 只重试一次，避免掩盖真正的错误。
   */
  private async requestWithCacheRepair<T>(
    method: string,
    path: string,
    body: unknown,
    cacheDir: string
  ): Promise<T> {
    try {
      return await this.request<T>(method, path, { body })
    } catch (err) {
      if (!isNotFound(err)) throw err

      // 刷新缓存，让服务端用夸克侧的真实列表重建
      try {
        await this.list(cacheDir, { refresh: true })
      } catch {
        // 刷新本身失败就按原样抛出
      }

      return this.request<T>(method, path, { body })
    }
  }

  /**
   * 等远端路径从其所在目录中消失。
   *
   * 判定用「父目录列表里不再有这个名字」——
   * stat 走的是服务端 meta 缓存，move 之后缓存未必立刻更新，
   * 用 stat 判定会误判成「还在」。
   *
   * ⚠️ 但**只读缓存的列表也不可靠**：OpenList 的目录列表是快照缓存，
   * move 之后缓存里可能**仍然留着**源文件（缓存更新有延迟）。
   * 于是「源还在」会被一直判定为真，只能白等到超时——
   * 而超时又被上层当成「成功」，等于根本没校验。
   *
   * 所以：等 3 秒还没消失就刷新一次，用夸克侧的真实列表判定。
   * 刷新只发生一次，且只在「等消失」这个场景用。
   */
  async waitForGone(
    remotePath: string,
    timeoutMs = 20_000,
    opts: { refreshAfterMs?: number } = {}
  ): Promise<boolean> {
    const parent = remoteDirname(remotePath)
    const name = remoteBasename(remotePath)
    const start = Date.now()
    const deadline = start + timeoutMs
    // 等多久之后用刷新来判定（默认 3 秒）
    const refreshAfterMs = opts.refreshAfterMs ?? 3000
    let refreshed = false
    for (;;) {
      try {
        const res = await this.list(parent, refreshed ? { refresh: true } : {})
        if (!res.content.some((c) => c.name === name)) return true
      } catch {
        // 父目录都没了 → 目标必然不在
        return true
      }
      if (!refreshed && Date.now() - start > refreshAfterMs) {
        refreshed = true
        continue
      }
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  /**
   * 下载远端文件到本地路径。
   *
   * 走 OpenList 的 raw 下载端点 `/d/<path>`，必须带 `?sign=`。
   *
   * 流式落盘而不是 `arrayBuffer()` 一次性读进内存：
   * 几十上百 MB 的文件会把内存吃满，而下载任务的进度条
   * 也需要「已收字节数」才能画出来。
   */
  async downloadTo(
    remotePath: string,
    localPath: string,
    opts: {
      sign?: string
      /** 进度回调：已收字节数 / 总字节数 */
      onProgress?: (received: number, total: number) => void
      signal?: AbortSignal
    } = {}
  ): Promise<void> {
    const url = await this.downloadUrl(remotePath, opts.sign)
    await this.downloadAttempt(url, localPath, true, opts)
  }

  /** 下载实现体；allowRetry 控制 401 后是否允许重新登录再试一次。 */
  private async downloadAttempt(
    url: string,
    localPath: string,
    allowRetry: boolean,
    opts: {
      onProgress?: (received: number, total: number) => void
      signal?: AbortSignal
    } = {}
  ): Promise<void> {
    const headers: Record<string, string> = {
      ...(this.token ? { Authorization: this.token } : {})
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    // 外部取消信号也要能中止请求
    const onExternalAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      const res = await fetchFor(url, { headers, signal: controller.signal })

      if (res.status === 401 && allowRetry && !this.authenticating) {
        await this.reauth()
        return this.downloadAttempt(url, localPath, false, opts)
      }

      if (!res.ok || !res.body) {
        throw new OpenListError(`OpenList GET /d → HTTP ${res.status}`, res.status)
      }

      const total = Number(res.headers.get('content-length') ?? 0)
      const reader = res.body.getReader()

      /*
       * 先写临时文件，写完再改名成正式文件名。
       *
       * 为什么不能直接写正式路径：下载中断（网络断、用户点取消）时，
       * 正式路径上会留下一个**半截文件**。而这个文件就躺在同步根目录里，
       * watcher 立刻会把它当成新文件 → 进上传队列 → 带 Overwrite 传上去
       * → **远端完好的那份被半截内容覆盖**。备份被自己搞坏了。
       *
       * 临时文件后缀用 `.part`：它不在清单里，watcher 看到也不认得
       * （认得的话又会走一遍上面的坑），传输成功后才 rename 成正式名。
       */
      const partPath = `${localPath}.part`
      const handle = await open(partPath, 'w')
      let received = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          await handle.write(value)
          received += value.byteLength
          opts.onProgress?.(received, total)
        }
      } catch (err) {
        // 中断：删掉半截文件，别让它污染同步目录
        await handle.close().catch(() => {})
        await rm(partPath, { force: true }).catch(() => {})
        throw err
      }
      await handle.close()

      // 写完了才落到正式路径；rename 跨卷会失败，退回复制
      try {
        await rename(partPath, localPath)
      } catch {
        await copyFile(partPath, localPath)
        await rm(partPath, { force: true })
      }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  // ── 内部工具 ─────────────────────────────────────────
  private async request<T>(
    method: string,
    path: string,
    opts: {
      headers?: Record<string, string>
      body?: unknown
      signal?: AbortSignal
      timeoutMs?: number
      /** 置 false 表示不再自动重登（登录自身、重试后的那次调用） */
      allowAuthRetry?: boolean
    } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(this.token ? { Authorization: this.token } : {}),
      ...opts.headers
    }

    let body: RequestInit['body']
    if (opts.body !== undefined) {
      if (opts.body instanceof ReadableStream) {
        body = opts.body as unknown as RequestInit['body']
      } else {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(opts.body)
      }
    }

    const timeout = opts.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      let res: Response
      try {
        res = await fetchFor(`${this.baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
          duplex: 'half'
        } as RequestInit)
      } catch (err) {
        // 网络层失败：fetch 只说 "fetch failed"，真正原因在 cause 链里。
        // 展开它，否则用户和排查者都只能看到一个没有信息量的字样。
        throw new OpenListError(
          `OpenList ${method} ${path} 请求失败：${describeError(err)}`,
          (err as { status?: number }).status ?? 0,
          err
        )
      }

      const text = await res.text()
      if (!res.ok) {
        if (res.status === 401 && opts.allowAuthRetry !== false && !this.authenticating) {
          // 凭据过期（JWT 有效期约 48h）。
          // 请求体若是流则已被消费、无法原地重放：
          // 先刷新 token，再把错误抛给上层，由上层重新发起（会重读文件）。
          const replayable = !(opts.body instanceof ReadableStream)
          try {
            await this.reauth()
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            throw new OpenListError(
              `OpenList ${method} ${path} → HTTP 401，且重新登录失败：${detail}`,
              401,
              text
            )
          }
          if (replayable) {
            return this.request<T>(method, path, { ...opts, allowAuthRetry: false })
          }
          throw new OpenListError(
            `OpenList ${method} ${path} → HTTP 401（凭据已过期，已自动重新登录，需重新发起本次请求）`,
            401,
            text
          )
        }
        throw new OpenListError(`OpenList ${method} ${path} → HTTP ${res.status}`, res.status, text)
      }

      const parsed = text ? (JSON.parse(text) as { code?: number; message?: string; data?: T }) : null
      if (parsed && parsed.code !== undefined && parsed.code !== 200) {
        throw new OpenListError(parsed.message ?? `接口返回 code=${parsed.code}`, res.status, parsed)
      }
      return (parsed?.data ?? parsed) as T
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}
