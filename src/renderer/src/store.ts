import { create } from 'zustand'
import type {
  AppConfig,
  AppStats,
  ConnectionStatus,
  DiffEntry,
  FileEntry,
  TransferTask
} from '@shared/types'

/**
 * 渲染进程的全局状态。
 *
 * 数据有三个来源，优先级从高到低：
 * 1. 首屏快照（invoke 'app:snapshot'）——一次性拿全量
 * 2. 主进程推送的事件（transfer:update / diff:update / log:append …）——增量
 * 3. 轮询刷新统计——兜底，防止某类事件漏掉导致数字长期不更新
 */

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

interface AppState {
  ready: boolean
  config: AppConfig | null
  stats: AppStats | null
  files: FileEntry[]
  diffs: DiffEntry[]
  tasks: TransferTask[]
  logs: LogEntry[]
  connection: ConnectionStatus | null

  /** 首次加载：拉快照 + 建立事件订阅 */
  init: () => Promise<void>
  refreshStats: () => Promise<void>
  refreshFiles: () => Promise<void>
  refreshDiffs: () => Promise<void>
  saveConfig: (patch: Partial<AppConfig>) => Promise<AppConfig | null>
  recheckConnection: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  config: null,
  stats: null,
  files: [],
  diffs: [],
  tasks: [],
  logs: [],
  connection: null,

  init: async () => {
    const snap = await window.topensync?.getSnapshot()
    if (!snap) {
      set({ ready: true })
      return
    }

    set({
      ready: true,
      config: snap.config,
      stats: snap.stats,
      files: snap.files,
      diffs: snap.diffs,
      tasks: snap.tasks,
      logs: snap.logs as LogEntry[],
      connection: snap.connection
    })

    // ── 事件订阅 ──
    window.topensync?.onTransferUpdate((task) => {
      set((s) => ({
        tasks: [...s.tasks.filter((x) => x.id !== task.id), task],
        // 任务状态变了，统计数字跟着变
        stats: s.stats
          ? { ...s.stats, queued: countBy(s.tasks, task, 'queued'), failed: countBy(s.tasks, task, 'failed') }
          : s.stats
      }))
      void get().refreshStats()
    })

    window.topensync?.onScanUpdate(() => {
      void get().refreshStats()
    })

    window.topensync?.onDiffUpdate((diff) => {
      set((s) => ({ diffs: [diff, ...s.diffs.filter((d) => d.id !== diff.id)] }))
      void get().refreshStats()
    })

    window.topensync?.onConfigUpdate((config) => {
      set({ config })
    })

    window.topensync?.onLogAppend((entry) => {
      set((s) => ({ logs: [entry, ...s.logs].slice(0, 500) }))
    })

    // 兜底轮询：统计与清单不会每次都有事件推送
    window.setInterval(() => {
      void get().refreshStats()
    }, 5000)
  },

  refreshStats: async () => {
    const stats = await window.topensync?.getStats()
    if (stats) set({ stats })
  },

  refreshFiles: async () => {
    const files = await window.topensync?.listFiles({ limit: 2000 })
    if (files) set({ files })
  },

  refreshDiffs: async () => {
    const diffs = await window.topensync?.listDiffs()
    if (diffs) set({ diffs })
  },

  saveConfig: async (patch) => {
    const config = await window.topensync?.patchConfig(patch)
    if (config) set({ config })
    return config ?? null
  },

  recheckConnection: async () => {
    const connection = await window.topensync?.checkConnection()
    if (connection) set({ connection })
  }
}))

/** 单个任务状态变化后，重算该状态的任务数 */
function countBy(
  tasks: TransferTask[],
  changed: TransferTask,
  state: TransferTask['state']
): number {
  const others = tasks.filter((t) => t.id !== changed.id)
  return [...others, changed].filter((t) => t.state === state).length
}
