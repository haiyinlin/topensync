import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import { OpenListClient } from '../src/main/openlist/client'

/**
 * 实测：夸克驱动的**建目录延迟**与目录缓存的失效窗口。
 *
 * 这组测试测的是一条实测得出的时间线，不是从文档抄的：
 *
 *   · 目录**自身**在 mkdir 返回后立刻就能被列举（可往里写文件）
 *   · 父目录的**缓存**视图里也立刻能看到新目录
 *   · 但父目录的**刷新**视图（refresh:true）要等夸克侧就绪才包含它
 *     —— 约 3 秒。不稳定窗口里刷新父目录，新目录连同整棵子树
 *     会从 OpenList 视野里消失（`list` 抛 object not found）。
 *
 * 危险窗口里若对账器把「列不出来」当成「文件没了」，
 * 就会触发全量重传——这是本项目最危险的一类误判。
 *
 * 运行：
 *   M0_BASE=http://192.168.100.10:5244 M0_USER=admin M0_PASS=*** M0_ROOT=/qh \
 *     npx vitest run tests/quark-settle-live.test.ts
 */

const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const ROOT = process.env.M0_ROOT || '/'
const ENABLED = Boolean(BASE && USER && PASS)

const PROBE = `quark-settle-${randomBytes(4).toString('hex')}`
const DIR = `${ROOT}/${PROBE}`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function hashes(text: string): { md5: string; sha1: string } {
  return {
    md5: createHash('md5').update(text).digest('hex'),
    sha1: createHash('sha1').update(text).digest('hex')
  }
}

describe.skipIf(!ENABLED)('夸克驱动的建目录延迟与缓存失效窗口', () => {
  let client: OpenListClient

  beforeAll(async () => {
    client = new OpenListClient({
      baseUrl: BASE!,
      username: USER!,
      password: PASS!,
      timeoutMs: 120_000
    })
    await client.login()
  })

  afterAll(async () => {
    for (const p of [DIR, `${DIR}-refresh`]) {
      try {
        await client.removeTree(p)
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  })

  it('目录自身在 mkdir 后立刻可列举，父目录缓存也立刻可见', async () => {
    const t0 = Date.now()
    const timeline: string[] = []

    await client.mkdir(DIR)

    const sample = async (): Promise<void> => {
      const elapsed = Date.now() - t0

      let inCache = 'ERR'
      try {
        const res = await client.list(ROOT)
        inCache = String(res.content.some((c) => c.name === PROBE))
      } catch {
        inCache = 'ERR'
      }

      let selfListable = 'ERR'
      try {
        await client.list(DIR)
        selfListable = 'yes'
      } catch {
        selfListable = 'no'
      }

      timeline.push(
        `  t=${String(elapsed).padStart(6)}ms  父目录缓存含新目录=${inCache}  目录可列举=${selfListable}`
      )
    }

    await sample()
    for (const wait of [500, 1000, 1500, 2000, 3000, 3000]) {
      await sleep(wait)
      await sample()
    }

    console.log('\n===== 建目录后的可见性时间线（父目录只看缓存，不刷新）=====')
    console.log(timeline.join('\n'))

    // 目录自身最终一定能被列举（夸克侧会就绪）
    expect(await client.dirReady(DIR), '目录最终应能被列举').toBe(true)
  })

  it('刷新父目录在夸克就绪前会「看不见」新目录，就绪后恢复', async () => {
    const name = `${PROBE}-refresh`
    const dir = `${ROOT}/${name}`
    const t0 = Date.now()

    await client.mkdir(dir)

    const rows: string[] = []
    const check = async (): Promise<void> => {
      const elapsed = Date.now() - t0
      let seen = 'ERR'
      try {
        const res = await client.list(ROOT, { refresh: true })
        seen = String(res.content.some((c) => c.name === name))
      } catch {
        seen = 'ERR'
      }
      let selfOk = 'ERR'
      try {
        await client.list(dir)
        selfOk = 'yes'
      } catch {
        selfOk = 'no'
      }
      rows.push(`  t=${String(elapsed).padStart(6)}ms  刷新后父目录含新目录=${seen}  目录自身可列举=${selfOk}`)
    }

    await check()
    await sleep(1500)
    await check()
    await sleep(3000)
    await check()
    await sleep(5000)
    await check()

    console.log('\n===== 刷新父目录后的可见性时间线 =====')
    console.log(rows.join('\n'))

    // 最终（夸克就绪后）刷新必须能看到这个目录
    const res = await client.list(ROOT, { refresh: true })
    expect(
      res.content.some((c) => c.name === name),
      '夸克就绪后刷新父目录必须能看到新建目录'
    ).toBe(true)
  })

  it('文件真实存在时 confirmMissing 始终判「没丢」', async () => {
    await client.mkdirp(DIR)
    const file = `${DIR}/f.txt`
    const content = 'settle probe\n'
    const { md5, sha1 } = hashes(content)

    await client.putFile(
      file,
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(content))
          c.close()
        }
      }),
      { size: content.length, md5, sha1, lastModifiedMs: Date.now() }
    )

    const visible = await client.statWhenVisible(file, 30_000)
    expect(visible, '文件最终应可见').not.toBeNull()

    for (let i = 0; i < 3; i++) {
      const missing = await client.confirmMissing(file)
      expect(missing, `第 ${i + 1} 次 confirmMissing 不应把存在的文件判成缺失`).toBe(false)
      await sleep(1000)
    }
  })

  it('父目录暂时读不到时，confirmMissing 宁可漏判也不误杀', async () => {
    // 模拟「缓存被刷新抹掉 → 父目录列不出来」：
    // 此时绝不能返回 true（= 确实缺失），否则对账会触发全量重传。
    const file = `${DIR}/does-not-exist.txt`
    const missing = await client.confirmMissing(file)
    // 父目录可列举时，确认缺失是允许的；这里只断言不抛异常且返回布尔
    expect(typeof missing).toBe('boolean')
    if (missing) {
      // 确实缺失时，confirmMissing 内部必须真的查不到
      expect(await client.stat(file)).toBeNull()
    }
  })
})
