import { relative, sep } from 'path'
import { minimatch } from 'minimatch'

/**
 * 路径工具。
 *
 * 三类路径在项目里必须严格区分，混用是本项目最容易出的错：
 *
 * 1. **本地绝对路径**（`C:\Users\me\Docs\a.txt`）——只在主进程内使用。
 * 2. **本地相对路径**（`docs/a.txt`，POSIX 分隔）——清单库的主键，
 *    也作为远端路径的骨架。跨平台一致，不受盘符与大小写影响。
 * 3. **远端路径**（`/quark-backup/docs/a.txt`）——发给 OpenList 的路径，
 *    始终以 `/` 分隔、始终相对远端根。
 */

const LONG_PATH_PREFIX = '\\\\?\\'

/** Windows 上需要 \\?\ 前缀绕开 MAX_PATH 的长度阈值 */
const LONG_PATH_THRESHOLD = 240

export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 给 Windows 绝对路径加 \\?\ 前缀。
 *
 * 不加的话，超过 260 字符的路径 stat/open 都会失败（ENOENT）。
 * 只对盘符绝对路径生效；UNC 路径（\\server\share）本项目不涉及。
 */
export function toLongPath(p: string): string {
  if (!isWindows()) return p
  if (p.startsWith(LONG_PATH_PREFIX)) return p
  if (!/^[A-Za-z]:[\\/]/.test(p)) return p
  if (p.length < LONG_PATH_THRESHOLD) return p
  return LONG_PATH_PREFIX + p.replace(/\//g, '\\')
}

/** 本地绝对路径 → 相对同步根的 POSIX 路径；不在根内则返回 null */
export function relativize(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (rel === '') return ''
  if (rel.startsWith('..')) return null
  return rel.split(sep).join('/')
}

/** 相对路径 → 本地绝对路径 */
export function absolutize(root: string, rel: string): string {
  const parts = rel.split('/').filter(Boolean)
  if (parts.length === 0) return root
  return root + sep + parts.join(sep)
}

/** 远端根 + 相对路径 → 远端绝对路径 */
export function joinRemote(remoteRoot: string, rel: string): string {
  const base = remoteRoot.replace(/\/+$/, '')
  const clean = rel.replace(/^\/+/, '')
  return clean ? `${base}/${clean}` : base
}

/** 远端绝对路径 → 相对远程根的路径 */
export function relativizeRemote(remoteRoot: string, remotePath: string): string {
  const base = remoteRoot.replace(/\/+$/, '')
  if (remotePath === base) return ''
  if (!remotePath.startsWith(`${base}/`)) return remotePath
  return remotePath.slice(base.length + 1)
}

/**
 * 判断相对路径是否命中排除规则。
 *
 * 规则既可能针对完整路径（`**\/node_modules/**`），也可能只针对文件名
 * （`~$*`），两种都要匹配，否则 `~$xxx.docx` 这类 Office 临时文件
 * 会在子目录里漏网。
 */
export function isExcluded(rel: string, patterns: string[]): boolean {
  if (patterns.length === 0 || rel === '') return false
  const base = rel.split('/').pop() ?? rel
  return patterns.some((p) => {
    if (!p) return false
    try {
      return minimatch(rel, p, { dot: true }) || minimatch(base, p, { dot: true })
    } catch {
      // 规则写坏了也不能让整个扫描崩掉，按不排除处理
      return false
    }
  })
}

/**
 * 需要整体忽略的目录名（隐藏目录、回收站、系统卷等）。
 *
 * 匹配的是**路径段**，不是任意位置出现该字符串——
 * 否则 `C:\Users\me\.config` 整个目录都会被跳过。
 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information'
])

export function hasIgnoredSegment(rel: string): boolean {
  for (const seg of rel.split('/')) {
    if (seg === '') continue
    if (IGNORED_SEGMENTS.has(seg)) return true
    // 隐藏目录与以 ~ 开头的临时目录
    if (seg.startsWith('.')) return true
    if (seg.startsWith('~')) return true
  }
  return false
}

/**
 * 远端路径转义。
 *
 * Windows 本地文件名合法，但夸克侧对某些字符更严格。
 * 本项目在远端路径上把 Windows 上不可能出现的分隔符类字符替换掉，
 * 并保留原始名映射在清单里（remote_path 字段即映射）。
 */
const REMOTE_ILLEGAL = /[\\:*?"<>|]/g

export function escapeRemoteSegment(name: string): string {
  return name.replace(REMOTE_ILLEGAL, '_')
}
