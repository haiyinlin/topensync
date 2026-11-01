// 端到端冒烟测试：启动真实应用（Engine + IPC 已注册），验证
// preload 暴露 → IPC 取数 → 配置写入 → 本地扫描 → 清单与队列。
//
// 前置：已执行 `npm run build`（依赖 out/main/index.js 产物）。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/smoke.cjs
//
// 注意：必须用 `env -u ELECTRON_RUN_AS_NODE` 剥离该环境变量。
// 该变量会让 Electron 以纯 Node 模式运行，require('electron') 只返回
// npm 包路径字符串而非内建模块，导致 app 为 undefined、渲染进程无法启动。
//
// 可选：传入第一个参数作为同步根目录（默认用系统临时目录并自动清理）。

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')

if (!fs.existsSync(MAIN)) {
  console.error(`✗ 缺少构建产物：${MAIN}\n  请先执行 npm run build`)
  process.exit(1)
}

const explicitRoot = process.argv[2]
const syncRoot = explicitRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-smoke-'))
const cleanup = !explicitRoot

if (cleanup) {
  fs.writeFileSync(path.join(syncRoot, 'a.txt'), 'hello smoke')
  fs.writeFileSync(path.join(syncRoot, 'b.log'), 'x'.repeat(2048))
  fs.mkdirSync(path.join(syncRoot, 'sub'))
  fs.writeFileSync(path.join(syncRoot, 'sub', 'c.txt'), 'nested')
}

require(MAIN)

const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('RESULT: 没有创建窗口')
    app.exit(1)
    return
  }

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  const probe = (expr) => win.webContents.executeJavaScript(expr)

  // 1) preload 是否暴露 API
  const hasApi = await probe('typeof window.topensync !== "undefined"')
  console.log('STEP preload 暴露 window.topensync:', hasApi)

  // 2) 首屏快照能否取到
  const snap = await probe(`window.topensync.getSnapshot().then(s => ({
    configOk: !!s.config,
    remoteRoot: s.config.remoteRoot,
    files: s.files.length,
    diffs: s.diffs.length,
    tasks: s.tasks.length,
    logs: s.logs.length,
    connectionConfigured: s.connection.configured,
    connectionError: s.connection.error
  }))`)
  console.log('STEP 首屏快照:', JSON.stringify(snap))

  // 3) 写入本地同步目录 → 触发扫描 → 清单应有文件
  await probe(`window.topensync.patchConfig({ syncRoot: ${JSON.stringify(syncRoot)} }).then(() => true)`)
  await new Promise((r) => setTimeout(r, 500))
  await probe(`window.topensync.triggerScan('local')`)
  await new Promise((r) => setTimeout(r, 3000))

  const after = await probe(`window.topensync.getSnapshot().then(s => ({
    files: s.files.length,
    paths: s.files.map(f => f.localPath).sort(),
    states: s.files.map(f => f.state),
    localScanning: s.stats.localScan.watching,
    scannedCount: s.stats.localScan.scannedCount,
    skipped: s.stats.skipped,
    queued: s.stats.queued,
    failed: s.stats.failed,
    logs: s.logs.slice(0, 6).map(l => l.level + ': ' + l.message)
  }))`)
  console.log('STEP 本地扫描后:', JSON.stringify(after, null, 2))

  console.log('STEP 渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')

  if (cleanup) fs.rmSync(syncRoot, { recursive: true, force: true })
  app.exit(0)
})
