import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'

/**
 * 「路径尾随空格导致重复上传」的回归测试。
 *
 * 实测踩过的坑：远端根配成 `/.../照片备份/公司 `（尾部一个空格），
 * 应用把整批文件传进了新建的「公司␣」目录，而用户原有的「公司」目录原封不动——
 * 夸克侧出现两个「公司」，同一批照片传了两遍。
 *
 * 界面上尾随空格完全不可见，所以只能靠代码层挡住。
 */
describe('远端根变更时的路径一致性', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-remoteroot-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function addFile(localPath: string, remotePath: string): void {
    manifest.upsertFile({
      localPath,
      localSize: 100,
      mtimeMs: 1700000000000,
      remotePath,
      state: 'synced',
      localInode: `ino-${localPath}`
    })
  }

  it('远端根变更时改写已存的 remote_path 前缀', () => {
    addFile('a.txt', '/old/root/a.txt')
    addFile('sub/b.txt', '/old/root/sub/b.txt')

    const changed = manifest.rewriteRemoteRoot('/old/root', '/new/root')

    expect(changed).toBe(2)
    const paths = manifest.listFiles({ limit: 100 }).map((f) => f.remotePath)
    expect(paths).toContain('/new/root/a.txt')
    expect(paths).toContain('/new/root/sub/b.txt')
    expect(paths.some((p) => p?.startsWith('/old/root'))).toBe(false)
  })

  it('只改写以旧根为前缀的路径，其余不动', () => {
    addFile('a.txt', '/old/root/a.txt')
    // 别的根下同步过的条目（换过同步目录的历史残留）
    addFile('other.txt', '/completely/other/other.txt')

    const changed = manifest.rewriteRemoteRoot('/old/root', '/new/root')

    expect(changed).toBe(1)
    const byPath = new Map(manifest.listFiles({ limit: 100 }).map((f) => [f.localPath, f.remotePath]))
    expect(byPath.get('a.txt')).toBe('/new/root/a.txt')
    expect(byPath.get('other.txt')).toBe('/completely/other/other.txt')
  })

  it('旧根是其它路径的前缀时不误伤', () => {
    // '/old/root' 是 '/old/root2' 的前缀，但两者是不同的目录
    addFile('x.txt', '/old/root2/x.txt')
    addFile('y.txt', '/old/root/y.txt')

    const changed = manifest.rewriteRemoteRoot('/old/root', '/new/root')

    expect(changed).toBe(1)
    const byPath = new Map(manifest.listFiles({ limit: 100 }).map((f) => [f.localPath, f.remotePath]))
    expect(byPath.get('x.txt')).toBe('/old/root2/x.txt')
    expect(byPath.get('y.txt')).toBe('/new/root/y.txt')
  })

  it('新旧根相同时不做任何改写', () => {
    addFile('a.txt', '/same/a.txt')
    expect(manifest.rewriteRemoteRoot('/same', '/same')).toBe(0)
  })

  it('尾随空格的旧根也要能改写（兼容已污染的库）', () => {
    addFile('a.txt', '/old/root /a.txt')

    const changed = manifest.rewriteRemoteRoot('/old/root ', '/old/root')

    expect(changed).toBe(1)
    const byPath = new Map(manifest.listFiles({ limit: 100 }).map((f) => [f.localPath, f.remotePath]))
    expect(byPath.get('a.txt')).toBe('/old/root/a.txt')
  })
})
