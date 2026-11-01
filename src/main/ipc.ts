import { app, ipcMain, BrowserWindow } from 'electron'
import type { Engine } from './engine'
import type { AppConfig, DiffResolution, ScanKind } from '@shared/types'

/**
 * IPC 通道注册。
 *
 * 这一层只做参数转发与类型收敛，不含任何业务逻辑——
 * 业务都在 Engine 里。这样主进程逻辑可以脱离 Electron 单测。
 *
 * 通道分两类：
 * - `invoke`（请求-响应）：渲染进程主动拉数据，首屏快照走这条
 * - `send`（单向通知）：触发动作，主进程执行后用 `emit` 把结果推回去
 */

/** 向所有窗口广播一个事件 */
export function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

export function registerIpc(engine: Engine): void {
  // ── 读取 ──────────────────────────────────────────────
  ipcMain.handle('app:snapshot', () => engine.getSnapshot())
  ipcMain.handle('app:stats', () => engine.getStats())
  ipcMain.handle('config:get', () => engine.getConfig())
  ipcMain.handle('files:list', (_e, opts: { limit?: number }) => engine.listFiles(opts ?? {}))
  ipcMain.handle('diffs:list', () => engine.listDiffs())
  ipcMain.handle('logs:list', (_e, limit: number) => engine.recentLogs(limit ?? 200))
  ipcMain.handle('tasks:list', () => engine.listTasks())
  ipcMain.handle('connection:check', () => engine.recheckConnection())

  // ── 动作 ──────────────────────────────────────────────
  ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) => engine.updateConfig(patch))

  ipcMain.on('scan:trigger', (_e, kind: ScanKind) => {
    void engine.triggerScan(kind)
  })
  ipcMain.on('transfer:retry', (_e, taskId: string) => {
    engine.retryTransfer(taskId)
  })
  ipcMain.on('transfer:cancel', (_e, taskId: string) => {
    engine.cancelTransfer(taskId)
  })
  ipcMain.on('diff:resolve', (_e, diffId: number, resolution: DiffResolution) => {
    void engine.resolveDiff(diffId, resolution)
  })
  ipcMain.on('app:quit', () => {
    app.quit()
  })
}
