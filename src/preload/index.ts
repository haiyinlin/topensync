import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  AppSnapshot,
  AppStats,
  ConnectionStatus,
  DiffEntry,
  DiffResolution,
  FileEntry,
  MainToRendererEvents,
  ScanKind,
  TransferTask
} from '@shared/types'

/**
 * 预加载脚本：在隔离上下文中暴露最小 API 面。
 *
 * 不暴露 ipcRenderer 本身，也不暴露 Node 能力——
 * 渲染进程只能调用下面显式列出的通道。
 *
 * 每个订阅函数返回一个取消订阅的清理函数，供 React 的 useEffect 卸载时调用。
 */

/** 订阅并返回取消订阅函数 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return (): void => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  // ── 主进程 → 渲染进程（订阅）──────────────────────────
  onTransferUpdate: (cb: MainToRendererEvents['transfer:update']) =>
    subscribe('transfer:update', cb),
  onScanUpdate: (cb: MainToRendererEvents['scan:update']) => subscribe('scan:update', cb),
  onDiffUpdate: (cb: MainToRendererEvents['diff:update']) => subscribe('diff:update', cb),
  onConfigUpdate: (cb: MainToRendererEvents['config:update']) => subscribe('config:update', cb),
  onLogAppend: (cb: MainToRendererEvents['log:append']) => subscribe('log:append', cb),

  // ── 读取（请求-响应）──────────────────────────────────
  /** 首屏一次性拉取全部数据 */
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke('app:snapshot'),
  getStats: (): Promise<AppStats> => ipcRenderer.invoke('app:stats'),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  listFiles: (opts?: { limit?: number }): Promise<FileEntry[]> =>
    ipcRenderer.invoke('files:list', opts ?? {}),
  listDiffs: (): Promise<DiffEntry[]> => ipcRenderer.invoke('diffs:list'),
  listLogs: (limit?: number): Promise<{ ts: number; level: string; message: string }[]> =>
    ipcRenderer.invoke('logs:list', limit ?? 200),
  listTasks: (): Promise<TransferTask[]> => ipcRenderer.invoke('tasks:list'),
  checkConnection: (): Promise<ConnectionStatus> => ipcRenderer.invoke('connection:check'),

  // ── 动作 ──────────────────────────────────────────────
  /** 改配置走请求-响应：调用方需要拿到合并后的新配置 */
  patchConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:patch', patch),
  triggerScan: (kind: ScanKind) => ipcRenderer.send('scan:trigger', kind),
  retryTransfer: (taskId: string) => ipcRenderer.send('transfer:retry', taskId),
  cancelTransfer: (taskId: string) => ipcRenderer.send('transfer:cancel', taskId),
  resolveDiff: (diffId: number, resolution: DiffResolution) =>
    ipcRenderer.send('diff:resolve', diffId, resolution),
  quit: () => ipcRenderer.send('app:quit')
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('topensync', api)
