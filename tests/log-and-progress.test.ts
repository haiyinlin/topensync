import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'

/**
 * 本轮三项改造的契约测试：
 * 1. 日志带类别与文件路径（上传/下载/跳过都要能查得到）
 * 2. 扫描进度能被读取与推送
 * 3. 可信度标记可按维度筛出
 */

/** 模拟渲染进程拿到的那份日志结构 */
interface LogRow {
  ts: number
  level: string
  message: string
  category: string
  filePath: string | null
  remotePath: string | null
}

describe('日志的类别与文件信息', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-log-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('日志写入时带上类别与文件路径', () => {
    manifest.log('info', '已上传 a.txt → /remote/a.txt', undefined, '/remote/a.txt', {
      category: 'upload',
      filePath: 'a.txt'
    })

    const logs = manifest.recentLogs(10) as LogRow[]
    expect(logs).toHaveLength(1)
    expect(logs[0].category).toBe('upload')
    expect(logs[0].filePath).toBe('a.txt')
    expect(logs[0].remotePath).toBe('/remote/a.txt')
  })

  it('没传类别时默认归为系统级', () => {
    manifest.log('info', '连接已建立')
    const logs = manifest.recentLogs(10) as LogRow[]
    expect(logs[0].category).toBe('system')
    expect(logs[0].filePath).toBeNull()
  })

  it('上传、下载、跳过三类能分开统计', () => {
    manifest.log('info', '已上传 a.txt', undefined, '/r/a.txt', {
      category: 'upload',
      filePath: 'a.txt'
    })
    manifest.log('info', '已下载 b.txt', undefined, '/r/b.txt', {
      category: 'download',
      filePath: 'b.txt'
    })
    manifest.log('info', '跳过 c.txt', undefined, null, {
      category: 'skip',
      filePath: 'c.txt'
    })

    const logs = manifest.recentLogs(10) as LogRow[]
    const byCategory = (c: string): LogRow[] => logs.filter((l) => l.category === c)

    expect(byCategory('upload')).toHaveLength(1)
    expect(byCategory('download')).toHaveLength(1)
    expect(byCategory('skip')).toHaveLength(1)
    // 每一类都要带上自己的文件路径
    expect(byCategory('upload')[0].filePath).toBe('a.txt')
    expect(byCategory('download')[0].filePath).toBe('b.txt')
    expect(byCategory('skip')[0].filePath).toBe('c.txt')
  })

  it('老库缺 category 列时能自动补上，且历史日志按系统级处理', () => {
    manifest.close()

    // 造一个「老库」：只有旧的列结构
    const legacy = join(dir, 'legacy.db')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(legacy)
    db.exec(`
      CREATE TABLE sync_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        file_id INTEGER,
        remote TEXT
      );
      INSERT INTO sync_log (ts, level, message) VALUES (1, 'info', '旧日志');
    `)
    db.close()

    const m2 = new Manifest(legacy)
    const logs = m2.recentLogs(10) as LogRow[]
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe('旧日志')
    expect(logs[0].category).toBe('system')
    // 补完列之后新日志也能带类别
    m2.log('info', '新日志', undefined, null, { category: 'upload', filePath: 'x.txt' })
    expect((m2.recentLogs(10) as LogRow[])[0].category).toBe('upload')
    m2.close()
  })

  it('清空日志只清日志，不动文件清单', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 100 })
    manifest.log('info', '一条日志', undefined, null, { category: 'upload' })
    expect(manifest.clearLogs()).toBe(1)
    expect(manifest.recentLogs(10)).toHaveLength(0)
    expect(manifest.getFile('a.txt')).not.toBeNull()
  })
})

describe('可信度筛选', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-verify-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('认领出来的文件是「仅大小」，且哈希基准保持为空', () => {
    manifest.upsertFile({ localPath: 'adopted.txt', localSize: 22, mtimeMs: 100 })
    manifest.adoptRemote({
      localPath: 'adopted.txt',
      localSize: 22,
      mtimeMs: 100,
      remotePath: '/r/adopted.txt',
      remoteSize: 22
    })

    const entry = manifest.getFile('adopted.txt')
    expect(entry?.verifyLevel).toBe('size')
    // 没校验内容就不能谎称哈希确认
    expect(entry?.syncedMd5).toBeNull()
    expect(entry?.syncedSha1).toBeNull()
  })

  it('深度校验通过后升级为「哈希确认」', () => {
    manifest.upsertFile({ localPath: 'a.txt', localSize: 22, mtimeMs: 100 })
    manifest.adoptRemote({
      localPath: 'a.txt',
      localSize: 22,
      mtimeMs: 100,
      remotePath: '/r/a.txt',
      remoteSize: 22
    })
    expect(manifest.getFile('a.txt')?.verifyLevel).toBe('size')

    manifest.promoteToHashVerified('a.txt', 'a'.repeat(32), 'b'.repeat(40), 22)
    const entry = manifest.getFile('a.txt')
    expect(entry?.verifyLevel).toBe('hash')
    expect(entry?.syncedMd5).toBe('a'.repeat(32))
  })

  it('三类可信度能分别筛出来', () => {
    // 哈希确认
    manifest.upsertFile({ localPath: 'h.txt', localSize: 5, mtimeMs: 100 })
    manifest.setState('h.txt', 'synced', {
      remoteSize: 5,
      syncedSize: 5,
      syncedMtimeMs: 100,
      syncedMd5: 'a'.repeat(32),
      syncedSha1: 'b'.repeat(40)
    })
    // 仅大小
    manifest.upsertFile({ localPath: 's.txt', localSize: 5, mtimeMs: 100 })
    manifest.adoptRemote({
      localPath: 's.txt',
      localSize: 5,
      mtimeMs: 100,
      remotePath: '/r/s.txt',
      remoteSize: 5
    })
    // 未标记
    manifest.upsertFile({ localPath: 'u.txt', localSize: 5, mtimeMs: 100 })

    const files = manifest.listFiles({ limit: 100 })
    const byVerify = (level: string): string[] =>
      files.filter((f) => f.verifyLevel === level).map((f) => f.localPath)

    expect(byVerify('hash')).toEqual(['h.txt'])
    expect(byVerify('size')).toEqual(['s.txt'])
    expect(byVerify(null)).toEqual(['u.txt'])
  })
})
