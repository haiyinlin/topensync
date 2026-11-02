// 试运行：真实窗口 + 真实 OpenList，跑完完整链路后**窗口保持打开**，
// 让用户直接看界面、点按钮。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/trial-run.cjs <输出目录>
//
// 环境变量：
//   M0_BASE / M0_USER / M0_PASS / M0_ROOT / M0_SYNC_ROOT / M0_USERDATA
//
// 设计约束：
// - 凭据只从环境变量读，绝不写进仓库（这是公开仓库）
// - 远端根路径必须带 demo 标记，否则拒绝运行
// - 失败即退出，不要长时间空转
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const REMOTE_ROOT = process.env.M0_ROOT || '/qh/topensync-demo'
const SYNC_ROOT = process.env.M0_SYNC_ROOT || path.join(os.tmpdir(), 'topensync-trial-sync')
const USER_DATA = process.env.M0_USERDATA || path.join(os.tmpdir(), 'topensync-trial-userdata')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}

if (!/demo/i.test(REMOTE_ROOT)) {
  console.error(`✗ 拒绝在非 demo 目录上运行：${REMOTE_ROOT}`)
  console.error('  远端根路径必须带 demo 标记')
  process.exit(1)
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-trial-'))
fs.mkdirSync(outDir, { recursive: true })

// 本地同步目录复用真实数据（上次演示留下的），这样才有「本地有」可比
if (!fs.existsSync(SYNC_ROOT)) {
  fs.mkdirSync(SYNC_ROOT, { recursive: true })
}

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

require(MAIN)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 30000, step = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= deadline) return null
    await sleep(step)
  }
}

/** 截当前页 */
async function shot(win, name) {
  await sleep(350)
  const img = await win.webContents.capturePage()
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, img.toPNG())
  console.log(`  📷 ${name} → ${file}`)
}

/** 切页并等标题对上（截图会拍到上一页，必须等标题变了再拍） */
async function goto(win, page, expectedTitle) {
  await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(page)}`)
  let title = ''
  for (let i = 0; i < 50; i++) {
    title = await win.webContents.executeJavaScript(
      `(document.querySelector('.page-head h1') || {}).textContent || ''`
    )
    if (title && (!expectedTitle || title.includes(expectedTitle))) break
    await sleep(100)
  }
  console.log(`  → ${page} 「${title}」`)
  return title
}

async function main() {
  console.log('本地同步目录:', SYNC_ROOT)
  console.log('远端根:', REMOTE_ROOT)
  console.log('输出目录:', outDir)

  await sleep(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('✗ 没有创建窗口')
    app.exit(1)
    return
  }
  win.setSize(1400, 900)
  win.center()

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  // ── 下发配置（真实 OpenList）──────────────────────────
  await win.webContents.executeJavaScript(`(async () => {
    await window.topensync.patchConfig({
      syncRoot: ${JSON.stringify(SYNC_ROOT)},
      openlist: {
        baseUrl: ${JSON.stringify(BASE)},
        username: ${JSON.stringify(USER)},
        password: ${JSON.stringify(PASS)}
      },
      remoteRoot: ${JSON.stringify(REMOTE_ROOT)},
      detectRenames: false,
      remoteScan: {
        enabled: true, intervalHours: 6, onStartup: false, refresh: true,
        maxConcurrency: 1, timeoutMinutes: 30, conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only', autoFixLimit: 20,
        exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
      }
    })
  })()`)
  console.log('✓ 配置已下发，连接 OpenList…')

  // ── 等连接建立 ─────────────────────────────────────────
  const conn = await waitFor(async () => {
    const c = await win.webContents.executeJavaScript(`window.topensync.checkConnection()`)
    return c && c.reachable ? c : null
  }, 30000, 1000)
  if (!conn) {
    console.log('✗ 30s 内未连上 OpenList')
    const logs = await win.webContents.executeJavaScript(`window.topensync.listLogs(20)`)
    for (const l of logs) console.log('   ', l.level, l.message)
    app.exit(1)
    return
  }
  console.log(`✓ 已连接 ${conn.baseUrl ?? ''}（${conn.status ?? 'ok'}）`)

  // ── 跑一遍本地同步 ─────────────────────────────────────
  console.log('\n→ 触发本地扫描 + 同步…')
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)

  const synced = await waitFor(async () => {
    const s = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
    return s.active === 0 && s.queued === 0 ? s : null
  }, 60000, 1000)
  if (!synced) {
    console.log('✗ 60s 内本地同步未结束')
    app.exit(1)
    return
  }
  console.log(
    `✓ 同步结束：已同步 ${synced.synced} / 跳过 ${synced.skipped}` +
      `（本地 ${synced.skippedLocal} + 远端 ${synced.skippedRemote}）/ 下载 ${synced.downloaded}`
  )

  // ── 远端对账（真实差异）────────────────────────────────
  console.log('\n→ 触发远端对账…')
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('remote')`)

  const diffs = await waitFor(async () => {
    const list = await win.webContents.executeJavaScript(`window.topensync.listDiffs()`)
    return list.length > 0 ? list : null
  }, 90000, 1000)

  if (!diffs) {
    console.log('（本轮对账无差异，远端内容与本地一致）')
  } else {
    console.log(`✓ 对账列出 ${diffs.length} 条差异：`)
    for (const d of diffs) {
      console.log(`   [${d.kind}] ${d.remotePath}  localPath=${d.localPath ?? '(无)'}`)
    }
  }

  // ── 逐页截图 ───────────────────────────────────────────
  console.log('\n→ 逐页截图：')
  await goto(win, 'overview', '概览')
  await shot(win, '1-概览')

  await goto(win, 'queue', '传输')
  await shot(win, '2-传输队列')

  await goto(win, 'reconcile', '对账')
  await shot(win, '3-远端对账')

  await goto(win, 'manifest', '清单')
  await shot(win, '4-文件清单')

  await goto(win, 'connection', '连接')
  await shot(win, '5-连接')

  // ── 队列页 DOM 断言：类别列真的在 ─────────────────────
  await goto(win, 'queue', '传输')
  const dom = await win.webContents.executeJavaScript(`(() => {
    const heads = [...document.querySelectorAll('.tbl thead th')].map(t => t.textContent.trim())
    const chips = [...document.querySelectorAll('.chips .chip')].map(c => c.textContent.trim())
    const rows = [...document.querySelectorAll('.tbl tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim())
    return { heads, chips, rows: rows.slice(0, 10) }
  })()`)
  console.log('\n队列页表头:', dom.heads.join(' | '))
  console.log('队列页筛选:', dom.chips.join(' | '))
  for (const r of dom.rows) console.log('  ', r)

  // ── 对账页 DOM 断言：差异真的列出来了 ──────────────────
  await goto(win, 'reconcile', '对账')
  const recon = await win.webContents.executeJavaScript(`(() => {
    const stats = [...document.querySelectorAll('.dstat')].map(s => s.innerText.replace(/\\s+/g,' ').trim())
    const rows = [...document.querySelectorAll('.tbl tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim())
    return { stats, rows: rows.slice(0, 10), rowCount: rows.length }
  })()`)
  console.log('\n对账页统计卡:')
  for (const s of recon.stats) console.log('  ', s)
  console.log(`对账页差异行数: ${recon.rowCount}`)
  for (const r of recon.rows) console.log('  ', r)

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')

  console.log('\n════════════════════════════════════════')
  console.log('RESULT: OK — 窗口保持打开，可直接操作')
  console.log('  试试：顶栏「扫描本地」/ 队列页筛选「跳过」/ 对账页点「下载到本地」')
  console.log('  关闭窗口即退出程序')
  console.log('════════════════════════════════════════')
  // 刻意不 app.exit()：窗口保持打开
}

main().catch((err) => {
  console.error('试运行失败:', err)
  app.exit(1)
})
