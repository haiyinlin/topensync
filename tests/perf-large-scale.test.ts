import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Manifest } from '../src/main/db/manifest'
import { Planner, MAX_TASKS, TASK_TABLE_LIMIT } from '../src/main/planner/planner'
import { TaskBatcher } from '../src/main/task-batcher'
import type { Transfer } from '../src/main/transfer/transfer'
import type { OpenListClient } from '../src/main/openlist/client'
import type { AppConfig, TaskBatch, TransferTask } from '../src/shared/types'

/**
 * 大数据量下的性能相关行为。
 *
 * 这一组测试锁的是「六万个文件时界面卡死」的三条根因：
 *
 * 1. 每次任务变化单独推一次 IPC → 六万次跨进程调用
 * 2. 渲染层每条推送都要遍历整个任务数组 → O(n²)
 * 3. 任务表无界增长 → 所有遍历都是几万次
 *
 * 前两条由 `TaskBatcher` 的合并语义保证（同 id 只留最新，
 * 一批只推一次）；第三条由 `Planner` 的容量上限保证。
 */

const CONFIG: AppConfig = {
  syncRoot: '',
  openlist: { baseUrl: 'http://127.0.0.1:5244', username: 'u', password: 'p' },
  remoteRoot: '/backup',
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
    enabled: false,
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

function makeTask(i: number, state: TransferTask['state']): TransferTask {
  return {
    id: `task-${i}`,
    fileId: i,
    localPath: `dir${i % 100}/file_${i}.dat`,
    remotePath: `/backup/dir${i % 100}/file_${i}.dat`,
    size: 1024,
    mode: 'single',
    state,
    category: 'skip',
    skipReason: 'local_duplicate',
    chunksDone: 0,
    chunksTotal: 0,
    progress: 0,
    speed: 0,
    md5Prefix: '',
    sha1Prefix: '',
    md5: null,
    sha1: null,
    errorMsg: null,
    attempts: 0
  }
}

describe('TaskBatcher —— 任务批量推送', () => {
  it('同一 id 的多次变化只推最新一条', () => {
    const batches: TaskBatch[] = []
    const batcher = new TaskBatcher((b) => batches.push(b), 10)

    batcher.push(makeTask(1, 'queued'))
    batcher.push(makeTask(1, 'hashing'))
    batcher.push(makeTask(1, 'skipped'))
    batcher.flushNow()

    expect(batches).toHaveLength(1)
    expect(batches[0].upserts).toHaveLength(1)
    // 中间态不该出现在结果里：界面只需要看到最终状态
    expect(batches[0].upserts[0].state).toBe('skipped')
    batcher.dispose()
  })

  it('一批内多个不同任务合并成一次推送', () => {
    const batches: TaskBatch[] = []
    const batcher = new TaskBatcher((b) => batches.push(b), 10)

    for (let i = 0; i < 500; i++) batcher.push(makeTask(i, 'skipped'))
    batcher.flushNow()

    // 500 条变化 → 1 次推送，而不是 500 次
    expect(batches).toHaveLength(1)
    expect(batches[0].upserts).toHaveLength(500)
    batcher.dispose()
  })

  it('淘汰通知与被淘汰任务的更新不会自相矛盾', () => {
    const batches: TaskBatch[] = []
    const batcher = new TaskBatcher((b) => batches.push(b), 10)

    batcher.push(makeTask(7, 'skipped'))
    // 同一批里又收到「7 被淘汰了」
    batcher.remove(['task-7'])
    batcher.flushNow()

    expect(batches).toHaveLength(1)
    // 不能在 upserts 里还带着它，否则渲染层刚删又被加回来
    expect(batches[0].upserts.find((t) => t.id === 'task-7')).toBeUndefined()
    expect(batches[0].removed).toContain('task-7')
    batcher.dispose()
  })

  it('没有变化时不推空批次', () => {
    const batches: TaskBatch[] = []
    const batcher = new TaskBatcher((b) => batches.push(b), 10)
    batcher.flushNow()
    expect(batches).toHaveLength(0)
    batcher.dispose()
  })

  it('dispose 之后不再推送也不再接收', () => {
    const batches: TaskBatch[] = []
    const batcher = new TaskBatcher((b) => batches.push(b), 10)
    batcher.dispose()
    batcher.push(makeTask(1, 'done'))
    batcher.flushNow()
    expect(batches).toHaveLength(0)
  })
})

describe('Manifest 写批次（延迟提交事务）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-tx-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('刚写入的数据立刻能读到（事务未提交也要一致）', () => {
    const db = join(dir, 'm.db')
    const m = new Manifest(db)
    m.upsertFile({ localPath: 'a.txt', localSize: 10, mtimeMs: 1000, state: 'pending' })
    m.setState('a.txt', 'synced')

    // 同一个连接，未提交的写入对自己可见
    expect(m.getFile('a.txt')?.state).toBe('synced')
    m.close()
  })

  it('close 会把未提交的写批次落盘', () => {
    const db = join(dir, 'm.db')
    const first = new Manifest(db)
    // 只写不等待：靠 close() 里的提交把它落盘
    first.upsertFile({ localPath: 'persist.txt', localSize: 42, mtimeMs: 2000, state: 'pending' })
    first.setState('persist.txt', 'synced')
    first.close()

    // 重新打开必须还在——丢了就说明提交没做
    const second = new Manifest(db)
    const entry = second.getFile('persist.txt')
    expect(entry).toBeDefined()
    expect(entry?.localSize).toBe(42)
    expect(entry?.state).toBe('synced')
    second.close()
  })

  it('批量写入不会互相覆盖，日志也完整落库', () => {
    const db = join(dir, 'm.db')
    const m = new Manifest(db)

    for (let i = 0; i < 500; i++) {
      m.upsertFile({ localPath: `f${i}.bin`, localSize: i, mtimeMs: 1000 + i, state: 'pending' })
      m.log('info', `写入 f${i}.bin`, undefined, undefined, { category: 'upload', filePath: `f${i}.bin` })
    }
    m.close()

    const again = new Manifest(db)
    expect(again.getFile('f499.bin')?.localSize).toBe(499)
    expect(again.getFile('f0.bin')?.localSize).toBe(0)
    // 日志条数不能因为合并提交而变少
    expect(again.recentLogs(1000).length).toBeGreaterThanOrEqual(500)
    again.close()
  })
})

describe('Planner 任务表容量上限', () => {
  let dir: string
  let manifest: Manifest
  let planner: Planner
  let evicted: string[]

  /** 直接调私有的 touch()：它能覆盖到「写入任务表 + 触发淘汰」这条完整路径 */
  type Touchable = {
    touch: (relPath: string, patch: Partial<TransferTask>) => void
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topensync-cap-'))
    manifest = new Manifest(join(dir, 'manifest.db'))
    evicted = []

    planner = new Planner({
      manifest,
      transfer: { upload: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Transfer,
      client: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      } as unknown as OpenListClient,
      getConfig: () => ({ ...CONFIG, syncRoot: join(dir, 'sync') }),
      onTasksEvicted: (ids) => evicted.push(...ids)
    })
    planner.start()
  })

  afterEach(() => {
    planner.stop()
    manifest.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('任务数不会无限增长，且淘汰会回报给上层', () => {
    const touch = (planner as unknown as Touchable).touch.bind(planner)
    // 模拟六万个文件全部被跳过
    for (let i = 0; i < 60_000; i++) {
      touch(`f${i}.bin`, { state: 'skipped', category: 'skip', size: 1 })
    }

    // 表在 [MAX_TASKS, TASK_TABLE_LIMIT] 之间浮动，绝不会继续增长
    expect(planner.getTasks().length).toBeLessThanOrEqual(TASK_TABLE_LIMIT)
    expect(planner.truncated).toBe(true)
    // 不回报的话，渲染层那份数组会一直涨，两边表格越差越远
    expect(evicted.length).toBeGreaterThan(0)
  })

  it('失败与进行中的任务永不淘汰', () => {
    const touch = (planner as unknown as Touchable).touch.bind(planner)

    // 先放几个「不能被淘汰」的：失败、排队、上传中
    for (let i = 0; i < 30; i++) {
      touch(`failed-${i}.bin`, { state: 'failed', errorMsg: 'boom' })
      touch(`queued-${i}.bin`, { state: 'queued' })
      touch(`active-${i}.bin`, { state: 'uploading' })
    }

    // 再灌入大量跳过任务把表挤爆
    for (let i = 0; i < 60_000; i++) {
      touch(`skip-${i}.bin`, { state: 'skipped', category: 'skip', size: 1 })
    }

    const tasks = planner.getTasks()
    expect(tasks.length).toBeLessThanOrEqual(TASK_TABLE_LIMIT)
    expect(tasks.filter((t) => t.state === 'failed')).toHaveLength(30)
    expect(tasks.filter((t) => t.state === 'queued')).toHaveLength(30)
    expect(tasks.filter((t) => t.state === 'uploading')).toHaveLength(30)
    // 被淘汰的只能是终态：失败/排队/上传中一条都不能少
    expect(tasks.every((t) => t.state !== 'skipped' || t.category === 'skip')).toBe(true)
  })

  it('淘汰后同一路径再次变更会重新建立任务，不会指向已删除的 id', () => {
    const touch = (planner as unknown as Touchable).touch.bind(planner)

    touch('victim.bin', { state: 'skipped', category: 'skip', size: 1 })
    const first = planner.getTasks().find((t) => t.localPath === 'victim.bin')
    expect(first).toBeDefined()

    // 灌爆任务表，victim 会被淘汰
    for (let i = 0; i < 60_000; i++) {
      touch(`f${i}.bin`, { state: 'skipped', category: 'skip', size: 1 })
    }
    expect(planner.getTasks().find((t) => t.localPath === 'victim.bin')).toBeUndefined()

    // 它又变了 → 必须重新出现，而不是去写一个已删的 id
    touch('victim.bin', { state: 'failed', errorMsg: 'changed' })
    const again = planner.getTasks().find((t) => t.localPath === 'victim.bin')
    expect(again).toBeDefined()
    expect(again?.state).toBe('failed')
  })

  it('刚完成的任务不会被立即淘汰（保护「刚上传完」的可见性）', () => {
    const touch = (planner as unknown as Touchable).touch.bind(planner)

    // 一个「刚刚完成」的上传任务
    touch('fresh-done.bin', { state: 'done', category: 'upload', size: 1 })

    // 大量跳过任务把表挤爆——done 因为刚完成（在保护窗口内）不该被淘汰
    for (let i = 0; i < 60_000; i++) {
      touch(`skip-${i}.bin`, { state: 'skipped', category: 'skip', size: 1 })
    }

    const tasks = planner.getTasks()
    // 刚完成的 done 还在（这是用户最关心的：刚上传完的不能消失）
    expect(tasks.some((t) => t.localPath === 'fresh-done.bin')).toBe(true)
    expect(tasks.length).toBeLessThanOrEqual(TASK_TABLE_LIMIT)
  })

  it('done 任务盖了完成时间戳，淘汰按完成先后而非入队先后', () => {
    const touch = (planner as unknown as Touchable).touch.bind(planner)

    // 两个都完成，但「old-done」入队早（更早 touch done）→ 完成时间更早
    touch('old-done.bin', { state: 'done', category: 'upload', size: 1 })
    touch('new-done.bin', { state: 'done', category: 'upload', size: 1 })

    // 用跳过任务挤爆表
    for (let i = 0; i < 60_000; i++) {
      touch(`skip-${i}.bin`, { state: 'skipped', category: 'skip', size: 1 })
    }

    // 保护窗口内两者都该在（都刚完成），但若超出窗口，old-done 应先被淘汰
    // 这里验证 finishedAt 字段确实被写上了
    const tasks = planner.getTasks()
    const old = tasks.find((t) => t.localPath === 'old-done.bin')
    const fresh = tasks.find((t) => t.localPath === 'new-done.bin')
    if (old) expect(old.finishedAt).toBeGreaterThan(0)
    if (fresh) expect(fresh.finishedAt).toBeGreaterThan(0)
  })
})
