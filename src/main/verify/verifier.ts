import type { OpenListClient } from '../openlist/client'
import type { VerifyMode, VerifyResult } from '@shared/types'

/**
 * 远端一致性校验。
 *
 * 「上传成功」只说明服务端收下了字节流，**不等于远端内容正确**。
 * 传输链路上的截断、代理改写、驱动侧的写入异常都可能留下
 * 大小对但内容错的文件——这类问题只有主动校验才能发现。
 *
 * 三档模式（配置项 `verifyMode`）：
 *
 * | 模式 | 手段 | 成本 | 能发现什么 |
 * |---|---|---|---|
 * | `none` | 不校验 | 0 | 什么都发现不了 |
 * | `size` | 比对远端大小 | 一次 stat | 大小不符（截断、写坏） |
 * | `hash` | 比对远端哈希 | 一次 stat + 可能一次全量下行 | 内容不符 |
 *
 * `hash` 模式有个绕不开的现实：**夸克驱动的 hash_info 通常是空的**，
 * 拿不到远端哈希。此时唯一的真校验途径是把远端文件拉回来重算——
 * 那是与文件大小成正比的下行流量。
 *
 * 因此这里加了一道闸：`verifyHashMaxBytes`。
 * 超过此值的文件只做大小校验，并在结果里注明哈希校验被跳过；
 * 绝不能因为「拿不到哈希」就悄悄当作通过——那等于没校验。
 */

export interface VerifyOptions {
  client: OpenListClient
  remotePath: string
  /** 本地文件的期望值 */
  expectedSize: number
  /** 本地已算好的哈希；有则复用，避免重复读盘 */
  expectedMd5?: string
  expectedSha1?: string
  mode: VerifyMode
  /** 允许下载远端重算哈希的体积上限（字节）；0 表示禁止 */
  verifyHashMaxBytes: number
}

export async function verifyRemote(opts: VerifyOptions): Promise<VerifyResult> {
  const { client, remotePath, expectedSize, mode } = opts

  if (mode === 'none') {
    return { ok: true, mode, expected: expectedSize, actual: null }
  }

  // 取远端元信息。拿不到就判失败——「无法确认」不等于「确认无误」。
  //
  // ⚠️ 但必须**等远端可见**再判：夸克驱动下 PUT 返回 200 后，
  // 文件要过约 1 秒才能被 stat 查到。这段窗口里 stat 返回「不存在」，
  // 若直接判失败，就是把一次成功的上传误判成失败，
  // 上层会无谓地重试三次并最终标红。
  let meta: Awaited<ReturnType<OpenListClient['stat']>>
  try {
    meta = await client.statWhenVisible(remotePath)
  } catch (err) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: null,
      detail: `无法获取远端元信息：${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (!meta) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: null,
      detail: '远端未返回该路径的元信息'
    }
  }

  // 远端不存在，或大小对不上
  if (meta.size !== expectedSize) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: meta.size,
      detail: `远端大小 ${meta.size} 与本地 ${expectedSize} 不一致`
    }
  }

  if (mode === 'size') {
    return { ok: true, mode, expected: expectedSize, actual: meta.size }
  }

  // ── hash 模式 ────────────────────────────────────────
  // 先看驱动有没有给远端哈希（部分驱动会给）。
  const remoteHash = pickHash(meta.hashInfo, opts.expectedMd5, opts.expectedSha1)
  if (remoteHash) {
    const local = opts.expectedMd5 ?? ''
    if (local && remoteHash.md5 && remoteHash.md5 !== local) {
      return {
        ok: false,
        mode,
        expected: expectedSize,
        actual: meta.size,
        detail: `远端 MD5 ${remoteHash.md5} 与本地 ${local} 不一致`
      }
    }
    if (opts.expectedSha1 && remoteHash.sha1 && remoteHash.sha1 !== opts.expectedSha1) {
      return {
        ok: false,
        mode,
        expected: expectedSize,
        actual: meta.size,
        detail: `远端 SHA1 ${remoteHash.sha1} 与本地 ${opts.expectedSha1} 不一致`
      }
    }
    return { ok: true, mode, expected: expectedSize, actual: meta.size }
  }

  // 驱动没给哈希 → 只能下载重算。
  if (opts.verifyHashMaxBytes <= 0 || expectedSize > opts.verifyHashMaxBytes) {
    return {
      ok: true,
      mode,
      expected: expectedSize,
      actual: meta.size,
      detail: `远端未提供哈希，且文件超过深度校验上限（${opts.verifyHashMaxBytes} 字节），仅校验大小`
    }
  }

  let computed: Awaited<ReturnType<OpenListClient['hashRemote']>>
  try {
    computed = await client.hashRemote(remotePath)
  } catch (err) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: meta.size,
      detail: `深度校验失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (!computed) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: meta.size,
      detail: '深度校验失败：无法下载远端文件'
    }
  }
  if (computed.size !== expectedSize) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: computed.size,
      detail: `下载重算后大小 ${computed.size} 与本地 ${expectedSize} 不一致`
    }
  }
  if (opts.expectedMd5 && computed.md5 !== opts.expectedMd5) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: computed.size,
      detail: `下载重算后 MD5 ${computed.md5} 与本地 ${opts.expectedMd5} 不一致`
    }
  }
  if (opts.expectedSha1 && computed.sha1 !== opts.expectedSha1) {
    return {
      ok: false,
      mode,
      expected: expectedSize,
      actual: computed.size,
      detail: `下载重算后 SHA1 ${computed.sha1} 与本地 ${opts.expectedSha1} 不一致`
    }
  }

  return { ok: true, mode, expected: expectedSize, actual: computed.size }
}

/**
 * 从驱动的 hash_info 里挑出 MD5 / SHA1。
 *
 * OpenList 的 HashInfo 是 `{name, size, hash}` 结构，
 * 但部分驱动直接塞字符串；两种都要认。
 * 键名大小写不一（"MD5" / "md5" / "SHA-1" / "sha1"），统一归一化。
 */
function pickHash(
  hashInfo: Record<string, { name?: string; size?: number; hash?: string } | string> | undefined,
  wantMd5?: string,
  wantSha1?: string
): { md5?: string; sha1?: string } | null {
  if (!hashInfo) return null
  const out: { md5?: string; sha1?: string } = {}

  for (const [rawKey, value] of Object.entries(hashInfo)) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '')
    const hash =
      typeof value === 'string' ? value : (value?.hash ?? '')

    if (!hash) continue

    if (key.includes('md5')) {
      out.md5 = hash.toLowerCase()
    } else if (key.includes('sha1')) {
      out.sha1 = hash.toLowerCase()
    }
  }

  if (!out.md5 && !out.sha1) return null
  // 只有在确实拿到了我们关心的那个哈希时才认为可用
  if (wantMd5 && !out.md5 && !out.sha1) return null
  if (wantSha1 && !out.md5 && !out.sha1) return null
  return out
}
