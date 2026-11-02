import { describe, expect, it } from 'vitest'
import { join } from 'path'
import {
  absolutize,
  escapeRemoteSegment,
  hasIgnoredSegment,
  getExcludeMatcher,
  isExcluded,
  joinRemote,
  relativize,
  relativizeRemote
} from '../src/main/watcher/paths'

/**
 * 路径工具的契约测试。
 *
 * 这几个函数错一个地方，清单主键、远端路径、排除规则就会同时跑偏，
 * 而且症状是「文件莫名不传」，很难定位。
 */

describe('relativize', () => {
  const root = join('C:', 'Users', 'me', 'SyncFolder')

  it('转成 POSIX 相对路径', () => {
    expect(relativize(root, join(root, 'docs', 'a.txt'))).toBe('docs/a.txt')
  })

  it('根目录本身返回空串', () => {
    expect(relativize(root, root)).toBe('')
  })

  it('不在根目录内返回 null', () => {
    expect(relativize(root, join('C:', 'Users', 'me', 'Other'))).toBeNull()
  })
})

describe('absolutize', () => {
  it('相对路径还原为本地绝对路径', () => {
    const root = join('C:', 'Sync')
    expect(absolutize(root, 'docs/a.txt')).toBe(join(root, 'docs', 'a.txt'))
  })

  it('空相对路径回到根目录', () => {
    const root = join('C:', 'Sync')
    expect(absolutize(root, '')).toBe(root)
  })
})

describe('joinRemote', () => {
  it('拼接远端根与相对路径', () => {
    expect(joinRemote('/quark-backup', 'docs/a.txt')).toBe('/quark-backup/docs/a.txt')
  })

  it('去掉远端根尾部多余斜杠', () => {
    expect(joinRemote('/quark-backup/', 'a.txt')).toBe('/quark-backup/a.txt')
  })

  it('相对路径为空时只返回远端根', () => {
    expect(joinRemote('/quark-backup', '')).toBe('/quark-backup')
  })
})

describe('relativizeRemote', () => {
  it('剥掉远端根前缀', () => {
    expect(relativizeRemote('/quark-backup', '/quark-backup/docs/a.txt')).toBe('docs/a.txt')
  })

  it('不在远端根下时原样返回', () => {
    expect(relativizeRemote('/quark-backup', '/other/a.txt')).toBe('/other/a.txt')
  })
})

describe('isExcluded', () => {
  const rules = ['**/node_modules/**', '**/.git/**', '**/*.tmp', '~$*']

  it('命中目录规则', () => {
    expect(isExcluded('node_modules/pkg/index.js', rules)).toBe(true)
    expect(isExcluded('a/b/node_modules/pkg/index.js', rules)).toBe(true)
  })

  it('命中后缀规则', () => {
    expect(isExcluded('a/b/c.tmp', rules)).toBe(true)
  })

  it('Office 临时文件在子目录里也能命中（只匹配文件名）', () => {
    expect(isExcluded('docs/~$report.docx', rules)).toBe(true)
  })

  it('普通文件不命中', () => {
    expect(isExcluded('docs/report.docx', rules)).toBe(false)
  })

  it('规则为空时不排除任何东西', () => {
    expect(isExcluded('node_modules/x.js', [])).toBe(false)
  })

  it('规则写坏时不崩溃，也不排除', () => {
    expect(isExcluded('a.txt', ['['])).toBe(false)
  })

  /*
   * 预编译匹配器的正确性。
   *
   * 这批断言存在的意义：预编译把 minimatch 的「每次调用都解析 glob」
   * 改成「一组规则只解析一次」，是纯性能改造——**语义必须一模一样**。
   * 少匹配一条，被排除的临时文件就会开始上传；
   * 多匹配一条，用户该同步的文件会被静默跳过。
   */
  it('预编译后与逐次匹配结果一致', () => {
    const cases = [
      'node_modules/pkg/index.js',
      'a/b/node_modules/pkg/index.js',
      'a/b/c.tmp',
      'docs/~$report.docx',
      'docs/report.docx',
      'a.txt',
      '.git/config',
      'src/.gitignore'
    ]
    const matcher = getExcludeMatcher(rules)
    for (const p of cases) {
      expect(matcher.test(p)).toBe(isExcluded(p, rules))
    }
  })

  it('同一组规则复用同一个匹配器（不重复解析）', () => {
    const a = getExcludeMatcher(['**/*.tmp'])
    const b = getExcludeMatcher(['**/*.tmp'])
    expect(a).toBe(b)
    // 规则变了就该换一个
    expect(getExcludeMatcher(['**/*.log'])).not.toBe(a)
  })
})

describe('hasIgnoredSegment', () => {
  it('跳过隐藏目录', () => {
    expect(hasIgnoredSegment('.git/config')).toBe(true)
  })

  it('跳过回收站与系统卷', () => {
    expect(hasIgnoredSegment('$RECYCLE.BIN/x')).toBe(true)
    expect(hasIgnoredSegment('System Volume Information/x')).toBe(true)
  })

  it('跳过以 ~ 开头的临时目录', () => {
    expect(hasIgnoredSegment('~tmp/x')).toBe(true)
  })

  it('不误伤名字里含点的普通目录', () => {
    expect(hasIgnoredSegment('my.docs/a.txt')).toBe(false)
  })

  it('普通路径不忽略', () => {
    expect(hasIgnoredSegment('docs/a.txt')).toBe(false)
  })
})

describe('escapeRemoteSegment', () => {
  it('替换远端不允许的字符', () => {
    expect(escapeRemoteSegment('a:b*c?d')).toBe('a_b_c_d')
  })

  it('正常文件名不变', () => {
    expect(escapeRemoteSegment('报告 2026.pdf')).toBe('报告 2026.pdf')
  })
})
