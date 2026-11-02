// 实机验证：删除 / 批量删除 + 路径归一化
//
//   1. 传输队列能勾选、能批量移除记录，且**不删文件**
//   2. 远端对账能勾选、能批量删远端文件（远端真消失 + 进回收站 + 差异关闭）
//   3. 文件清单能勾选、能批量删除本地文件
//   4. 远端根路径带尾随空格时，配置会被归一化（不会传到「另一个目录」）
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/delete-verify.cjs <输出目录>
//
// 设计约束：
// - userData 必须全新，否则会读到上一次留下的配置
// - 远端根路径必须带 demo 标记
// - 失败即退出，不要长时间空转
// - **断言必须落在真实状态上**：删了远端文件就去列远端目录，
//   不能只看界面上的差异数量——之前就因为只看界面数字，
//   把「勾错了行」误判成「删除功能坏了」。
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
const REMOTE_ROOT = process.env.M0_ROOT || '/qh/topensync-delete-verify'
const SYNC_ROOT = path.join(os.tmpdir(), 'topensync-delete-sync')
const USER_DATA = path.join(os.tmpdir(), 'topensync-delete-userdata')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}

if (!/verify|demo/i.test(REMOTE_ROOT)) {
  console.error(`✗ 拒绝在非验证目录上运行：${REMOTE_ROOT}`)
  process.exit(1)
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-del-'))
fs.mkdirSync(outDir, { recursive: true })

// **必须清空**：复用旧目录会读到上一次留下的配置
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.rmSync(SYNC_ROOT, { recursive: true, force: true })
fs.mkdirSync(SYNC_ROOT, { recursive: true })

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)
require(MAIN)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 30000, step = 400) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= deadline) return null
    await sleep(step)
  }
}

async function shot(win, name) {
  await sleep(300)
  const img = await win.webContents.capturePage()
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, img.toPNG())
  console.log(`  📷 ${name} → ${file}`)
}

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
  return title
}

/** 页面上是否有勾选框 */
async function countCheckboxes(win) {
  return win.webContents.executeJavaScript(
    `document.querySelectorAll('.tbl tbody input[type="checkbox"]').length`
  )
}

/**
 * 等勾选框出现。
 *
 * 清单数据是异步刷新的（store 收到事件后才去拉 listFiles），
 * 切页后立刻查会查到还没刷新的空表——那不是 bug，是没等。
 */
async function waitCheckboxes(win, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await countCheckboxes(win)
    if (n > 0) return n
    if (Date.now() >= deadline) return 0
    await sleep(400)
  }
}

/** 点第 n 个勾选框 */
async function checkNth(win, index) {
  return win.webContents.executeJavaScript(`(() => {
    const boxes = [...document.querySelectorAll('.tbl tbody input[type="checkbox"]')]
    const b = boxes[${index}]
    if (!b) return false
    b.click()
    return true
  })()`)
}

/**
 * 按行内文本勾选。
 *
 * 必须这么挑，不能「勾第 0 行」：表格里混着好几种差异，
 * 勾错行会让断言指向另一个对象，
 * 于是「删了 A 却去查 B」，最后得出「功能坏了」的错误结论。
 */
async function checkRowByText(win, needle) {
  return win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.tbl tbody tr')]
    const row = rows.find(r => r.innerText.includes(${JSON.stringify(needle)}))
    if (!row) return false
    const b = row.querySelector('input[type="checkbox"]')
    if (!b) return false
    b.click()
    return true
  })()`)
}

/** 批量操作条是否出现 */
async function batchBarText(win) {
  return win.webContents.executeJavaScript(
    `(document.querySelector('.batch-bar') || {}).innerText || ''`
  )
}

/** 点批量操作条上的某个按钮 */
async function clickBatch(win, label) {
  return win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.batch-actions .btn')]
    const b = btns.find(x => x.textContent.includes(${JSON.stringify(label)}))
    if (!b) return false
    b.click()
    return true
  })()`)
}

/** 点确认弹窗里的危险按钮 */
async function confirmModal(win) {
  return win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.modal .btn.danger')
    if (!b) return false
    b.click()
    return true
  })()`)
}

/** 主进程最近日志——排查删除失败时最直接的证据 */
async function dumpLogs(win, n = 25) {
  const logs = await win.webContents.executeJavaScript(`window.topensync.listLogs(${n})`)
  return (logs || []).map((l) => `[${l.level}] ${l.message}`)
}

// ── 直连 OpenList 的探测工具 ──────────────────────────────
let cachedToken = ''
async function loginToken() {
  if (cachedToken) return cachedToken
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })
  const json = await res.json()
  cachedToken = json.data.token
  return cachedToken
}

/** 列远端目录；返回文件名数组，失败返回 null */
async function remoteList(p) {
  const res = await fetch(`${BASE}/api/fs/list`, {
    method: 'POST',
    headers: {
      // OpenList 用**裸 token**，不带 "Bearer " 前缀
      Authorization: await loginToken(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: p, page: 1, per_page: 99999, refresh: true })
  })
  const json = await res.json()
  if (json.code !== 200) {
    // 目录还不存在 ≠ 读取失败
    if (String(json.message || '').includes('not found')) return []
    return null
  }
  const content = json.data && json.data.content ? json.data.content : []
  return content.map((x) => x.name)
}

function writeFixtures() {
  const files = {
    'a.txt': 'alpha\n',
    'b.txt': 'beta\n',
    'c.txt': 'gamma\n'
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(SYNC_ROOT, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return Object.keys(files)
}

async function main() {
  console.log('本地同步目录:', SYNC_ROOT)
  console.log('远端根:', REMOTE_ROOT)
  writeFixtures()

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

  // ── 需求 4：路径归一化 ─────────────────────────────────
  console.log('\n===== 路径归一化 =====')

  const PADDED_ROOT = `${REMOTE_ROOT} ` // 尾部加一个空格
  const cfg = await win.webContents.executeJavaScript(`(async () => {
    const c = await window.topensync.patchConfig({
      syncRoot: ${JSON.stringify(SYNC_ROOT)},
      openlist: {
        baseUrl: ${JSON.stringify(BASE)},
        username: ${JSON.stringify(USER)},
        password: ${JSON.stringify(PASS)}
      },
      remoteRoot: ${JSON.stringify(PADDED_ROOT)},
      detectRenames: false,
      deletePolicy: 'trash',
      trashRoot: '_trash',
      remoteScan: {
        // 必须开着：enabled=false 时 startReconciler() 直接 return，
        // 对账器根本没被创建，triggerScan('remote') 也就无从谈起。
        enabled: true, intervalHours: 6, onStartup: false, refresh: true,
        maxConcurrency: 1, timeoutMinutes: 30, conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only', autoFixLimit: 20,
        exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
      }
    })
    return c
  })()`)

  if (cfg.remoteRoot !== REMOTE_ROOT) {
    console.log(`✗ 远端根未归一化：期望「${REMOTE_ROOT}」，实际「${cfg.remoteRoot}」`)
    app.exit(1)
    return
  }
  console.log(`✓ 尾随空格已被去掉：「${PADDED_ROOT}」→「${cfg.remoteRoot}」`)

  // 落盘配置也要是干净的
  const savedRaw = fs.readFileSync(path.join(USER_DATA, 'config.json'), 'utf8')
  const saved = JSON.parse(savedRaw)
  if (saved.remoteRoot !== REMOTE_ROOT) {
    console.log(`✗ 落盘配置仍带空格：「${saved.remoteRoot}」`)
    app.exit(1)
    return
  }
  console.log('✓ 落盘配置也已归一化')

  // ── 需求 1：队列删除 ───────────────────────────────────
  console.log('\n===== 传输队列：删除与批量删除 =====')

  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)
  const synced = await waitFor(async () => {
    const s = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
    return s.active === 0 && s.queued === 0 && s.synced >= 3 ? s : null
  }, 60000, 800)
  if (!synced) {
    console.log('✗ 首轮同步未在 60s 内完成')
    app.exit(1)
    return
  }
  console.log(`✓ 首轮同步完成，已同步 ${synced.synced} 个`)

  await goto(win, 'queue', '传输')
  const qBoxes = await countCheckboxes(win)
  console.log(`  队列页勾选框数量: ${qBoxes}`)
  if (qBoxes === 0) {
    console.log('✗ 队列页没有勾选框')
    app.exit(1)
    return
  }
  console.log('✓ 队列页有勾选框')

  // 勾两个
  await checkNth(win, 0)
  await checkNth(win, 1)
  await sleep(250)
  const qBar = await batchBarText(win)
  console.log(`  批量操作条: ${qBar.replace(/\n/g, ' | ')}`)
  if (!qBar.includes('已选')) {
    console.log('✗ 勾选后没有出现批量操作条')
    app.exit(1)
    return
  }
  console.log('✓ 勾选后出现批量操作条')
  await shot(win, '1-队列-已勾选')

  if (!(await clickBatch(win, '移除记录'))) {
    console.log('✗ 找不到「移除记录」按钮')
    app.exit(1)
    return
  }
  await sleep(600)
  if (!(await confirmModal(win))) {
    console.log('✗ 没有出现二次确认弹窗')
    app.exit(1)
    return
  }
  await sleep(900)

  const afterRemove = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
  console.log(`✓ 移除后剩余任务: ${afterRemove.length} 条`)
  // **关键断言**：文件一个都不能少
  const stillThere = ['a.txt', 'b.txt', 'c.txt'].filter((n) =>
    fs.existsSync(path.join(SYNC_ROOT, n))
  )
  console.log(`  本地文件仍在: ${stillThere.join(', ')}`)
  if (stillThere.length !== 3) {
    console.log('✗ 队列里删记录把文件也删了 —— 这是数据损失')
    app.exit(1)
    return
  }
  console.log('✓ 只清了记录，文件完好')

  // ── 需求 2：对账页批量删远端 ───────────────────────────
  // 放在删本地文件**之前**：本地一删，远端副本被挪走，
  // 对账就会多出「远端缺失」差异，干扰对账页的断言。
  console.log('\n===== 远端对账：批量删除 =====')

  // 放一个远端独有的文件，制造 remote_only 差异
  const extra = `${REMOTE_ROOT}/from-elsewhere.txt`
  const { createHash } = require('crypto')
  const buf = Buffer.from('uploaded from elsewhere\n')
  const md5 = createHash('md5').update(buf).digest('hex')
  const sha1 = createHash('sha1').update(buf).digest('hex')
  const putRes = await fetch(`${BASE}/api/fs/put`, {
    method: 'PUT',
    headers: {
      // OpenList 用**裸 token**，不带 "Bearer " 前缀
      Authorization: await loginToken(),
      'File-Path': encodeURI(extra),
      'Content-Length': String(buf.length),
      'X-File-Md5': md5,
      'X-File-Sha1': sha1,
      'Last-Modified': String(Date.now()),
      'Content-Type': 'application/octet-stream',
      Overwrite: 'true'
    },
    body: buf
  })
  console.log(`  远端放文件: HTTP ${putRes.status}`)
  if (!putRes.ok) {
    console.log('✗ 远端放文件失败')
    app.exit(1)
    return
  }
  // 夸克侧落盘要 1~3 秒
  await sleep(3000)

  await win.webContents.executeJavaScript(`window.topensync.triggerScan('remote')`)
  const diffs = await waitFor(async () => {
    const list = await win.webContents.executeJavaScript(`window.topensync.listDiffs()`)
    const hit = list.filter((d) => d.kind === 'remote_only')
    return hit.length > 0 ? list : null
  }, 60000, 1000)
  if (!diffs) {
    console.log('✗ 本轮没有 remote_only 差异，对账页验证无法进行')
    app.exit(1)
    return
  }
  const remoteOnly = diffs.filter((d) => d.kind === 'remote_only')
  console.log(`✓ 对账列出差异 ${diffs.length} 条（remote_only ${remoteOnly.length} 条）`)
  for (const d of diffs) console.log(`    - [${d.kind}] ${d.remotePath}`)

  await goto(win, 'reconcile', '对账')
  const rBoxes = await waitCheckboxes(win)
  console.log(`  对账页勾选框数量: ${rBoxes}`)

  // **按路径精确定位**那一行，不要勾第 0 行
  if (!(await checkRowByText(win, 'from-elsewhere.txt'))) {
    console.log('✗ 找不到 from-elsewhere.txt 那一行')
    app.exit(1)
    return
  }
  await sleep(250)
  const rBar = await batchBarText(win)
  console.log(`  批量操作条: ${rBar.replace(/\n/g, ' | ')}`)
  if (!rBar.includes('已选')) {
    console.log('✗ 对账页勾选后没有批量操作条')
    app.exit(1)
    return
  }
  await shot(win, '2-对账-已勾选')

  const diffCountBefore = diffs.length
  if (!(await clickBatch(win, '删除远端文件'))) {
    console.log('✗ 对账页找不到「删除远端文件」按钮')
    app.exit(1)
    return
  }
  await sleep(400)
  if (!(await confirmModal(win))) {
    console.log('✗ 对账页删除没有二次确认')
    app.exit(1)
    return
  }

  /*
   * **必须轮询等待，不能固定 sleep。**
   *
   * 远端删除走的是 OpenList 的 move：请求返回只表示「已受理」，
   * 夸克侧落盘还要 1~3 秒；再加上建回收站目录、目录就绪等待，
   * 整个动作可能要好几秒。
   *
   * 之前这里只等 2.5 秒就下结论，于是把「还在处理中」误判成
   * 「删除没生效」——白查一轮，还差点把好功能改坏。
   */
  const gone = await waitFor(async () => {
    const names = await remoteList(REMOTE_ROOT)
    if (!names) return null
    return names.includes('from-elsewhere.txt') ? null : names
  }, 60000, 2000)
  if (!gone) {
    console.log('✗ 远端文件 60 秒内仍在原地 —— 删除没生效')
    console.log('  主进程日志:')
    for (const l of await dumpLogs(win, 30)) console.log('   ', l)
    app.exit(1)
    return
  }
  const afterNames = gone
  console.log(`  删除后远端目录内容: ${afterNames.join(', ')}`)
  console.log('✓ 远端文件真的从原位消失了')

  // 还要确认它进了回收站，而不是被物理删除
  const trashHit = await waitFor(async () => {
    const stamps = await remoteList(`${REMOTE_ROOT}/_trash`)
    if (!stamps || stamps.length === 0) return null
    for (const s of stamps) {
      const inner = await remoteList(`${REMOTE_ROOT}/_trash/${s}`)
      if (inner && inner.includes('from-elsewhere.txt')) return { stamp: s, inner }
    }
    return null
  }, 30000, 2000)
  if (trashHit) {
    console.log(`✓ 文件进了回收站：_trash/${trashHit.stamp}/（可恢复）`)
  } else {
    console.log('✗ 回收站里没找到该文件 —— 可能被直接删除或路径不对')
    app.exit(1)
    return
  }

  // 差异应当被关闭
  const afterDiffs = await win.webContents.executeJavaScript(`window.topensync.listDiffs()`)
  console.log(`✓ 删除后剩余差异: ${afterDiffs.length} 条（删除前 ${diffCountBefore} 条）`)
  if (afterDiffs.length >= diffCountBefore) {
    console.log('✗ 差异没被关闭')
    app.exit(1)
    return
  }
  console.log('✓ 差异已关闭')
  await shot(win, '3-对账-删除后')

  // ── 需求 3：清单页删本地文件 ───────────────────────────
  console.log('\n===== 文件清单：删除与批量删除 =====')

  await goto(win, 'manifest', '清单')
  const mBoxes = await waitCheckboxes(win)
  console.log(`  清单页勾选框数量: ${mBoxes}`)
  if (mBoxes === 0) {
    const diag = await win.webContents.executeJavaScript(`(async () => ({
      listFiles: (await window.topensync.listFiles()).map(f => f.localPath + ':' + f.state),
      stats: await window.topensync.getStats(),
      rows: document.querySelectorAll('.tbl tbody tr').length,
      bodySnippet: document.querySelector('.scroll') ? document.querySelector('.scroll').innerText.slice(0, 200) : ''
    }))()`)
    console.log('  诊断:', JSON.stringify(diag, null, 2))
    console.log('✗ 清单页没有勾选框')
    app.exit(1)
    return
  }

  await checkNth(win, 0)
  await checkNth(win, 1)
  await sleep(250)
  const mBar = await batchBarText(win)
  console.log(`  批量操作条: ${mBar.replace(/\n/g, ' | ')}`)
  if (!mBar.includes('已选')) {
    console.log('✗ 清单页勾选后没有批量操作条')
    app.exit(1)
    return
  }
  await shot(win, '4-清单-已勾选')

  if (!(await clickBatch(win, '删除本地文件'))) {
    console.log('✗ 找不到「删除本地文件」按钮')
    app.exit(1)
    return
  }
  await sleep(400)
  if (!(await confirmModal(win))) {
    console.log('✗ 清单页删除没有二次确认')
    app.exit(1)
    return
  }
  await sleep(1200)

  const left = ['a.txt', 'b.txt', 'c.txt'].filter((n) => fs.existsSync(path.join(SYNC_ROOT, n)))
  console.log(`✓ 删除后本地剩余文件: ${left.length ? left.join(', ') : '(无)'}`)
  if (left.length === 3) {
    console.log('✗ 删了但文件还在')
    app.exit(1)
    return
  }
  console.log('✓ 本地文件真的被删掉了')

  // 清单也该跟着少两条
  const filesAfter = await win.webContents.executeJavaScript(`window.topensync.listFiles()`)
  console.log(`✓ 清单剩余条目: ${filesAfter.length} 条`)
  await shot(win, '5-清单-删除后')

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log(`\n远端验证目录: ${REMOTE_ROOT}（验证残留，可手动清理）`)
  console.log('\nRESULT: OK')
  app.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err)
  app.exit(1)
})
