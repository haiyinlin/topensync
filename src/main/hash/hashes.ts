import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { ioGovernor } from '../io/governor'

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
 *
 * 走 IO 闸门：几万个文件同时算哈希会把句柄耗尽（见 io/governor.ts），
 * 闸门保证同一时刻只有固定数量的读流存在。
 */
export async function hashFile(path: string): Promise<FileHashes> {
  return ioGovernor.run(async () => {
    const md5 = createHash('md5')
    const sha1 = createHash('sha1')
    let bytes = 0

    const stream = createReadStream(path)
    try {
      await new Promise<void>((resolve, reject) => {
        /*
         * 三个监听都必须能收尾。
         *
         * 以前只在 end / error 上收尾：`md5.update()` 抛异常时
         * （内存不足、chunk 类型异常）promise 永远不 settle，
         * 而读流还开着——一次泄漏一个句柄，几万次之后就 EMFILE。
         */
        stream.on('data', (chunk: string | Buffer) => {
          try {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            bytes += buf.length
            md5.update(buf)
            sha1.update(buf)
          } catch (err) {
            stream.destroy(err as Error)
          }
        })
        stream.on('end', () => resolve())
        stream.on('error', reject)
        stream.on('close', () => {
          // closed 先于 end 到达 = 读取被中途切断，外层不能一直 await 下去
          if (!stream.readableEnded) reject(new Error(`读取中断：${path}`))
        })
      })
      return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), size: bytes }
    } finally {
      // 成功路径上流已自然结束；这里兜住异常与提前取消两种情况
      if (!stream.destroyed) stream.destroy()
    }
  })
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
