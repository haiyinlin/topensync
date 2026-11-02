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

/**
 * 剥掉 Windows 长路径前缀 `\\?\`。
 *
 * 加了前缀的路径和没加的路径在 Node 的 path API 眼里是**两个不同的根**：
 * `relative('C:\\Sync', '\\\\?\\C:\\Sync\\a.txt')` 返回的是完整带前缀的路径，
 * 而不是 `a.txt`。
 *
 * chokidar 监听的是加了前缀的路径，它回报的事件路径也带前缀；
 * 而同步根是用户配的裸路径。两边一混，相对路径就算不出来，
 * 文件会被当成「不在根内」而静默丢弃——用户表现为「文件传不上去」。
 */
export function stripLongPath(p: string): string {
  return isWindows() && p.startsWith(LONG_PATH_PREFIX) ? p.slice(LONG_PATH_PREFIX.length) : p
}

/** 本地绝对路径 → 相对同步根的 POSIX 路径；不在根内则返回 null */
export function relativize(root: string, abs: string): string | null {
  const rel = relative(stripLongPath(root), stripLongPath(abs))
  if (rel === '') return ''
  /*
   * 只在**确实是上一级**时才判为越界。
   *
   * 不能用 `startsWith('..')`：Windows 允许 `..foo.txt` 这种以两个点开头的
   * 合法文件名，它会被误判成「在根外」而静默丢弃——
   * 用户从压缩包解出来的文件就可能叫这种名字。
   * 真正的越界形态只有 `..` 和 `../xxx`。
   */
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/**
 * 相对路径 → 本地绝对路径。
 *
 * 会拒绝任何试图逃出同步根的路径（`..` 分段）。
 *
 * 为什么必须拒：调用方有 IPC 边界——渲染进程把「要删的本地文件列表」
 * 直接传进来，参数拼错或被篡改就可能指向同步根之外。
 * 而删除操作是 `rm(abs, { force: true })`，**没有二次确认的机会**。
 * 所以这里必须在拼接阶段就把越界挡掉。
 */
export function absolutize(root: string, rel: string): string {
  const parts = rel.split('/').filter(Boolean)
  if (parts.length === 0) return root
  // 任何一段是 `..` 就说明想往根外走
  if (parts.some((p) => p === '..')) {
    throw new Error(`路径越出同步根，已拒绝：${rel}`)
  }
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
 * 远端路径的父目录；根路径归一为 '/'。
 *
 * 注意与本地路径的 `dirname` 区分：远端路径一律用 '/' 分隔，
 * 且不能带上本地的盘符与反斜杠。
 */
export function remoteDirname(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

/** 远端路径的文件名 */
export function remoteBasename(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
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
 * OpenList 覆盖上传时留下的内部标记文件。
 *
 * 现象：远端目录里出现 `数据.csv.openlist_to_delete`，
 * 而 `数据.csv` 本体反而不见了（覆盖过程中旧文件被改名成标记名，
 * 新文件写完前的空窗里留下的）。
 *
 * 它不是用户的文件，是服务端的中间态。
 * 参与对账会出两样坏东西：
 * - 一条假的「仅远端存在」差异，路径还带个怪后缀
 * - 界面上「下载到本地」会下载出一个叫 `数据.csv.openlist_to_delete` 的文件
 *
 * 所以远端比对时要把它排除掉。
 */
export function isOpenListTempMarker(name: string): boolean {
  return name.endsWith('.openlist_to_delete')
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
  const segments = rel.split('/')
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === '') continue
    if (IGNORED_SEGMENTS.has(seg)) return true
    // 隐藏目录与以 ~ 开头的临时目录
    if (seg.startsWith('.')) return true
    if (seg.startsWith('~')) return true
    /*
     * 下载中间产物：`xxx.mp4.part`。
     *
     * downloadTo 会先写 `${本地路径}.part`，成功后才 rename 成正式名。
     * 这个文件落在**同步根里**，而 watcher 的 awaitWriteFinish 只要求
     * 2 秒内没有新写入——大文件下载遇上网络停顿超过 2 秒，
     * 就会被当成「新文件」哈希并上传，远端多出一个半截的 .part。
     *
     * 只查最后一段：目录名里带 .part 的情况不存在，
     * 而前面的路径段已经在循环里判过了。
     */
    if (i === segments.length - 1 && seg.endsWith('.part')) return true
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
