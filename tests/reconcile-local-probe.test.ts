import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Reconciler } from '../src/main/reconcile/reconciler'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * 「远端有、清单没记」不等于「仅远端存在」。
 *
 * 背景：全新环境首次运行时清单是空的，本地文件却实实在在躺在那儿
 * （可能正排队等着上传，或刚传完还没落库）。这时对账若把它判成
 * remote_only，会出两个坏结果：
 *
 * 1. 界面上冒出一堆假差异
 * 2. 用户照着提示点「移入回收站」→ 把好好的远端文件删了
 *
 * 第二个是真实发生过的：试运行日志里
 * 「已移入回收站：/qh/topensync-demo/文档/需求记录.md」就是这么来的。
 */

const CONFIG: AppConfig = {
  syncRoot: '',
  openlist: { baseUrl: 'http://127.0.0.1:5244', username: 'u', password: 'p' },
  remoteRoot: '/quark-backup',
  hashConcurrency: 2,
  uploadConcurrency: 2,
  singlePutMaxBytes: 8 * 1024 * 1024,
  chunkConcurrency: 2,
  deletePolicy: 'trash',
  trashRoot: '_trash',
  maxDeletesPerRun: 200,
  maxDeleteBytesPerRun: 10 * 1024 * 1024 * 1024,
  retry: { maxAttempts: 3, baseDelayMs: 10 },
  exclude: [],
  verifyMode: 'size',
  verifyHashMaxBytes: 64 * 1024 * 1024,
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  syncEmptyDirs: false,
  detectRenames: false,
  renameWindowMs: 5000,
  remoteScan: {
    enabled: true,
    intervalHours: 6,
    onStartup: false,
    refresh: true,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20,
    exclude: []
  }
}

describe('对账：清单没记录 ≠ 本地没有', () => {
  let dir: string
  let manifest: Manifest

  /** 造一个「本地存在」探针；大小与远端一致时会被认领 */
  function localExists(
    paths: Record<string, number> | ((relPath: string) => number | null)
  ): (relPath: string) => { size: number; mtimeMs: number } | null {
    return (relPath: string) => {
      const size =
        typeof paths === 'function' ? paths(relPath) : (paths[relPath] ?? null)
      if (size === null) return null
      return { size, mtimeMs: 1_700_000_000_000 }
    }
  }

  function makeClient(
    tree: Record<string, { name: string; isDir: boolean; size?: number }[]>
  ): OpenListClient {
    const list = vi.fn().mockImplementation(async (path: string) => {
      const entries = tree[path] ?? []
      return {
        content: entries.map((e) => ({
          name: e.name,
          size: e.size ?? 10,
          modified: '2026-01-01T00:00:00Z',
          isDir: e.isDir
        })),
        total: entries.length,
        provider: 'mock'
      }
    })
    return { list } as unknown as OpenListClient
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-recon-local-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
  })

  afterEach(() => {
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('本地确实存在该文件 → 不产生 remote_only 差异', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      // 本地有这个文件（正在排队上传，清单里还没记）
      probeLocal: localExists({ 'a.txt': 10 })
    })

    const res = await rec.runNow()

    expect(res.scannedFiles).toBe(1)
    // 关键断言：不能判成「仅远端存在」
    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.filter((d) => d.kind === 'remote_only')).toHaveLength(0)
  })

  it('本地确实没有该文件 → 仍然判成 remote_only', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: () => null
    })

    const res = await rec.runNow()

    expect(res.diffCount).toBe(1)
    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.filter((d) => d.kind === 'remote_only')).toHaveLength(1)
    expect(diffs[0].remotePath).toBe('/quark-backup/a.txt')
  })

  it('没有 probeLocal 回调 → 保持旧行为（判成 remote_only）', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false }]
    })

    const rec = new Reconciler({ client, manifest, config: CONFIG })

    const res = await rec.runNow()

    expect(res.diffCount).toBe(1)
    expect(manifest.listUnresolvedDiffs().filter((d) => d.kind === 'remote_only')).toHaveLength(1)
  })

  it('本地存在的文件不会触发远端删除策略', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'keep.txt', isDir: false }]
    })
    const remove = vi.fn()

    const rec = new Reconciler({
      client: { ...client, remove } as unknown as OpenListClient,
      manifest,
      config: { ...CONFIG, remoteScan: { ...CONFIG.remoteScan, remoteOnlyPolicy: 'delete' } },
      probeLocal: localExists({ 'keep.txt': 10 })
    })

    await rec.runNow()

    // 绝不能因为假差异去删远端文件
    expect(remove).not.toHaveBeenCalled()
  })

  it('混合场景：本地有的不算差异，本地没有的照常算', async () => {
    const client = makeClient({
      '/quark-backup': [
        { name: 'pending.txt', isDir: false },
        { name: 'orphan.txt', isDir: false }
      ]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: localExists({ 'pending.txt': 10 })
    })

    await rec.runNow()

    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs).toHaveLength(1)
    expect(diffs[0].remotePath).toBe('/quark-backup/orphan.txt')
  })

  it('嵌套目录里本地存在的文件同样不算差异', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'sub', isDir: true }],
      '/quark-backup/sub': [{ name: 'deep.txt', isDir: false }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: localExists({ 'sub/deep.txt': 10 })
    })

    const res = await rec.runNow()

    expect(res.scannedFiles).toBe(1)
    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
  })

  it('OpenList 的 .openlist_to_delete 标记文件不参与比对', async () => {
    const client = makeClient({
      '/quark-backup': [
        { name: 'a.txt', isDir: false },
        { name: 'a.txt.openlist_to_delete', isDir: false }
      ]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: () => null
    })

    const res = await rec.runNow()

    // 标记文件不计数、不产生差异
    expect(res.scannedFiles).toBe(1)
    const diffs = manifest.listUnresolvedDiffs()
    expect(diffs.filter((d) => d.kind === 'remote_only')).toHaveLength(1)
    expect(diffs[0].remotePath).toBe('/quark-backup/a.txt')
  })

  it('只有标记文件时不会产生任何差异', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'gone.txt.openlist_to_delete', isDir: false }]
    })

    const rec = new Reconciler({
      client,
      manifest,
      config: CONFIG,
      probeLocal: () => null
    })

    const res = await rec.runNow()

    expect(res.scannedFiles).toBe(0)
    expect(res.diffCount).toBe(0)
    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
  })

  it('仅修改时间不同不再列为差异', async () => {
    const client = makeClient({
      '/quark-backup': [{ name: 'a.txt', isDir: false }]
    })

    // 清单里已有一条「已同步」记录，远端时间与本地差很多
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: 10,
      mtimeMs: 1_600_000_000_000,
      remotePath: '/quark-backup/a.txt',
      state: 'synced'
    })
    manifest.setState('a.txt', 'synced', {
      remoteSize: 10,
      syncedSize: 10,
      syncedMtimeMs: 1_600_000_000_000
    })

    const rec = new Reconciler({ client, manifest, config: CONFIG })

    const res = await rec.runNow()

    // 大小一致就该没有差异——时间不同不再单独报
    expect(res.diffCount).toBe(0)
    expect(manifest.listUnresolvedDiffs()).toHaveLength(0)
  })
})
