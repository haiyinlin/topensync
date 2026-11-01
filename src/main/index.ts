import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { Engine } from './engine'
import { registerIpc, emit } from './ipc'

/**
 * 主进程入口。
 *
 * 关键约束：
 * - 单实例锁：多实例并发会同时写 SQLite 并重复上传。
 * - 凭据经 safeStorage 加密，不落明文。
 */

let mainWindow: BrowserWindow | null = null
let engine: Engine | null = null

// ── 单实例锁 ──────────────────────────────────────────────
// 必须尽早获取。第二个实例直接退出，避免并发写库与重复上传。
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0A0A0B',
    title: 'TopenSync',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外部链接交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.topensync.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 引擎先于窗口建立：IPC 通道要在渲染进程开始请求前注册好
  engine = new Engine({
    onTransfer: (task) => emit('transfer:update', task),
    onScan: (scan) => emit('scan:update', scan),
    onDiff: (diff) => emit('diff:update', diff),
    onConfig: (config) => emit('config:update', config),
    onLog: (entry) => emit('log:append', entry)
  })
  registerIpc(engine)

  createWindow()

  // 引擎启动失败不应让窗口打不开：连接问题由连接页展示并允许重试
  void engine.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    emit('log:append', { ts: Date.now(), level: 'error', message: `引擎启动失败：${message}` })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  engine?.stop()
  engine = null
})
