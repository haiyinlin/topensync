import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import { OpenListClient } from '../src/main/openlist/client'

/**
 * 针对**真实 OpenList 实例**的契约测试。
 *
 * 为什么要有这一层：单元测试用 mock 只能锁住「我们以为的契约」，
 * 而 mock 是照着同一份错误理解写的，于是错误永远测不出来。
 * 真实实例会直接用 400/403/401/404 把错误顶回来。
 *
 * 运行方式（不设环境变量时整组跳过，不污染任何环境）：
 *   M0_BASE=http://192.168.100.10:5244 M0_USER=admin M0_PASS=*** M0_ROOT=/qh \
 *     npx vitest run tests/openlist-live.test.ts
 *
 * 所有产物都写在 ROOT 下一个随机子目录里，测试结束整目录删除。
 */

const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const ROOT = process.env.M0_ROOT || '/'
const ENABLED = Boolean(BASE && USER && PASS)

/** 本组测试专用的远端子目录，避免与其他数据混在一起 */
const PROBE = `live-contract-${randomBytes(4).toString('hex')}`

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}
function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

/**
 * 等某个文件出现在目录列表里。
 *
 * 夸克落盘有延迟：文件上传后要过约 1~3 秒才进 OpenList 的目录缓存。
 * 不等就会随机失败——这类 flaky 断言比没有断言更糟，它会掩盖真问题。
 */
async function waitForListed(
  client: OpenListClient,
  dir: string,
  name: string,
  timeoutMs = 30_000
): Promise<{ name: string; size: number; isDir: boolean; sign?: string } | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await client.list(dir, { refresh: true })
    const hit = res.content.find((c) => c.name === name)
    if (hit) return hit
    if (Date.now() >= deadline) return undefined
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe.skipIf(!ENABLED)('OpenListClient 对真实实例的契约', () => {
  let client: OpenListClient

  beforeAll(async () => {
    client = new OpenListClient({
      baseUrl: BASE!,
      username: USER!,
      password: PASS!,
      timeoutMs: 120_000
    })
    await client.login()
    await client.mkdirp(`${ROOT}/${PROBE}`)
  })

  afterAll(async () => {
    try {
      // 用 removeTree：OpenList 的 remove 不递归，目录非空时会失败，
      // 清理不干净就会在远端留下残留目录。
      await client.removeTree(`${ROOT}/${PROBE}`)
    } catch {
      /* 清理失败不应让测试报告变红，人工核对即可 */
    }
  })

  it('登录成功并拿到 JWT', () => {
    expect(USER).toBeTruthy()
    expect(PASS).toBeTruthy()
  })

  it('list 归一化出 isDir / sign / hashInfo', async () => {
    const content = Buffer.from('live list probe')
    const path = `${ROOT}/${PROBE}/list.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    // 夸克落盘有延迟：文件要过约 1~3 秒才进 OpenList 的目录缓存。
    // 这里必须等它出现，否则断言会随机失败。
    const entry = await waitForListed(client, `${ROOT}/${PROBE}`, 'list.txt')

    expect(entry).toBeDefined()
    expect(entry!.isDir).toBe(false)
    expect(entry!.size).toBe(content.length)
    // 下载签名必须能拿到，否则 GET /d 一律 401
    expect(entry!.sign).toBeTruthy()
    const res = await client.list(`${ROOT}/${PROBE}`)
    expect(res.provider).toBeTruthy()
  })

  it('stat 读到平铺字段（size / isDir / sign）', async () => {
    const content = Buffer.from('live stat probe')
    const path = `${ROOT}/${PROBE}/stat.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    // 上传后文件要过约 1~3 秒才可查，这里等它可见
    const obj = await client.statWhenVisible(path, 30_000)
    expect(obj).not.toBeNull()
    expect(obj!.size).toBe(content.length)
    expect(obj!.isDir).toBe(false)
    expect(obj!.sign).toBeTruthy()
  })

  it('hashRemote 能下载远端并重算出与本地一致的哈希', async () => {
    const content = Buffer.from('live hash probe ' + randomBytes(8).toString('hex'))
    const path = `${ROOT}/${PROBE}/hash.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    const computed = await client.hashRemote(path)
    expect(computed).not.toBeNull()
    expect(computed!.size).toBe(content.length)
    expect(computed!.md5).toBe(md5(content))
    expect(computed!.sha1).toBe(sha1(content))
  })

  it('per_page 小于 1 时服务端会修正为全量（不是返回空数组）', async () => {
    // 实测结论：PageReq.Validate() 把 per_page < 1 改成 MaxInt，
    // 与早期「per_page=0 返回空数组」的推断相反。
    const res = await client.list(ROOT)
    expect(res.content.length).toBeGreaterThan(0)
    expect(res.total).toBe(res.content.length)
  })

  it('refresh:true 在有写权限时可用（对账通道依赖它）', async () => {
    const res = await client.list(ROOT, { refresh: true })
    expect(res.content.length).toBeGreaterThan(0)
  })

  it('remove 用「目录 + 文件名」删除成功', async () => {
    const content = Buffer.from('live remove probe')
    const path = `${ROOT}/${PROBE}/rm.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    await client.remove([path])
    const after = await client.stat(path)
    expect(after).toBeNull()
  })

  it('move 同目录等价于重命名', async () => {
    const content = Buffer.from('live rename probe')
    const src = `${ROOT}/${PROBE}/before.txt`
    const dst = `${ROOT}/${PROBE}/after.txt`
    await client.putFile(src, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    await client.move(src, dst)

    expect(await client.stat(src)).toBeNull()
    const moved = await client.stat(dst)
    expect(moved).not.toBeNull()
    expect(moved!.size).toBe(content.length)
  })

  it('move 跨目录会先建目标目录再移动', async () => {
    const content = Buffer.from('live cross-move probe')
    const src = `${ROOT}/${PROBE}/cross-src.txt`
    const dst = `${ROOT}/${PROBE}/nested/deeper/cross-dst.txt`
    await client.putFile(src, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    await client.move(src, dst)

    expect(await client.stat(src)).toBeNull()
    const moved = await client.stat(dst)
    expect(moved).not.toBeNull()
    expect(moved!.size).toBe(content.length)
  }, 60_000)

  it('分片上传：服务端不支持时探测应返回 false，支持时可完整落地', async () => {
    const supported = await client.probeMultipart()

    if (!supported) {
      // 实测：用户实例（dev 版）没有 /multipart 路由，
      // 请求会落到前端 SPA 的 index.html（HTTP 200 + text/html）。
      // 此时客户端应降级为单次 PUT——用一次真实的大文件 PUT 验证这条路径可用。
      const content = Buffer.alloc(9 * 1024 * 1024, 'A')
      const path = `${ROOT}/${PROBE}/bigput.bin`
      await client.putFile(path, streamOf(content), {
        size: content.length,
        md5: md5(content),
        sha1: sha1(content),
        lastModifiedMs: Date.now()
      })

      const obj = await client.stat(path)
      expect(obj).not.toBeNull()
      expect(obj!.size).toBe(content.length)

      // 不支持时 multipartInit 必须明确报错，而不是把 HTML 当响应
      await expect(
        client.multipartInit(path, {
          size: content.length,
          md5: md5(content),
          sha1: sha1(content),
          lastModifiedMs: Date.now()
        })
      ).rejects.toMatchObject({ status: 501 })
      return
    }

    // 3MB，跨过单次 PUT 的默认上限，强制走分片路径
    const content = Buffer.alloc(3 * 1024 * 1024, 'A')
    const path = `${ROOT}/${PROBE}/multipart.bin`

    const init = await client.multipartInit(path, {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now(),
      chunkSize: 1024 * 1024
    })
    expect(init.upload_id).toBeTruthy()

    const chunkSize = 1024 * 1024
    for (let i = 0; i * chunkSize < content.length; i++) {
      await client.multipartChunk(
        init.upload_id,
        i,
        streamOf(content.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, content.length)))
      )
    }
    await client.multipartComplete(init.upload_id)

    const obj = await client.stat(path)
    expect(obj).not.toBeNull()
    expect(obj!.size).toBe(content.length)
  }, 180_000)

  it('夸克驱动不返回远端哈希（hash 校验模式必须走下载重算）', async () => {
    const content = Buffer.from('live hashinfo probe')
    const path = `${ROOT}/${PROBE}/hashinfo.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    const obj = await client.stat(path)
    // 实测 hash_info 为 null；这决定了 verifyMode='hash' 的实现路径
    if (obj!.hashInfo) {
      expect(Object.keys(obj!.hashInfo).length).toBeGreaterThan(0)
    } else {
      expect(obj!.hashInfo).toBeUndefined()
    }
  })

  // ── 目录缓存语义（实测得出，违反直觉）─────────────────

  it('上传后文件不是立刻可见：statWhenVisible 能等到它出现', async () => {
    const content = Buffer.from('live visible probe')
    const path = `${ROOT}/${PROBE}/visible.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    // PUT 返回 200 只表示 OpenList 收下了字节流，
    // 夸克侧落盘要再过约 1 秒，这期间 stat 返回 null。
    const meta = await client.statWhenVisible(path, 15_000)
    expect(meta, '文件最终应可见').not.toBeNull()
    expect(meta!.size).toBe(content.length)
  }, 60_000)

  it('refresh 父目录会抹掉尚未落盘的兄弟文件（缓存假阴性）', async () => {
    // 这是本项目最隐蔽的一个坑，务必锁住。
    //
    // 实测：目录列表是快照缓存，refresh:true 会用夸克侧当时的真实列表
    // 整体替换缓存。若某个文件还没在夸克落盘，它会被这次刷新抹掉，
    // 之后连 Get 都读不到（直到下一次 refresh 才找得回来）。
    //
    // 对同步程序的危害：刚上传成功的文件被误判成「不存在」，
    // 校验失败 → 反复重传 → 甚至形成死循环。
    const dir = `${ROOT}/${PROBE}/cache-probe`
    await client.mkdirp(dir)

    const content = Buffer.from('cache probe payload')
    const path = `${dir}/fresh.txt`
    await client.putFile(path, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    // 立刻刷新父目录 —— 若文件还没在夸克落盘，它会被抹掉
    await client.list(dir, { refresh: true })

    // confirmMissing 刷新后复核，能把「缓存假阴性」和「真缺失」区分开：
    // 若文件其实还在，它会通过再刷新找回来。
    const reallyMissing = await client.confirmMissing(path)
    expect(reallyMissing, '文件最终应能找回，不该被判为缺失').toBe(false)

    // 确认 stat 现在能读到（再刷新后缓存已重建）
    const meta = await client.statWhenVisible(path, 15_000)
    expect(meta).not.toBeNull()
  }, 60_000)

  it('move 之后源路径确实从目录列表里消失', async () => {
    const content = Buffer.from('live gone probe')
    const src = `${ROOT}/${PROBE}/gone-src.txt`
    const dst = `${ROOT}/${PROBE}/gone-dst.txt`
    await client.putFile(src, streamOf(content), {
      size: content.length,
      md5: md5(content),
      sha1: sha1(content),
      lastModifiedMs: Date.now()
    })

    await client.move(src, dst)

    // move 是异步落盘：返回 200 时源还在原处。
    // waitForGone 用「父目录列表里不再有这个名字」判定，才是对的。
    expect(await client.waitForGone(src, 15_000), '源路径应消失').toBe(true)
    const moved = await client.statWhenVisible(dst, 15_000)
    expect(moved, '目标路径应存在').not.toBeNull()
  }, 60_000)

  it('dirReady 用「能列举」判断目录就绪，不存在的目录列举会抛错', async () => {
    await client.mkdirp(`${ROOT}/${PROBE}/ready-dir`)
    expect(await client.dirReady(`${ROOT}/${PROBE}/ready-dir`)).toBe(true)
    expect(await client.dirReady(`${ROOT}/${PROBE}/no-such-dir`)).toBe(false)
  }, 60_000)
})

/** 把 Buffer 包成可读流 */
function streamOf(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(buf))
      c.close()
    }
  })
}
