// 用**正式 profile**（用户自己的真实配置与清单）打开清单页并截图。
//
// 为什么单独写一个：ui-verify 系列都用独立 profile + 短路径，
// 验证不了真实数据下的排版——真实远端根是 `/qh/topensync-demo`，
// 文件名是 `团建--20220805/DSCF7226.JPG` 这种长中文路径，
// 短路径下「刚刚好」的布局到真实数据上就可能挤爆。
//
// 这个脚本**只读**：不 patchConfig、不删文件、不触发对账，
// 跑完即退，不影响正式 profile 里的任何状态。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/shot-real-manifest.cjs <输出目录>
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

const outDir = process.argv[2] || path.join(os.tmpdir(), 'topensync-real-shot')
fs.mkdirSync(outDir, { recursive: true })

const { app, BrowserWindow } = require('electron')
require(MAIN)

async function goto(win, hash, expectTitle) {
  await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
  const deadline = Date.now() + 8000
  for (;;) {
    const title = await win.webContents.executeJavaScript(
      `(document.querySelector('.page-head h1') || {}).textContent || ''`
    )
    if (title.includes(expectTitle)) break
    if (Date.now() > deadline) return title
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 400))
  return expectTitle
}

async function main() {
  await new Promise((r) => setTimeout(r, 4500))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('RESULT: 没有创建窗口')
    app.exit(1)
    return
  }
  win.setSize(1440, 900)

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  // 清单页
  const t1 = await goto(win, 'manifest', '文件清单')
  const f1 = path.join(outDir, 'manifest-real.png')
  fs.writeFileSync(f1, (await win.webContents.capturePage()).toPNG())
  console.log(`✓ 清单页「${t1}」→ ${f1}`)

  // 把清单页的表头与路径取出来，方便肉眼核对
  const probe = await win.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.card.table-card'))
    const pick = (cls) => {
      const card = cards.find((c) => c.classList.contains(cls))
      if (!card) return null
      return {
        title: (card.querySelector('.card-head h2') || {}).textContent.trim(),
        heads: Array.from(card.querySelectorAll('thead th')).map((t) => t.textContent.trim()),
        rows: Array.from(card.querySelectorAll('tbody tr')).slice(0, 3).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
          const sp = tr.querySelector('.path-split')
          const relEl = sp ? sp.querySelector('.path-rel') : null
          const rootEl = sp ? sp.querySelector('.path-root') : null
          return {
            local: cells[1] || '',
            root: rootEl ? rootEl.textContent.trim() : '',
            rel: relEl ? relEl.textContent.trim() : '',
            sameAsLocal: relEl ? relEl.classList.contains('same') : null,
            truncated: relEl ? relEl.scrollWidth > relEl.clientWidth : null
          }
        })
      }
    }
    return { remote: pick('card-remote'), local: pick('card-local') }
  })()`)
  console.log('\n远端独有表:', JSON.stringify(probe.remote, null, 2))
  console.log('\n本地文件表:', JSON.stringify(probe.local, null, 2))

  // 远端对账页也拍一张（差异列表同样是路径密集的地方）
  const t2 = await goto(win, 'reconcile', '远端对账')
  const f2 = path.join(outDir, 'reconcile-real.png')
  fs.writeFileSync(f2, (await win.webContents.capturePage()).toPNG())
  console.log(`\n✓ 对账页「${t2}」→ ${f2}`)

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log(`\n截图目录: ${outDir}`)
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('✗ 截图脚本异常:', err)
    app.exit(1)
  })
})
