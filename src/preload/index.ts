import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  AppSnapshot,
  AppStats,
  ConnectionStatus,
  DeepVerifyResult,
  DiffEntry,
  DiffResolution,
  FileEntry,
  LogEntry,
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
  /** 订阅任务的批量变更（不是单条——六万文件时单条推送会卡死界面） */
  onTransferBatch: (cb: MainToRendererEvents['transfer:batch']) =>
    subscribe('transfer:batch', cb),
  onScanUpdate: (cb: MainToRendererEvents['scan:update']) => subscribe('scan:update', cb),
  /** 订阅扫描/对账进度 */
  onScanProgress: (cb: MainToRendererEvents['scan:progress']) => subscribe('scan:progress', cb),
  onDiffUpdate: (cb: MainToRendererEvents['diff:update']) => subscribe('diff:update', cb),
  /** 订阅差异的批量变更（对账时一批可能上百条，逐条推会卡死界面） */
  onDiffBatch: (cb: MainToRendererEvents['diff:batch']) => subscribe('diff:batch', cb),
  onConfigUpdate: (cb: MainToRendererEvents['config:update']) => subscribe('config:update', cb),
  /** 订阅日志批量追加 */
  onLogBatch: (cb: MainToRendererEvents['log:batch']) => subscribe('log:batch', cb),
  onConnectionUpdate: (cb: MainToRendererEvents['connection:update']) =>
    subscribe('connection:update', cb),

  // ── 读取（请求-响应）──────────────────────────────────
  /** 首屏一次性拉取全部数据 */
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke('app:snapshot'),
  getStats: (): Promise<AppStats> => ipcRenderer.invoke('app:stats'),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  listFiles: (opts?: { limit?: number; offset?: number }): Promise<FileEntry[]> =>
    ipcRenderer.invoke('files:list', opts ?? {}),
  listDiffs: (): Promise<DiffEntry[]> => ipcRenderer.invoke('diffs:list'),
  listLogs: (limit?: number): Promise<LogEntry[]> =>
    ipcRenderer.invoke('logs:list', limit ?? 200),
  listTasks: (): Promise<TransferTask[]> => ipcRenderer.invoke('tasks:list'),
  checkConnection: (): Promise<ConnectionStatus> => ipcRenderer.invoke('connection:check'),
  /** 导出诊断包，返回生成的文件路径 */
  exportDiagnostics: (): Promise<string> => ipcRenderer.invoke('diagnostics:export'),
  /** 数据目录占用（数据库大小、缓存大小） */
  getStorageInfo: (): Promise<import('@shared/types').StorageInfo> =>
    ipcRenderer.invoke('storage:info'),
  /** 清除运行时缓存 */
  clearCache: (): Promise<import('@shared/types').ClearCacheResult> =>
    ipcRenderer.invoke('storage:clearCache'),
  /** 暂停同步（停止本地监控与远端对账，保留清单与配置） */
  pauseSync: (): Promise<boolean> => ipcRenderer.invoke('sync:pause'),
  /** 恢复同步 */
  resumeSync: (): Promise<boolean> => ipcRenderer.invoke('sync:resume'),
  /** 开始同步（启动后默认不开始，由用户显式触发） */
  startSync: (): Promise<boolean> => ipcRenderer.invoke('sync:start'),

  // ── 动作 ──────────────────────────────────────────────
  /** 改配置走请求-响应：调用方需要拿到合并后的新配置 */
  patchConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:patch', patch),
  triggerScan: (kind: ScanKind) => ipcRenderer.send('scan:trigger', kind),
  retryTransfer: (taskId: string) => ipcRenderer.send('transfer:retry', taskId),
  cancelTransfer: (taskId: string) => ipcRenderer.send('transfer:cancel', taskId),
  resolveDiff: (diffId: number, resolution: DiffResolution) =>
    ipcRenderer.invoke('diff:resolve', diffId, resolution),

  /*
   * 删除（批量）。
   *
   * 三种语义分开暴露，界面上对应三种不同含义的按钮：
   * - deleteLocalFiles：删本地文件，远端按删除策略跟进
   * - removeTasks：只清队列里的任务记录，**不动文件**
   * - deleteRemoteFiles：删远端文件（走回收站）并关闭对应差异
   */
  deleteLocalFiles: (relPaths: string[]): Promise<{ deleted: number; failed: number }> =>
    ipcRenderer.invoke('files:deleteLocal', relPaths),
  removeTasks: (taskIds: string[]): Promise<number> =>
    ipcRenderer.invoke('tasks:remove', taskIds),
  deleteRemoteFiles: (
    targets: { remotePath: string; diffId?: number }[]
  ): Promise<{ deleted: number; failed: number }> =>
    ipcRenderer.invoke('files:deleteRemote', targets),

  /** 清空运行日志（只清日志，不动同步状态） */
  clearLogs: (): Promise<number> => ipcRenderer.invoke('logs:clear'),

  /**
   * 深度校验（批量）：把远端文件拉回来重算哈希，与本地比对。
   *
   * 用于给「同名同大小」的弱认定补做内容确认。
   */
  verifyRemoteFiles: (relPaths: string[]): Promise<DeepVerifyResult> =>
    ipcRenderer.invoke('files:verifyRemote', relPaths),

  quit: () => ipcRenderer.send('app:quit')
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('topensync', api)
