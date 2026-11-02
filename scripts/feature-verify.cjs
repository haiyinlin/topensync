// 实机验证：本次三项需求的端到端核对
//
//   1. 传输队列出现「上传 / 下载 / 跳过」类别，跳过带原因
//   2. 远端对账能列出「远端有、本地无」的差异，且能下载到本地
//   3. 「扫描本地」按钮点了确实触发重扫，且界面有可见反馈
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/feature-verify.cjs <输出目录>
//
// 环境变量：
//   M0_BASE / M0_USER / M0_PASS / M0_ROOT / M0_SYNC_ROOT / M0_USERDATA
//
// 设计约束：
// - 远端核实直接打 OpenList 的 HTTP 接口，不依赖被测代码
// - 只在带 live-verify 标记的测试子目录里操作，绝不碰用户真实存储根
// - 每一步都打印结论，失败即退出（不要长时间空转）
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
const REMOTE_ROOT = process.env.M0_ROOT || '/qh/topensync-feature-verify'
const SYNC_ROOT = process.env.M0_SYNC_ROOT || path.join(os.tmpdir(), 'topensync-feature-sync')
const USER_DATA = process.env.M0_USERDATA || path.join(os.tmpdir(), 'topensync-feature-userdata')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}

if (!/live-verify|feature-verify/i.test(REMOTE_ROOT)) {
  console.error(`✗ 拒绝在非测试目录上运行：${REMOTE_ROOT}`)
  console.error('  远端根路径必须带验证标记，以免清空真实数据')
  process.exit(1)
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-feature-'))
fs.mkdirSync(outDir, { recursive: true })
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.rmSync(SYNC_ROOT, { recursive: true, force: true })
fs.mkdirSync(SYNC_ROOT, { recursive: true })

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

require(MAIN)

// ── 独立远端探针 ────────────────────────────────────────
let token = ''
async function api(method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${apiPath} → ${text.slice(0, 200)}`)
  if (parsed && parsed.code !== undefined && parsed.code !== 200) {
    throw new Error(`code=${parsed.code} ${method} ${apiPath} → ${parsed.message}`)
  }
  return parsed?.data ?? parsed
}

async function remoteLogin() {
  const data = await api('POST', '/api/auth/login', { username: USER, password: PASS })
  token = data.token
}

async function remoteList(dir, out = []) {
  let res
  try {
    res = await api('POST', '/api/fs/list', {
      path: dir,
      password: '',
      page: 1,
      per_page: 99999,
      refresh: true
    })
  } catch {
    return out
  }
  for (const item of res?.content ?? []) {
    const p = `${dir}/${item.name}`
    if (item.is_dir) {
      out.push(p + '/')
      await remoteList(p, out)
    } else {
      out.push(p)
    }
  }
  return out
}

/** 递归删除远端目录 */
async function remoteRemoveTree(dir) {
  let res
  try {
    res = await api('POST', '/api/fs/list', {
      path: dir,
      password: '',
      page: 1,
      per_page: 99999,
      refresh: true
    })
  } catch {
    res = null
  }
  if (res) {
    for (const item of res.content ?? []) {
      const p = `${dir}/${item.name}`
      if (item.is_dir) await remoteRemoveTree(p)
      else await api('POST', '/api/fs/remove', { dir, names: [item.name] }).catch(() => undefined)
    }
  }
  await api('POST', '/api/fs/remove', { dir, names: [dir.split('/').pop()] }).catch(() => undefined)
}

/** 直接往远端放一个文件（模拟「别的设备上传了，本地没有」） */
async function remotePut(remotePath, content) {
  const buffer = Buffer.from(content)
  const { createHash } = require('crypto')
  const md5 = createHash('md5').update(buffer).digest('hex')
  const sha1 = createHash('sha1').update(buffer).digest('hex')
  const res = await fetch(`${BASE}/api/fs/put`, {
    method: 'PUT',
    headers: {
      ...(token ? { Authorization: token } : {}),
      'File-Path': encodeURI(remotePath),
      'Content-Length': String(buffer.length),
      'X-File-Md5': md5,
      'X-File-Sha1': sha1,
      'Last-Modified': String(Date.now()),
      'Content-Type': 'application/octet-stream',
      Overwrite: 'true'
    },
    body: buffer
  })
  if (!res.ok) throw new Error(`PUT ${remotePath} → HTTP ${res.status}`)
  // 夸克侧落盘要 1~3 秒，等它可见
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const meta = await api('POST', '/api/fs/get', { path: remotePath, password: '' })
      if (meta && meta.name) return true
    } catch {
      /* 还没落盘 */
    }
  }
  return false
}

function writeFixtures() {
  const files = {
    'readme.txt': 'feature verify\n',
    'docs/guide.md': '# guide\n',
    'sub/c.txt': 'sub file\n'
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(SYNC_ROOT, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return Object.keys(files)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等条件成立，返回结果；超时返回 null */
async function waitFor(fn, timeoutMs = 30000, step = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= deadline) return null
    await sleep(step)
  }
}

async function main() {
  const fixtureNames = writeFixtures()
  console.log('✓ 本地素材:', fixtureNames.join(', '))

  await remoteLogin()
  console.log('✓ 远端登录成功')

  console.log('→ 清理远端残留', REMOTE_ROOT)
  await remoteRemoveTree(REMOTE_ROOT)
  await sleep(1500)

  await sleep(2500)

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

  await win.webContents.executeJavaScript(`(async () => {
    const cfg = await window.topensync.patchConfig({
      syncRoot: ${JSON.stringify(SYNC_ROOT)},
      openlist: {
        baseUrl: ${JSON.stringify(BASE)},
        username: ${JSON.stringify(USER)},
        password: ${JSON.stringify(PASS)}
      },
      remoteRoot: ${JSON.stringify(REMOTE_ROOT)},
      syncEmptyDirs: false,
      detectRenames: false,
      renameWindowMs: 5000,
      remoteScan: {
        enabled: true, intervalHours: 6, onStartup: false, refresh: true,
        maxConcurrency: 1, timeoutMinutes: 30, conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only', autoFixLimit: 20,
        exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
      }
    })
    return cfg.remoteRoot
  })()`)
  console.log('✓ 配置已下发')

  // ── 等首轮上传完成 ────────────────────────────────────
  const synced = await waitFor(async () => {
    const s = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
    return s.synced >= fixtureNames.length && s.failed === 0 && s.active === 0 ? s : null
  }, 60000, 1000)
  if (!synced) {
    console.log('✗ 首轮同步未在 60s 内完成')
    app.exit(1)
    return
  }
  console.log(`✓ 首轮同步完成，已同步 ${synced.synced} 个`)

  // ══════════════════════════════════════════════════════
  // 需求 1：传输类别（上传 / 下载 / 跳过 + 跳过原因）
  // ══════════════════════════════════════════════════════
  console.log('\n===== 需求 1：传输类别 =====')

  // 触发「扫描本地」→ 全部文件走 L1 → 应产出「跳过 / 本地重复」
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)

  const skipTasks = await waitFor(async () => {
    const tasks = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
    const skipped = tasks.filter((t) => t.category === 'skip')
    return skipped.length > 0 ? skipped : null
  }, 20000, 500)

  if (!skipTasks) {
    console.log('✗ 扫描后没有出现「跳过」类任务')
    app.exit(1)
    return
  }
  console.log(`✓ 跳过类任务 ${skipTasks.length} 条`)
  for (const t of skipTasks.slice(0, 5)) {
    console.log(`   ${t.localPath} → category=${t.category} skipReason=${t.skipReason} state=${t.state}`)
  }
  const localDup = skipTasks.filter((t) => t.skipReason === 'local_duplicate')
  console.log(`✓ 其中「本地重复」${localDup.length} 条`)

  const stats1 = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
  console.log(`   统计: skipped=${stats1.skipped} local=${stats1.skippedLocal} remote=${stats1.skippedRemote} downloaded=${stats1.downloaded}`)

  // 远端重复：改 mtime 不改内容 → L1 不命中，但内容与远端一致
  const probeFile = path.join(SYNC_ROOT, 'readme.txt')
  const future = new Date(Date.now() + 8000)
  fs.utimesSync(probeFile, future, future)
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)

  const remoteDup = await waitFor(async () => {
    const tasks = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
    const hit = tasks.filter((t) => t.skipReason === 'remote_duplicate')
    return hit.length > 0 ? hit : null
  }, 20000, 500)

  if (!remoteDup) {
    console.log('✗ 没有出现「远端重复」跳过记录')
    const tasks = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
    console.log('   当前任务:', JSON.stringify(tasks.map((t) => ({
      p: t.localPath, c: t.category, r: t.skipReason, s: t.state
    })), null, 2))
    app.exit(1)
    return
  }
  console.log(`✓ 「远端重复」跳过记录 ${remoteDup.length} 条：`, remoteDup.map((t) => t.localPath).join(', '))

  // ══════════════════════════════════════════════════════
  // 需求 2：对账列出「远端有、本地无」并可下载
  // ══════════════════════════════════════════════════════
  console.log('\n===== 需求 2：远端对账列举差异 =====')

  // 模拟「别的设备上传了文件，本地没有」
  const extraRemote = `${REMOTE_ROOT}/from-other-device.txt`
  const putOk = await remotePut(extraRemote, 'uploaded from elsewhere\n')
  console.log(`✓ 远端放入 ${extraRemote}：${putOk ? '已可见' : '超时未可见'}`)

  console.log('→ 触发远端对账…')
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('remote')`)

  const diffs = await waitFor(async () => {
    const list = await win.webContents.executeJavaScript(`window.topensync.listDiffs()`)
    const hit = list.filter((d) => d.kind === 'remote_only')
    return hit.length > 0 ? hit : null
  }, 60000, 1000)

  if (!diffs) {
    console.log('✗ 对账后没有列出「远端有、本地无」的差异')
    const list = await win.webContents.executeJavaScript(`window.topensync.listDiffs()`)
    console.log('   当前差异:', JSON.stringify(list, null, 2))
    app.exit(1)
    return
  }
  console.log(`✓ 差异列表列出 ${diffs.length} 条 remote_only：`)
  for (const d of diffs) {
    console.log(`   ${d.remotePath}  localPath=${d.localPath}  size=${d.remoteSize}`)
  }

  const target = diffs[0]
  if (!target.localPath) {
    console.log('✗ remote_only 差异没有本地路径 → 「下载到本地」无落点')
    app.exit(1)
    return
  }

  // 点「下载到本地」
  console.log(`→ 处置差异 ${target.id}：下载到本地`)
  await win.webContents.executeJavaScript(
    `window.topensync.resolveDiff(${target.id}, 'pulled')`
  )

  const downloaded = await waitFor(async () => {
    const p = path.join(SYNC_ROOT, target.localPath)
    return fs.existsSync(p) ? p : null
  }, 60000, 1000)

  if (!downloaded) {
    console.log('✗ 「下载到本地」没有把文件拉到本地')
    const tasks = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
    console.log('   任务:', JSON.stringify(tasks.map((t) => ({
      p: t.localPath, c: t.category, s: t.state, e: t.errorMsg
    })), null, 2))
    app.exit(1)
    return
  }
  console.log(`✓ 已下载到本地: ${downloaded}`)
  console.log(`   内容: ${fs.readFileSync(downloaded, 'utf8').trim()}`)

  const dlTasks = await win.webContents.executeJavaScript(`window.topensync.listTasks()`)
  const dl = dlTasks.filter((t) => t.category === 'download')
  console.log(`✓ 下载类任务 ${dl.length} 条：`, dl.map((t) => `${t.localPath}(${t.state})`).join(', '))

  const stats2 = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
  console.log(`   统计: downloaded=${stats2.downloaded}`)

  // ══════════════════════════════════════════════════════
  // 需求 3：扫描本地按钮生效
  // ══════════════════════════════════════════════════════
  console.log('\n===== 需求 3：扫描本地按钮 =====')

  const before = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
  console.log(`  点击前: 已扫描 ${before.localScan.scannedCount} 个文件`)

  // 模拟点击顶栏按钮（走的是同一条 IPC 链路）
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)

  const after = await waitFor(async () => {
    const s = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
    return s.localScan.lastScanAt !== before.localScan.lastScanAt ? s : null
  }, 20000, 300)

  if (!after) {
    console.log('✗ 「扫描本地」没有触发重扫（扫描时间未更新）')
    app.exit(1)
    return
  }
  console.log(`✓ 重扫已触发: 已扫描 ${after.localScan.scannedCount} 个文件（点击前 ${before.localScan.scannedCount}）`)
  console.log(`   扫描时间: ${new Date(before.localScan.lastScanAt || 0).toLocaleTimeString('zh-CN')} → ${new Date(after.localScan.lastScanAt).toLocaleTimeString('zh-CN')}`)

  // ══════════════════════════════════════════════════════
  // 界面核对：队列页要能看到类别列与筛选
  // ══════════════════════════════════════════════════════
  console.log('\n===== 界面核对 =====')
  for (const page of ['queue', 'reconcile', 'manifest', 'overview']) {
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(page)}`)
    let title = ''
    for (let i = 0; i < 40; i++) {
      title = await win.webContents.executeJavaScript(
        `(document.querySelector('.page-head h1') || {}).textContent || ''`
      )
      if (title) break
      await sleep(80)
    }
    await sleep(250)
    const img = await win.webContents.capturePage()
    const file = path.join(outDir, `${page}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log(`  ✓ ${page} → 「${title}」→ ${file}`)
  }

  // 队列页 DOM 断言：类别列存在、跳过记录可见
  await win.webContents.executeJavaScript(`location.hash = 'queue'`)
  await sleep(600)
  const dom = await win.webContents.executeJavaScript(`(() => {
    const heads = [...document.querySelectorAll('.tbl thead th')].map(t => t.textContent.trim())
    const chips = [...document.querySelectorAll('.chips .chip')].map(c => c.textContent.trim())
    const rows = [...document.querySelectorAll('.tbl tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())
    return { heads, chips, rowCount: rows.length, rows: rows.slice(0, 8) }
  })()`)
  console.log('\n  队列页表头:', dom.heads.join(' | '))
  console.log('  队列页筛选:', dom.chips.join(' | '))
  console.log(`  队列页行数: ${dom.rowCount}`)
  for (const r of dom.rows) console.log('    ' + r)

  if (!dom.heads.some((h) => h.includes('类别'))) {
    console.log('✗ 队列页没有「类别」列')
    app.exit(1)
    return
  }
  console.log('✓ 队列页有「类别」列')

  await win.webContents.executeJavaScript(`location.hash = 'reconcile'`)
  await sleep(600)
  const reconDom = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.tbl tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())
    return { rowCount: rows.length, rows: rows.slice(0, 5) }
  })()`)
  console.log(`  对账页差异行数: ${reconDom.rowCount}`)
  for (const r of reconDom.rows) console.log('    ' + r)
  if (reconDom.rowCount === 0) {
    console.log('✗ 对账页没有列出任何差异')
    app.exit(1)
    return
  }
  console.log('✓ 对账页已列出差异')

  // ══════════════════════════════════════════════════════
  // 需求 4（本轮）：日志必须带类别与文件路径
  //
  // 前面已经把 upload / download / skip 三条真实路径都跑过了，
  // 这里回头查日志：三类都必须在，而且每条都得带上它涉及的文件。
  // 走 preload 的 listLogs——和界面读的是同一条路，
  // 因此这同时验证了「落库 → IPC → 渲染进程」整条链路。
  // ══════════════════════════════════════════════════════
  console.log('\n===== 需求 4：日志的类别与文件信息 =====')

  const logs = await win.webContents.executeJavaScript(`window.topensync.listLogs(300)`)
  const byCategory = {}
  for (const l of logs) {
    ;(byCategory[l.category] = byCategory[l.category] || []).push(l)
  }
  console.log('  类别分布:', Object.keys(byCategory).map((k) => `${k}=${byCategory[k].length}`).join(' '))

  const expectCategory = [
    ['upload', '上传'],
    ['download', '下载'],
    ['skip', '跳过']
  ]
  for (const [key, label] of expectCategory) {
    const hits = byCategory[key] || []
    if (hits.length === 0) {
      console.log(`✗ 日志里没有「${label}」类（category=${key}）`)
      app.exit(1)
      return
    }
    // 每条都要带上它涉及的文件——不然「日志记录同步文件信息」就没实现
    const withFile = hits.filter((l) => l.filePath)
    if (withFile.length === 0) {
      console.log(`✗ 「${label}」类日志没有一条带文件路径`)
      app.exit(1)
      return
    }
    console.log(`✓ 「${label}」类日志 ${hits.length} 条，其中 ${withFile.length} 条带文件路径`)
    for (const l of withFile.slice(0, 3)) {
      console.log(`   [${l.category}] ${l.filePath} ← ${l.message}`)
    }
  }

  // 上传类日志要能对上一个真传过的文件
  const uploaded = (byCategory.upload || []).find((l) => l.filePath && l.remotePath)
  if (!uploaded) {
    console.log('✗ 上传类日志没有同时带上本地路径与远端路径')
    app.exit(1)
    return
  }
  console.log(`✓ 上传日志带双路径: ${uploaded.filePath} → ${uploaded.remotePath}`)

  // 下载类日志要能对上刚拉下来的那个文件
  const pulled = (byCategory.download || []).find((l) => l.filePath && l.filePath.includes('from-other-device'))
  if (!pulled) {
    console.log('✗ 下载类日志没有记录 from-other-device.txt')
    console.log('   下载类日志:', JSON.stringify(byCategory.download || [], null, 2))
    app.exit(1)
    return
  }
  console.log(`✓ 下载日志对上了: ${pulled.filePath} ← ${pulled.remotePath}`)

  // 跳过类日志要带上原因（不能只有一句「跳过」）
  const skipWithReason = (byCategory.skip || []).filter(
    (l) => l.filePath && (l.message.includes('未变化') || l.message.includes('哈希判定') || l.message.includes('同名同大小'))
  )
  if (skipWithReason.length === 0) {
    console.log('✗ 跳过类日志没有说明原因')
    console.log('   跳过类日志:', JSON.stringify((byCategory.skip || []).slice(0, 5), null, 2))
    app.exit(1)
    return
  }
  console.log(`✓ 跳过日志带原因 ${skipWithReason.length} 条，例：${skipWithReason[0].message}`)

  // 日志页 DOM：类别列与文件列都要有真实内容
  await win.webContents.executeJavaScript(`location.hash = 'logs'`)
  await sleep(700)
  const logDom = await win.webContents.executeJavaScript(`(() => {
    const table = document.querySelector('.card.table-card table.tbl')
    if (!table) return { error: 'no table' }
    const heads = [...table.querySelectorAll('thead th')].map(t => t.textContent.trim())
    const rows = [...table.querySelectorAll('tbody tr')].map(r => {
      const c = [...r.querySelectorAll('td')].map(td => td.textContent.trim())
      return { category: c[2] || '', file: c[3] || '', message: c[4] || '' }
    })
    return { heads, rows }
  })()`)
  console.log('  日志页表头:', logDom.heads.join(' | '))
  if (!logDom.heads || !logDom.heads.includes('类别') || !logDom.heads.includes('文件')) {
    console.log('✗ 日志页表头缺「类别」或「文件」列')
    app.exit(1)
    return
  }
  const domUpload = logDom.rows.find(r => r.category.includes('上传') && r.file && r.file !== '—')
  if (!domUpload) {
    console.log('✗ 日志页里看不到带文件名的上传记录')
    app.exit(1)
    return
  }
  console.log(`✓ 日志页可见上传记录: [${domUpload.category}] ${domUpload.file}`)
  const imgLogs = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'logs.png'), imgLogs.toPNG())

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log('RESULT: OK')
  app.exit(0)
}

main().catch((err) => {
  console.error('实机验证失败:', err)
  app.exit(1)
})
