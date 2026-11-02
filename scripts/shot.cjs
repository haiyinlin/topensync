// 界面截图工具：启动真实应用，按给定 hash 路由逐页截图。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/shot.cjs [输出目录]
//
// 依赖 npm run build 的产物。截图写到输出目录（默认系统临时目录）。
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-shot-'))
fs.mkdirSync(outDir, { recursive: true })

const PAGES = [
  'overview',
  'queue',
  'manifest',
  'reconcile',
  'logs',
  'connection',
  'transfer',
  'reconrule',
  'advanced',
  'help'
]

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

  for (const page of PAGES) {
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(page)}`)
    await new Promise((r) => setTimeout(r, 700))
    const img = await win.webContents.capturePage()
    const file = path.join(outDir, `${page}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log(`  ✓ ${page} → ${file}`)
  }

  console.log('渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  app.exit(0)
})
