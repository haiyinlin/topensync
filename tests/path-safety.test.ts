import { describe, expect, it } from 'vitest'
import { join } from 'path'
import {
  absolutize,
  relativize,
  stripLongPath
} from '../src/main/watcher/paths'

/**
 * 本轮代码审查发现并修复的路径类缺陷的回归测试。
 *
 * 这几个缺陷的共同特征是「症状极不明显」：
 * 文件传不上去、路径跑到同步根外面、文件被误删——
 * 界面不会报错，只是数字不对或文件不见了。
 */

describe('absolutize 拒绝路径穿越', () => {
  const root = join('C:', 'Users', 'me', 'SyncFolder')

  it('正常相对路径照常拼接', () => {
    expect(absolutize(root, 'docs/a.txt')).toBe(join(root, 'docs', 'a.txt'))
  })

  it('拒绝含 .. 的路径（不能逃出同步根）', () => {
    // 这是删除操作唯一的防线：rm 没有二次确认
    expect(() => absolutize(root, '../secret.txt')).toThrow(/越出同步根/)
    expect(() => absolutize(root, 'docs/../../secret.txt')).toThrow(/越出同步根/)
    expect(() => absolutize(root, '..')).toThrow(/越出同步根/)
  })

  it('以 .. 开头的合法文件名不被误伤', () => {
    // Windows 允许 `..foo.txt` 这种名字，不能把它当穿越
    expect(absolutize(root, '..foo.txt')).toBe(join(root, '..foo.txt'))
  })
})

describe('relativize 判定越界', () => {
  const root = join('C:', 'Users', 'me', 'SyncFolder')

  it('上一级目录判为越界', () => {
    expect(relativize(root, join('C:', 'Users', 'me', 'other'))).toBeNull()
  })

  it('以 .. 开头的合法文件名不算越界', () => {
    // 以前用 startsWith('..') 判断，会把这种合法文件静默丢弃
    expect(relativize(root, join(root, '..foo.txt'))).toBe('..foo.txt')
  })

  it('同步根本身返回空串', () => {
    expect(relativize(root, root)).toBe('')
  })
})

describe('长路径前缀（\\?\\）处理', () => {
  const root = 'C:\\Users\\me\\SyncFolder'

  it('stripLongPath 剥掉前缀', () => {
    expect(stripLongPath('\\\\?\\C:\\Users\\me\\a.txt')).toBe('C:\\Users\\me\\a.txt')
  })

  it('不带前缀的路径原样返回', () => {
    expect(stripLongPath('C:\\Users\\me\\a.txt')).toBe('C:\\Users\\me\\a.txt')
  })

  it('带前缀的绝对路径能算出正确的相对路径', () => {
    /*
     * 这是最隐蔽的一个缺陷。
     *
     * chokidar 监听的是加了 `\\?\` 前缀的路径（长路径才能绕开 MAX_PATH），
     * 它回报的事件路径也带前缀；而同步根是用户配的裸路径。
     *
     * Node 的 path.relative 把两者当成不同的根，
     * 于是 relative('C:\\Sync', '\\\\?\\C:\\Sync\\a.txt') 返回
     * **完整带前缀的路径**而不是 'a.txt'。
     *
     * 结果：relativize 返回一个畸形路径当相对路径用，
     * 文件被传到远端的一个奇怪路径下，或者直接被当成「不在根内」丢弃。
     * 触发条件：同步根路径长度 ≥ 240 字符。
     */
    const prefixed = '\\\\?\\C:\\Users\\me\\SyncFolder\\docs\\a.txt'
    expect(relativize(root, prefixed)).toBe('docs/a.txt')
  })
})
