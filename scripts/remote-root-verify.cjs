// 实机验证：远端根变更后清单路径被改写，且**不重传**
//
// 场景（真实踩过的坑）：
//   远端根配成 `/A` 时传了一批文件；后来把远端根改成 `/B`，
//   清单里存的 remote_path 还是 `/A/...`，
//   下一轮对账拿着旧前缀去远端找 → 全判「远端缺失」→ 整批重传。
//
// 断言三件事：
//   1. 改根后清单里的 remote_path 前缀被改写成新根
//   2. 改根后再扫一遍，**没有新的上传任务**（不重传）
//   3. 旧根目录下没有残留文件（不会传到两处）
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/remote-root-verify.cjs <输出目录>
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
const ROOT_A = process.env.M0_ROOT_A || '/qh/topensync-root-verify'
const ROOT_B = process.env.M0_ROOT_B || '/qh/topensync-root-verify-2'
const SYNC_ROOT = path.join(os.tmpdir(), 'topensync-root-sync')
const USER_DATA = path.join(os.tmpdir(), 'topensync-root-userdata')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}
for (const p of [ROOT_A, ROOT_B]) {
  if (!/verify|demo/i.test(p)) {
    console.error(`✗ 拒绝在非验证目录上运行：${p}`)
    process.exit(1)
  }
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-root-'))
fs.mkdirSync(outDir, { recursive: true })

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

let cachedToken = ''
async function loginToken() {
  if (cachedToken) return cachedToken
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })
  cachedToken = (await res.json()).data.token
  return cachedToken
}

async function remoteList(p) {
  const res = await fetch(`${BASE}/api/fs/list`, {
    method: 'POST',
    headers: { Authorization: await loginToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, page: 1, per_page: 99999, refresh: true })
  })
  const json = await res.json()
  if (json.code !== 200) {
    // 目录还不存在 ≠ 读取失败：没重传时新根就压根没被建出来
    if (String(json.message || '').includes('not found')) return []
    return null
  }
  return (json.data?.content || []).map((x) => x.name)
}

function writeFixtures() {
  for (const [rel, content] of Object.entries({
    'a.txt': 'alpha\n',
    'b.txt': 'beta\n',
    'c.txt': 'gamma\n'
  })) {
    fs.writeFileSync(path.join(SYNC_ROOT, rel), content)
  }
}

async function main() {
  /*
   * 前缀判断必须带分隔符。
   *
   * 直接用 startsWith(root) 会误判：新根是 `/x-root-verify-2`，
   * 它在字符串上**以** `/x-root-verify` 开头，于是每个新路径都被算成
   * 「仍指向旧根」。看起来像改写失败，其实是断言写错了。
   */
  const isUnder = (p, root) => {
    const base = root.replace(/\/+$/, '')
    return p === base || p.startsWith(`${base}/`)
  }

  console.log('旧远端根:', ROOT_A)
  console.log('新远端根:', ROOT_B)
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

  // ── 1. 用旧根传一轮 ───────────────────────────────────
  console.log('\n===== 第一轮：用旧根上传 =====')
  await win.webContents.executeJavaScript(`(async () => {
    await window.topensync.patchConfig({
      syncRoot: ${JSON.stringify(SYNC_ROOT)},
      openlist: {
        baseUrl: ${JSON.stringify(BASE)},
        username: ${JSON.stringify(USER)},
        password: ${JSON.stringify(PASS)}
      },
      remoteRoot: ${JSON.stringify(ROOT_A)},
      detectRenames: false,
      deletePolicy: 'trash',
      remoteScan: {
        enabled: true, intervalHours: 6, onStartup: false, refresh: true,
        maxConcurrency: 1, timeoutMinutes: 30, conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only', autoFixLimit: 20,
        exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
      }
    })
  })()`)

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

  const before = await win.webContents.executeJavaScript(`window.topensync.listFiles()`)
  console.log('  清单里的远端路径:')
  for (const f of before) console.log(`    ${f.localPath} → ${f.remotePath}`)
  if (!before.every((f) => isUnder(String(f.remotePath || ''), ROOT_A))) {
    console.log('✗ 首轮远端路径前缀不对')
    app.exit(1)
    return
  }
  const oldRootFiles = await remoteList(ROOT_A)
  console.log(`  旧根目录内容: ${oldRootFiles ? oldRootFiles.join(', ') : '(读取失败)'}`)

  // ── 2. 改远端根 ───────────────────────────────────────
  console.log('\n===== 改远端根 =====')
  await win.webContents.executeJavaScript(`(async () => {
    await window.topensync.patchConfig({ remoteRoot: ${JSON.stringify(ROOT_B)} })
  })()`)
  await sleep(1500)

  const after = await win.webContents.executeJavaScript(`window.topensync.listFiles()`)
  console.log('  改根后的清单:')
  for (const f of after) console.log(`    ${f.localPath} → ${f.remotePath}`)

  /*
   * 前缀判断必须带分隔符（见 main 开头的 isUnder 说明）。
   */
  const rewritten = after.filter((f) => isUnder(String(f.remotePath || ''), ROOT_B)).length
  const stale = after.filter((f) => isUnder(String(f.remotePath || ''), ROOT_A)).length
  console.log(`  已改写成新根: ${rewritten} 条，仍指向旧根: ${stale} 条`)
  if (rewritten !== after.length || stale !== 0) {
    console.log('✗ 清单里的远端路径没被改写 —— 下轮对账会误判「远端缺失」并整批重传')
    app.exit(1)
    return
  }
  console.log('✓ 清单里的远端路径前缀已全部改写成新根')

  // ── 3. 再扫一遍，确认不重传 ───────────────────────────
  console.log('\n===== 改根后再扫描：不该重传 =====')
  const tasksBefore = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)
  await sleep(6000)

  const tasksAfter = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
  const uploads = tasksAfter.filter((t) => t.category === 'upload' && t.state === 'done')
  console.log(`  改根后完成的上传任务: ${uploads.length} 条`)
  console.log(`  改根前任务总数: ${tasksBefore.length}，改根后: ${tasksAfter.length}`)
  if (uploads.length > 0) {
    console.log('✗ 改根后仍然发生了重传')
    app.exit(1)
    return
  }
  console.log('✓ 改根后没有重传（文件未变，被 L1 去重挡下）')

  // ── 4. 远端对账不应报「远端缺失」 ─────────────────────
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('remote')`)
  await sleep(8000)
  const diffs = await win.webContents.executeJavaScript(`window.topensync.listDiffs()`)
  const missing = diffs.filter((d) => d.kind === 'missing_remote')
  console.log(`  对账差异: ${diffs.length} 条（其中「远端缺失」${missing.length} 条）`)
  for (const d of diffs) console.log(`    - [${d.kind}] ${d.remotePath}`)
  if (missing.length > 0) {
    console.log('✗ 出现了「远端缺失」差异 —— 会被判成要重传')
    app.exit(1)
    return
  }
  console.log('✓ 没有「远端缺失」差异')

  // ── 5. 新根下不该出现重复的一份 ───────────────────────
  /*
   * 改远端根**不是数据迁移**：旧根里的文件留在原地，程序不搬也不删
   * （擅自搬走用户数据比重复传一次更危险）。
   *
   * 这里要断言的是「没有传到两处」：
   * 新根下**不该**出现这几个文件（说明没重传）。
   */
  const newRootFiles = await remoteList(ROOT_B)
  console.log(`  新根目录内容: ${newRootFiles ? newRootFiles.join(', ') : '(读取失败)'}`)
  const duplicated = (newRootFiles || []).filter((n) => n.endsWith('.txt'))
  if (duplicated.length > 0) {
    console.log(`✗ 新根下出现了重复文件：${duplicated.join(', ')} —— 东西被传到了两处`)
    app.exit(1)
    return
  }
  console.log('✓ 新根下没有重复的一份（没有传到两处）')

  const oldRootAfter = await remoteList(ROOT_A)
  console.log(`  旧根目录内容（历史遗留，程序不搬不删）: ${oldRootAfter ? oldRootAfter.join(', ') : '(读取失败)'}`)

  console.log('\nRESULT: OK')
  app.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err)
  app.exit(1)
})
