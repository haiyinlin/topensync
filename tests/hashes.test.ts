import { describe, expect, it, afterAll } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashFile, verifyUnchanged } from '../src/main/hash/hashes'

/**
 * 双哈希测试。
 *
 * 夸克秒传要求 MD5 + SHA1 同时正确，因此这里的期望值必须
 * 与独立计算的基准值逐字节一致 —— 任何一个哈希算错，
 * 服务端就会退化成缓存整个文件，失去秒传并撑爆内存。
 */
describe('hashFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quarksync-test-'))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('计算出的 MD5 与 SHA1 与独立基准一致', async () => {
    const content = 'The quick brown fox jumps over the lazy dog'
    const file = join(dir, 'sample.txt')
    writeFileSync(file, content)

    const result = await hashFile(file)

    expect(result.md5).toBe(createHash('md5').update(content).digest('hex'))
    expect(result.sha1).toBe(createHash('sha1').update(content).digest('hex'))
    expect(result.size).toBe(Buffer.byteLength(content))
  })

  it('空文件也能算出合法哈希', async () => {
    const file = join(dir, 'empty.bin')
    writeFileSync(file, '')

    const result = await hashFile(file)

    expect(result.md5).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(result.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(result.size).toBe(0)
  })

  it('大文件（>1MB）哈希正确且字节数准确', async () => {
    const buf = Buffer.alloc(1024 * 1024 + 12345)
    // 填入可预测内容，避免全零被特殊优化
    for (let i = 0; i < buf.length; i++) buf[i] = i % 251
    const file = join(dir, 'large.bin')
    writeFileSync(file, buf)

    const result = await hashFile(file)

    expect(result.size).toBe(buf.length)
    expect(result.md5).toBe(createHash('md5').update(buf).digest('hex'))
    expect(result.sha1).toBe(createHash('sha1').update(buf).digest('hex'))
  })
})

describe('verifyUnchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quarksync-verify-'))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件未变时返回 true', async () => {
    const file = join(dir, 'stable.txt')
    writeFileSync(file, 'stable')
    const st = await import('fs/promises').then((fs) => fs.stat(file))

    expect(await verifyUnchanged(file, { size: st.size, mtimeMs: st.mtimeMs })).toBe(true)
  })

  it('大小变化时返回 false（防止哈希与传输字节不一致）', async () => {
    const file = join(dir, 'changed.txt')
    writeFileSync(file, 'before')

    expect(await verifyUnchanged(file, { size: 999, mtimeMs: Date.now() })).toBe(false)
  })
})
