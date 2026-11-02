import { describe, expect, it, vi } from 'vitest'
import { verifyRemote } from '../src/main/verify/verifier'
import { createZip } from '../src/main/diagnostics/zip'
import type { OpenListClient } from '../src/main/openlist/client'

/**
 * 远端校验与诊断包打包的测试。
 *
 * 校验这块最要紧的是「不能把失败当成功」——
 * 拿不到远端信息时必须判失败，不能悄悄放过。
 */

/**
 * 造一个 mock 客户端。
 *
 * `statWhenVisible` 与 `stat` 行为一致——它是「等待可见」的封装，
 * 校验器走的是它。用同一个实现造两个方法，
 * 这样测试里 override `stat` 就能同时影响两者。
 */
function makeClient(overrides: Partial<OpenListClient> = {}): OpenListClient {
  const statImpl =
    (overrides.stat as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({ name: 'a.txt', size: 100, modified: '', isDir: false })

  return {
    stat: statImpl,
    statWhenVisible: vi.fn().mockImplementation(async (...args: unknown[]) =>
      statImpl(...args)
    ),
    hashRemote: vi.fn().mockResolvedValue({ md5: 'm'.repeat(32), sha1: 's'.repeat(40), size: 100 }),
    ...overrides
  } as unknown as OpenListClient
}

const MD5 = 'm'.repeat(32)
const SHA1 = 's'.repeat(40)

describe('远端校验', () => {
  it('none 模式直接通过，不发任何请求', async () => {
    const client = makeClient()
    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      mode: 'none',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(true)
    expect(client.stat).not.toHaveBeenCalled()
  })

  it('size 模式在远端大小一致时通过', async () => {
    const client = makeClient()
    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      mode: 'size',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(true)
    expect(res.actual).toBe(100)
  })

  it('size 模式在远端大小不符时失败', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue({ name: 'a.txt', size: 99, modified: '', isDir: false })
    } as Partial<OpenListClient>)
    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      mode: 'size',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('不一致')
  })

  it('取不到远端元信息时判失败——不能当作通过', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue(null)
    } as Partial<OpenListClient>)
    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      mode: 'size',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('元信息')
  })

  it('stat 抛错时判失败并带上原因', async () => {
    const client = makeClient({
      stat: vi.fn().mockRejectedValue(new Error('连接超时'))
    } as Partial<OpenListClient>)
    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      mode: 'size',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('连接超时')
  })

  it('hash 模式在驱动提供了远端哈希时直接比对，不下载', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue({
        name: 'a.txt',
        size: 100,
        modified: '',
        isDir: false,
        hashInfo: { MD5: { name: 'MD5', size: 16, hash: MD5 } }
      })
    } as Partial<OpenListClient>)

    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      expectedMd5: MD5,
      expectedSha1: SHA1,
      mode: 'hash',
      verifyHashMaxBytes: 1024
    })

    expect(res.ok).toBe(true)
    // 已有远端哈希就不该下载——那是白花的流量
    expect(client.hashRemote).not.toHaveBeenCalled()
  })

  it('hash 模式在远端哈希与本地不符时失败', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue({
        name: 'a.txt',
        size: 100,
        modified: '',
        isDir: false,
        hashInfo: { MD5: { name: 'MD5', size: 16, hash: 'x'.repeat(32) } }
      })
    } as Partial<OpenListClient>)

    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      expectedMd5: MD5,
      mode: 'hash',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('MD5')
  })

  it('hash 模式在驱动不给哈希时下载重算', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue({ name: 'a.txt', size: 100, modified: '', isDir: false })
    } as Partial<OpenListClient>)

    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      expectedMd5: MD5,
      expectedSha1: SHA1,
      mode: 'hash',
      verifyHashMaxBytes: 1024
    })

    expect(res.ok).toBe(true)
    expect(client.hashRemote).toHaveBeenCalledTimes(1)
  })

  it('hash 模式在下载重算后发现内容不符时失败', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue({ name: 'a.txt', size: 100, modified: '', isDir: false }),
      hashRemote: vi.fn().mockResolvedValue({ md5: 'y'.repeat(32), sha1: SHA1, size: 100 })
    } as Partial<OpenListClient>)

    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      expectedMd5: MD5,
      mode: 'hash',
      verifyHashMaxBytes: 1024
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('MD5')
  })

  it('文件超过深度校验上限时退化为大小校验并说明', async () => {
    const client = makeClient({
      stat: vi.fn().mockResolvedValue({ name: 'a.txt', size: 100, modified: '', isDir: false })
    } as Partial<OpenListClient>)

    const res = await verifyRemote({
      client,
      remotePath: '/q/a.txt',
      expectedSize: 100,
      expectedMd5: MD5,
      mode: 'hash',
      verifyHashMaxBytes: 50 // 比文件小
    })

    expect(res.ok).toBe(true)
    expect(res.detail).toContain('仅校验大小')
    expect(client.hashRemote).not.toHaveBeenCalled()
  })
})

describe('诊断包打包', () => {
  it('生成的 zip 有正确的中央目录结构', () => {
    const zip = createZip([
      { name: 'summary.json', data: Buffer.from('{"a":1}', 'utf8') },
      { name: 'logs.txt', data: Buffer.from('日志内容', 'utf8') }
    ])

    // 本地文件头 + 中央目录头 + 结束记录
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    // 中央目录结束记录在文件末尾
    const eocdOffset = zip.length - 22
    expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50)
    expect(zip.readUInt16LE(eocdOffset + 10)).toBe(2) // 条目数
  })

  it('中文内容按 UTF-8 写入且长度正确', () => {
    const text = '诊断包：远端校验失败'
    const zip = createZip([{ name: 'logs.txt', data: Buffer.from(text, 'utf8') }])

    // 第一个本地文件头：名称长度在偏移 26
    const nameLen = zip.readUInt16LE(26)
    const name = zip.slice(30, 30 + nameLen).toString('utf8')
    expect(name).toBe('logs.txt')

    // 数据长度在偏移 22
    expect(zip.readUInt32LE(22)).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('空归档也能生成合法的结束记录', () => {
    const zip = createZip([])
    expect(zip.length).toBe(22)
    expect(zip.readUInt32LE(0)).toBe(0x06054b50)
  })
})
