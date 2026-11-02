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
  ipcMain.handle('app:snapshot', async () => {
    // 等首次连接自检跑完再取快照。
    // 连接探测是异步的（登录 + 列目录），不等的话首屏拿到的是
    // 「还没探测过」的初始状态，界面会显示一个假的「未配置」。
    await engine.whenReady()
    return engine.getSnapshot()
  })
  ipcMain.handle('app:stats', () => engine.getStats())
  ipcMain.handle('config:get', () => engine.getConfig())
  ipcMain.handle('files:list', (_e, opts: { limit?: number; offset?: number }) =>
    engine.listFiles(opts ?? {}))
  ipcMain.handle('diffs:list', () => engine.listDiffs())
  ipcMain.handle('logs:list', (_e, limit: number) => engine.recentLogs(limit ?? 200))
  ipcMain.handle('tasks:list', () => engine.listTasks())
  ipcMain.handle('connection:check', () => engine.recheckConnection())
  ipcMain.handle('diagnostics:export', () => engine.exportDiagnostics())
  ipcMain.handle('storage:info', () => engine.getStorageInfo())
  ipcMain.handle('storage:clearCache', () => engine.clearCache())
  ipcMain.handle('sync:pause', () => {
    engine.pause()
    return true
  })
  ipcMain.handle('sync:resume', () => {
    engine.resume()
    return true
  })
  /*
   * 开始同步。
   *
   * 程序启动后默认不开始——本地扫描、远端对账、上传队列
   * 都要用户点「开始同步」才启动。备份工具多半开机自启，
   * 用户可能只是路过看一眼状态，不该一开就抢带宽扫全盘。
   */
  ipcMain.handle('sync:start', () => {
    engine.startSync()
    return true
  })

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
  /*
   * 差异处置走 invoke 而不是 send。
   *
   * 原因：处置完界面必须把那一行撤掉。用 send 时渲染层不知道
   * 什么时候处理完了，只能靠 setTimeout 猜时间（400ms）——
   * 「移入回收站」要走网络请求，400ms 常常不够，
   * 差异行就永远留在表里，用户以为操作没生效，反复点。
   *
   * invoke 返回 Promise，渲染层 await 完再刷新列表，时序是确定的。
   */
  ipcMain.handle('diff:resolve', async (_e, diffId: number, resolution: DiffResolution) => {
    await engine.resolveDiff(diffId, resolution)
  })

  /*
   * 删除（批量）。
   *
   * 三种删除语义分开，不混成一个接口：
   * - files:deleteLocal → 删本地文件，远端按删除策略跟进
   * - tasks:remove      → 只清队列里的任务记录，不动文件
   * - files:deleteRemote→ 删远端文件（走回收站）并关闭对应差异
   *
   * 混在一起的后果：用户在队列里点「删除」以为删的是记录，
   * 结果文件被真删了——这是不可接受的数据损失。
   */
  ipcMain.handle('files:deleteLocal', (_e, relPaths: string[]) =>
    engine.deleteLocalFiles(relPaths ?? [])
  )
  ipcMain.handle('tasks:remove', (_e, taskIds: string[]) =>
    engine.removeTasks(taskIds ?? [])
  )
  ipcMain.handle(
    'files:deleteRemote',
    (_e, targets: { remotePath: string; diffId?: number }[]) =>
      engine.deleteRemoteFiles(targets ?? [])
  )
  ipcMain.handle('logs:clear', () => engine.clearLogs())

  /*
   * 深度校验（批量）。
   *
   * 把远端文件拉回来重算哈希，与本地比对。
   * 一致 → 弱认定升级为哈希确认；不一致 → 按冲突策略处理。
   */
  ipcMain.handle('files:verifyRemote', (_e, relPaths: string[]) =>
    engine.verifyRemoteFiles(relPaths ?? [])
  )

  ipcMain.on('app:quit', () => {
    app.quit()
  })
}
