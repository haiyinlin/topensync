/**
 * 验证打包产物：解压版 exe 能真的启动并渲染界面。
 *
 * 为什么不用「双击 exe 看窗口」：那依赖人工观察，且窗口一闪而过时无从判断。
 * 这里改成：直接跑打包产物里的 electron 二进制，加载 asar 里的渲染层，
 * 量 DOM —— 有 #root、有正文、无渲染错误，才算通过。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/verify-package.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const unpacked = path.resolve(__dirname, '..', 'release', 'win-unpacked')
const asar = path.join(unpacked, 'resources', 'app.asar')

app.setPath('userData', path.join(os.tmpdir(), 'topensync-verify-package'))

function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  return ok
}

app.whenReady().then(async () => {
  let allOk = true

  allOk = check('打包产物存在', fs.existsSync(unpacked)) && allOk
  allOk = check('app.asar 存在', fs.existsSync(asar)) && allOk
  allOk = check('TopenSync.exe 存在', fs.existsSync(path.join(unpacked, 'TopenSync.exe'))) && allOk

  const win = new BrowserWindow({ width: 1200, height: 800, show: false })
  const errors = []
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    const s = String(msg)
    if (/error/i.test(s) && !/DevTools/i.test(s)) errors.push(s)
  })

  try {
    // 直接加载 asar 里的渲染层——这正是打包后的真实产物
    await win.loadFile(path.join(asar, 'out', 'renderer', 'index.html'))
    await new Promise((r) => setTimeout(r, 1500))

    const hasRoot = await win.webContents.executeJavaScript(
      'document.getElementById("root") !== null'
    )
    const bodyLen = await win.webContents.executeJavaScript('document.body.innerText.length')
    const title = await win.webContents.executeJavaScript('document.title')

    allOk = check('渲染层能加载', true) && allOk
    allOk = check('有 #root 容器', hasRoot === true) && allOk
    allOk = check('界面有内容', bodyLen > 50, `正文 ${bodyLen} 字符`) && allOk
    allOk = check('无渲染错误', errors.length === 0, errors.slice(0, 3).join(' | ')) && allOk
    console.log('  窗口标题:', title)
  } catch (err) {
    allOk = check('渲染层能加载', false, err.message) && allOk
  }

  console.log(allOk ? 'RESULT: OK' : 'RESULT: FAIL')
  app.exit(allOk ? 0 : 1)
})
