/**
 * 把原始错误翻成「人话」。
 *
 * 背景：任务列表里一个「失败」标签、日志里一行
 * `connect ECONNREFUSED 192.168.50.2:5244`——用户看完仍然
 * 不知道发生了什么、该动哪里。这类报错是给开发者看的，
 * 不是给用户看的。
 *
 * 这里只做一件事：**从错误文本里认出可识别的病因**，
 * 给出一句短标题（列表里显示）+ 一句处置建议（展开/悬浮时显示）。
 * 认不出来就老实回退到原文，绝不编造原因。
 */

export interface ErrorHint {
  /** 短标题，列表里一行放得下（尽量 ≤ 12 字） */
  brief: string
  /** 处置建议，一句话说清下一步做什么 */
  advice: string
}

interface Rule {
  /** 匹配错误文本（大小写不敏感） */
  test: RegExp
  hint: (m: RegExpMatchArray) => ErrorHint
}

/**
 * 顺序即优先级。
 *
 * 越具体的排越前：`502 upstream connect failed` 里同时含 "connect"
 * 和 "failed"，必须先被 502 规则认领，否则会被泛化的连接错误吃掉。
 */
const RULES: Rule[] = [
  // ── 服务端不可达 ──
  {
    test: /upstream connect failed|502 bad gateway/i,
    hint: () => ({
      brief: '服务端上游不可用',
      advice: '端口上的反向代理还在，但它后面的 OpenList 没启动。去服务器上把 OpenList 拉起来再重试。'
    })
  },
  {
    test: /ECONNREFUSED/i,
    hint: () => ({
      brief: '服务端拒绝连接',
      advice: 'OpenList 服务没在运行，或地址/端口填错了。先在浏览器打开 OpenList 网页确认能访问。'
    })
  },
  {
    test: /ENOTFOUND|EAI_AGAIN/i,
    hint: () => ({
      brief: '服务器地址解析失败',
      advice: 'OpenList 地址里的主机名解析不了：检查地址是否写错、本机 DNS 是否正常。'
    })
  },
  {
    test: /ETIMEDOUT|timed?\s?out|TimeoutError/i,
    hint: () => ({
      brief: '连接超时',
      advice: '网络不通或服务端卡住了。确认服务器在线、防火墙放行了该端口。'
    })
  },
  {
    test: /socket hang up|ECONNRESET|EPIPE/i,
    hint: () => ({
      brief: '连接被中断',
      advice: '传输中途连接被对端断开。网络抖动时会重试；反复出现请检查服务端日志。'
    })
  },

  // ── 本地盘 ──
  {
    test: /UNKNOWN: unknown error, open '([A-Za-z]:)/,
    hint: (m) => ({
      brief: `本地盘读取失败（${m[1].toUpperCase()}）`,
      advice: `${m[1].toUpperCase()} 盘读不到文件，常见于网络盘/移动盘掉线或休眠。把盘接好，再点「重试」。`
    })
  },
  {
    test: /EMFILE|too many open files/i,
    hint: () => ({
      brief: '本机文件句柄耗尽',
      advice: '不是文件有问题。程序会自动冷却后重试；长期出现请把上传并发调小。'
    })
  },
  {
    test: /ENOSPC/i,
    hint: () => ({ brief: '磁盘空间不足', advice: '清理空间后再重试。' })
  },
  {
    test: /EACCES|EPERM/i,
    hint: () => ({
      brief: '没有访问权限',
      advice: '文件被占用或权限不足。关闭占用它的程序，或检查目录权限。'
    })
  },
  {
    test: /ENOENT|no such file or directory/i,
    hint: () => ({
      brief: '本地文件已不存在',
      advice: '扫描之后这个文件被删除或移走了。重新扫描一次即可。'
    })
  },

  // ── 服务端语义错误 ──
  /*
   * 注意 HTTP 状态码要带上下文再匹配。
   *
   * 裸匹配 /\b401\b/ 会把路径里的 `tokenizer/401.js`、`413.mp4`
   * 之类误判成认证失败——这些错误文本里**一定带着文件路径**，
   * 所以只认 "status 401" / "[401]" / "HTTP 401" 这几种写法。
   */
  {
    test: /unauthorized|令牌(?:无效|过期|已过期)|token\s*(?:invalid|expired)|(?:status|HTTP)\s*401|\[401\]/i,
    hint: () => ({ brief: '认证失效', advice: 'OpenList 令牌无效或已过期，到设置页重新填写。' })
  },
  {
    test: /too many requests|(?:status|HTTP)\s*429|\[429\]/i,
    hint: () => ({
      brief: '服务端限流',
      advice: '请求太密被服务端挡了。把上传并发调小，或等一会儿再重试。'
    })
  },
  {
    test: /too large|超过单文件上限|(?:status|HTTP)\s*413|\[413\]/i,
    hint: () => ({ brief: '超过单文件上限', advice: '文件超出夸克允许的单文件大小，改小或拆分后再传。' })
  },
  {
    test: /file is doloading|存在同名文件/i,
    hint: () => ({
      brief: '远端同名文件正在下载',
      advice: 'OpenList 不允许覆盖正在被下载的文件。等那份下载结束，或先在远端删掉它。'
    })
  },
  {
    test: /对象不存在|object not found/i,
    hint: () => ({
      brief: '远端对象不存在',
      advice: '远端目录快照是旧的，实际文件可能还在。重新扫描远端可消除这条报错。'
    })
  },
  {
    test: /哈希期间文件已变更/,
    hint: () => ({
      brief: '文件在同步中被修改',
      advice: '算完哈希后文件又变了，下一轮扫描会自动重新排队。'
    })
  },
  {
    test: /文件句柄持续不足/,
    hint: () => ({
      brief: '本地文件句柄持续不足',
      advice: '盘可能已掉线。把盘重新连上再点「开始同步」。'
    })
  }
]

/** 认不出来时，把原文压成一行短句 */
function fallback(message: string): ErrorHint {
  const first = message.split(/[\r\n]/)[0] ?? message
  const trimmed = first.trim()
  return {
    brief: trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed || '未知错误',
    advice: trimmed || '没有拿到错误详情'
  }
}

/**
 * 解析错误文本。传入 `TransferTask.errorMsg` / `files.error_msg` /
 * 日志 message 都行——它们都是 `describeError()` 的结果。
 */
export function explainError(message: string | null | undefined): ErrorHint {
  const text = (message ?? '').trim()
  if (!text) return { brief: '未知错误', advice: '没有拿到错误详情' }

  for (const rule of RULES) {
    const m = text.match(rule.test)
    if (m) return rule.hint(m)
  }
  return fallback(text)
}

/** 只要短标题 */
export function errorBrief(message: string | null | undefined): string {
  return explainError(message).brief
}

/**
 * 这个错误是不是「服务端整体连不上」。
 *
 * 与「某个文件传失败」要分开处理：单个文件失败该重试该文件，
 * 服务端连不上则重试谁都没用——一千个文件挨个试三遍，只会把日志表
 * 刷满同一个错误，把真正有用的那几条冲掉。
 *
 * 判定要**严**：只认「连接层面根本不通」的几种。像 `ECONNRESET`
 * 这种单条连接被掐断（服务端偶尔会这样）不算整体不可用——
 * 把它算进去，网络稍微抖一下就会误触发暂停。
 *
 * 注意 502/504 算：那说明前面的反代还活着、后面的 OpenList 没起来，
 * 与 ECONNREFUSED 是同一件事的两个阶段。
 */
export function isConnectivityError(message: string | null | undefined): boolean {
  const text = (message ?? '').trim()
  if (!text) return false
  return /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|upstream connect failed|502 bad gateway|504 gateway time-?out/i.test(
    text
  )
}
