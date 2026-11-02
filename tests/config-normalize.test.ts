import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppConfig } from '../src/shared/types'

/**
 * 路径归一化的回归测试。
 *
 * 实测踩过的坑：远端根配成 `/.../照片备份/公司 `（尾部一个空格），
 * 应用把整批文件传进了新建的「公司␣」目录，用户原有的「公司」目录原封不动——
 * 夸克侧出现两个「公司」，同一批照片传了两遍。
 *
 * 界面上尾随空格完全不可见，只能在代码层挡住。
 */
const userDataDir = mkdtempSync(join(tmpdir(), 'topensync-cfg-'))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir())
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

const { normalizeConfig, DEFAULT_CONFIG } = await import('../src/main/config/store')

function baseConfig(patch: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULT_CONFIG, ...patch }
}

describe('路径归一化', () => {
  it('去掉远端根路径的首尾空白', () => {
    const cfg = normalizeConfig(
      baseConfig({ remoteRoot: '/qh/qh/download/photo/照片备份/公司 ' })
    )
    expect(cfg.remoteRoot).toBe('/qh/qh/download/photo/照片备份/公司')
  })

  it('去掉本地同步目录的首尾空白', () => {
    const cfg = normalizeConfig(baseConfig({ syncRoot: 'Z:\\download\\photo\\照片备份\\公司  ' }))
    expect(cfg.syncRoot).toBe('Z:\\download\\photo\\照片备份\\公司')
  })

  it('去掉回收站目录与 OpenList 地址的首尾空白', () => {
    const cfg = normalizeConfig(
      baseConfig({
        trashRoot: ' _trash ',
        openlist: {
          baseUrl: ' http://192.168.100.10:5244 ',
          username: ' admin ',
          password: 'secret'
        }
      })
    )
    expect(cfg.trashRoot).toBe('_trash')
    expect(cfg.openlist.baseUrl).toBe('http://192.168.100.10:5244')
    expect(cfg.openlist.username).toBe('admin')
  })

  it('不改动路径内部的空格（那是合法的目录名）', () => {
    const cfg = normalizeConfig(
      baseConfig({ remoteRoot: '/qh/qh/download/photo/照片备份/公 司/子目录' })
    )
    expect(cfg.remoteRoot).toBe('/qh/qh/download/photo/照片备份/公 司/子目录')
  })

  it('归一化不丢其它配置项', () => {
    const cfg = normalizeConfig(
      baseConfig({
        remoteRoot: '  /root  ',
        hashConcurrency: 7,
        deletePolicy: 'keep'
      })
    )
    expect(cfg.hashConcurrency).toBe(7)
    expect(cfg.deletePolicy).toBe('keep')
  })

  it('空路径归一化后仍是空字符串', () => {
    const cfg = normalizeConfig(baseConfig({ syncRoot: '', remoteRoot: '   ' }))
    expect(cfg.syncRoot).toBe('')
    expect(cfg.remoteRoot).toBe('')
  })
})
