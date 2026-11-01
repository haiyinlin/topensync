import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner } from '../src/main/planner/planner'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig } from '../src/shared/types'

/**
 * Planner 的行为测试。
 *
 * 核心要验证的是「省上行」这条主线：
 * 文件没变 → **一次网络请求都不该发**。
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
  exclude: ['**/node_modules/**'],
  verifyMode: 'size',
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  remoteScan: {
    enabled: true,
    intervalHours: 6,
    onStartup: false,
    refresh: true,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20
  }
}

/** 让异步流水线跑完 */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('Planner', () => {
  let dir: string
  let syncRoot: string
  let manifest: Manifest
  let upload: ReturnType<typeof vi.fn>
  let planner: Planner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-planner-'))
    syncRoot = join(dir, 'sync')
    rmSync(syncRoot, { recursive: true, force: true })
    // syncRoot 由 handleEvent 内部读取，这里只需要它存在
    require('fs').mkdirSync(syncRoot, { recursive: true })

    manifest = new Manifest(join(dir, 'manifest.db'))
    upload = vi.fn().mockResolvedValue({ ok: true })

    const transfer = { upload } as unknown as Transfer
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    } as unknown as OpenListClient

    planner = new Planner({
      manifest,
      transfer,
      client,
      getConfig: () => ({ ...CONFIG, syncRoot })
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件未变化时完全不上传（L1 去重命中）', async () => {
    const p = join(syncRoot, 'a.txt')
    writeFileSync(p, 'hello')
    const st = statSync(p)

    // 造一条「上次已同步」的记录，size/mtime 与当前一致
    manifest.upsertFile({
      localPath: 'a.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('a.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs)
    })

    await planner.handleEvent('a.txt', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()
    expect(planner.skippedCount).toBe(1)
  })

  it('文件从未同步过时会上传', async () => {
    const p = join(syncRoot, 'b.txt')
    writeFileSync(p, 'world')

    await planner.handleEvent('b.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toMatchObject({
      relPath: 'b.txt',
      remotePath: '/quark-backup/b.txt'
    })
  })

  it('文件内容变化后（mtime 变）会重新上传', async () => {
    const p = join(syncRoot, 'c.txt')
    writeFileSync(p, 'v1')
    const st = statSync(p)

    manifest.upsertFile({
      localPath: 'c.txt',
      localSize: st.size,
      mtimeMs: st.mtimeMs,
      state: 'synced'
    })
    manifest.setState('c.txt', 'synced', {
      remoteSize: st.size,
      syncedSize: st.size,
      syncedMtimeMs: Math.floor(st.mtimeMs)
    })

    // 改内容 → size 与 mtime 都变
    writeFileSync(p, 'v2-longer')
    await planner.handleEvent('c.txt', true)
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('命中排除规则的文件不上传', async () => {
    const p = join(syncRoot, 'node_modules', 'pkg', 'x.js')
    require('fs').mkdirSync(join(syncRoot, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(p, 'x')

    await planner.handleEvent('node_modules/pkg/x.js', true)
    await settle()

    expect(upload).not.toHaveBeenCalled()
  })

  it('对账发现远端缺失时回流重传', async () => {
    const p = join(syncRoot, 'd.txt')
    writeFileSync(p, 'data')

    await planner.handleDiff({
      kind: 'missing_remote',
      localPath: 'd.txt',
      remotePath: '/quark-backup/d.txt'
    })
    await settle()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toMatchObject({ relPath: 'd.txt' })
  })

  it('对账发现仅远端存在时不动作', async () => {
    await planner.handleDiff({
      kind: 'remote_only',
      localPath: null,
      remotePath: '/quark-backup/other.txt'
    })
    await settle()

    expect(upload).not.toHaveBeenCalled()
  })

  it('冲突策略为「全部交由我确认」时不自动重传', async () => {
    const p = join(syncRoot, 'e.txt')
    writeFileSync(p, 'data')

    const manual = new Planner({
      manifest,
      transfer: { upload } as unknown as Transfer,
      client: { mkdir: vi.fn(), move: vi.fn(), remove: vi.fn() } as unknown as OpenListClient,
      getConfig: () => ({
        ...CONFIG,
        syncRoot,
        remoteScan: { ...CONFIG.remoteScan, conflictPolicy: 'manual' }
      })
    })
    manual.start()

    await manual.handleDiff({
      kind: 'missing_remote',
      localPath: 'e.txt',
      remotePath: '/quark-backup/e.txt'
    })
    await settle()

    expect(upload).not.toHaveBeenCalled()
    manual.stop()
  })
})
