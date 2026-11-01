import { writeFile } from 'fs/promises'

/**
 * OpenList REST 客户端。
 *
 * 全部接口行为已对照 OpenList v4 main 分支源码核实。
 * 两条关键约束写在下面，改动前务必重读：
 *
 * 1. 上传是 `PUT /api/fs/put`，**不是 POST**（server/router.go:304）。
 * 2. 列举目录时 `per_page` 必须传足够大的值。`per_page: 0` 会返回
 *    **空数组**——server/handles/fsread.go:215 的 pagination() 在
 *    pageSize=0 时执行 objs[0:0]。
 * 3. `refresh: true` 需要目标目录的写权限，否则返回 403
 *    （server/handles/fsread.go:93）。远端对账依赖它来发现外部删除。
 */

export interface OpenListClientOptions {
  baseUrl: string
  username: string
  password: string
  /** 单次请求超时（毫秒） */
  timeoutMs?: number
}

export interface RemoteObject {
  name: string
  size: number
  modified: string
  isDir: boolean
  sign?: string
  /** 夸克驱动下通常为空；不能依赖它做内容比对 */
  hashInfo?: Record<string, string>
}

export interface ListResult {
  content: RemoteObject[]
  total: number
  provider: string
}

/** 夸克单文件 20GB，分片接口建议值 */
const DEFAULT_LIST_PAGE_SIZE = 99999
const DEFAULT_TIMEOUT_MS = 60_000

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
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private readonly timeoutMs: number

  constructor(opts: OpenListClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.username = opts.username
    this.password = opts.password
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // ── 认证 ─────────────────────────────────────────────
  /** 登录换取 JWT。token 有效期约 48h，过期需重新登录。 */
  async login(): Promise<void> {
    const res = await this.request<{ token: string }>('POST', '/api/auth/login', {
      body: { username: this.username, password: this.password }
    })
    this.token = res.token
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
    }
  ): Promise<void> {
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
      body,
      signal: opts.signal,
      timeoutMs: Math.max(this.timeoutMs, opts.size / (1024 * 1024) * 1000 * 60)
    })
  }

  // ── 分片上传 ───────────────────────────────────────────
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

    return this.request('POST', '/api/fs/multipart/init', { headers })
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
    await this.request('PUT', '/api/fs/multipart/chunk', {
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
    return this.request('GET', `/api/fs/multipart/status?upload_id=${encodeURIComponent(uploadId)}`)
  }

  async multipartComplete(uploadId: string): Promise<void> {
    await this.request('POST', '/api/fs/multipart/complete', {
      headers: { 'X-Upload-Id': uploadId }
    })
  }

  async multipartAbort(uploadId: string): Promise<void> {
    await this.request('POST', '/api/fs/multipart/abort', {
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
    return this.request('POST', '/api/fs/list', {
      body: {
        path,
        password: '',
        page: 1,
        // 必须是足够大的值；per_page: 0 会返回空数组
        per_page: DEFAULT_LIST_PAGE_SIZE,
        refresh: opts.refresh ?? false
      },
      signal: opts.signal
    })
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.request('POST', '/api/fs/remove', {
      body: { dir: false, names: paths }
    })
  }

  async mkdir(path: string): Promise<void> {
    await this.request('POST', '/api/fs/mkdir', { body: { path } })
  }

  /** 移动/重命名。远程删除走回收站时用它把文件移到 _trash/。 */
  async move(src: string, dst: string): Promise<void> {
    await this.request('POST', '/api/fs/move', { body: { src, dst } })
  }

  /**
   * 下载远端文件到本地路径。
   *
   * 走 OpenList 的 raw 下载端点 `/d/<path>`。
   * 部分驱动要求 sign 参数（列举结果里带 sign），这里先不处理——
   * 拿不到时会抛错，由调用方记录，差异保持未处置状态。
   */
  async downloadTo(remotePath: string, localPath: string): Promise<void> {
    const url = `${this.baseUrl}/d${encodeURI(remotePath)}`
    const headers: Record<string, string> = {
      ...(this.token ? { Authorization: this.token } : {})
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { headers, signal: controller.signal })
      if (!res.ok || !res.body) {
        throw new OpenListError(`OpenList GET /d → HTTP ${res.status}`, res.status)
      }
      await writeFile(localPath, Buffer.from(await res.arrayBuffer()))
    } finally {
      clearTimeout(timer)
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
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        duplex: 'half'
      } as RequestInit)

      const text = await res.text()
      if (!res.ok) {
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
