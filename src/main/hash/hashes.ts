import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'

/**
 * 双哈希计算。
 *
 * 夸克秒传需要 **MD5 + SHA1 同时提供**：
 * drivers/quark_open/seed_rapid.go 中 RapidHashAlgos = MD5+SHA1。
 * 缺任一个 → 驱动走 stream.CacheFullAndWriter 把整个文件缓存起来再算，
 * 既失去秒传，又可能把 OpenList 服务器内存/磁盘打爆。
 *
 * 两个哈希必须在**一次读取**中同时算出，不能读两遍文件。
 */

export interface FileHashes {
  md5: string
  sha1: string
  size: number
}

/**
 * 流式计算双哈希。读完顺带拿到真实字节数，
 * 用于校验读取期间文件是否被改动。
 */
export async function hashFile(path: string): Promise<FileHashes> {
  const md5 = createHash('md5')
  const sha1 = createHash('sha1')
  let bytes = 0

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buf.length
      md5.update(buf)
      sha1.update(buf)
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })

  return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), size: bytes }
}

/**
 * 哈希前后的文件一致性校验。
 *
 * 竞态：先算哈希、后封包/上传，期间文件可能被改写，
 * 导致「记录的哈希」与「实际传输的字节」不符。上传前必须复核。
 */
export async function verifyUnchanged(
  path: string,
  expected: { size: number; mtimeMs: number }
): Promise<boolean> {
  const st = await stat(path)
  return st.size === expected.size && Math.floor(st.mtimeMs) === Math.floor(expected.mtimeMs)
}

/** 取文件 stat，用于分流规则（两档路径判定） */
export async function fileStat(path: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await stat(path)
  return { size: st.size, mtimeMs: st.mtimeMs }
}
