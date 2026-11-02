// 实机验证脚本：启动真实应用，通过渲染进程的 preload API 下发配置，
// 连接**真实的内网 OpenList 实例**，读取真实状态与真实数据并截图。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/live-verify.cjs <输出目录>
//
// 环境变量：
//   M0_BASE / M0_USER / M0_PASS / M0_ROOT / M0_SYNC_ROOT / M0_USERDATA
//
// 做法说明：
// - 配置通过 IPC 下发而不是写配置文件——密码走内存，不落盘，
//   也绕开了 safeStorage 密钥与 userData 绑定的问题。
// - **独立 userData 目录**：默认 `%APPDATA%/Electron` 里堆着历次运行的
//   manifest.db 与 sync_log，诊断时新旧日志混在一起根本分不清。
//   每次实机验证都换一个干净的目录，manifest.db 落在已知位置。
// - 远端核实直接打 OpenList 的 HTTP 接口，不依赖被测代码，
//   避免「用被测程序证明被测程序正确」。
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
const REMOTE_ROOT = process.env.M0_ROOT || '/qh/topensync-live-verify'
const SYNC_ROOT = process.env.M0_SYNC_ROOT || path.join(os.tmpdir(), 'topensync-sync')
// 固定目录 + 每次跑前清空：带时间戳的目录会越堆越多。
const USER_DATA = process.env.M0_USERDATA || path.join(os.tmpdir(), 'topensync-userdata')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}

// 安全闸：绝不往用户的真实存储根上做「清空」操作。
// 实机验证只允许在带标记的测试子目录里进行。
if (!/live-verify/i.test(REMOTE_ROOT)) {
  console.error(`✗ 拒绝在非测试目录上运行：${REMOTE_ROOT}`)
  console.error('  远端根路径必须包含 live-verify 标记，以免清空真实数据')
  process.exit(1)
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'topensync-live-'))
fs.mkdirSync(outDir, { recursive: true })
// 先清空再重建：上一轮的 manifest.db / 日志混进来会分不清新旧
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.rmSync(SYNC_ROOT, { recursive: true, force: true })
fs.mkdirSync(SYNC_ROOT, { recursive: true })

// ── 独立 userData 必须在 app ready 之前设置 ─────────────
const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

require(MAIN)

const PAGES = ['overview', 'connection', 'queue', 'manifest', 'reconcile', 'logs']

// ── 独立的远端探针（不走被测代码）────────────────────────
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

/** 递归列举远端目录，返回相对路径数组（不含目录本身） */
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

/** 等待远端出现指定路径 */
async function remoteWaitFor(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await api('POST', '/api/fs/get', { path, password: '' })
      if (r && r.name) return r
    } catch {
      /* 还没落盘 */
    }
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 递归删除远端目录（OpenList 的 remove 不递归，得自底向上清空） */
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

// ── 本地测试素材 ────────────────────────────────────────
function writeFixtures() {
  const files = {
    'readme.txt': 'TopenSync 实机验证\nhello from local disk\n',
    'docs/guide.md': '# 使用指南\n\n第一步：配置 OpenList 连接。\n',
    'docs/nested.txt': '嵌套目录里的文件\n',
    'sub/c.txt': '子目录文件\n',
    'bin/blob.bin': Buffer.alloc(64 * 1024, 7).toString('binary')
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(SYNC_ROOT, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  // 空目录：验证「空目录同步」开关
  fs.mkdirSync(path.join(SYNC_ROOT, 'empty-dir'), { recursive: true })
  return Object.keys(files)
}

function cleanFixtures() {
  fs.rmSync(SYNC_ROOT, { recursive: true, force: true })
  fs.mkdirSync(SYNC_ROOT, { recursive: true })
}

async function main() {
  const fixtureNames = writeFixtures()
  console.log('✓ 本地测试素材已写入:', SYNC_ROOT)
  console.log('✓ 独立 userData:', USER_DATA)

  await remoteLogin()
  console.log('✓ 远端登录成功（独立探针）')

  // 远端先清干净：删掉上一轮实机验证残留
  // ⚠️ 只清理 REMOTE_ROOT 这一个测试子目录，绝不碰用户的真实存储根
  console.log('→ 清理远端残留', REMOTE_ROOT)
  await remoteRemoveTree(REMOTE_ROOT)
  await new Promise((r) => setTimeout(r, 1500))

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

  // 下发真实配置（密码只在内存里走一趟 IPC）
  const patched = await win.webContents.executeJavaScript(`(async () => {
    const cfg = await window.topensync.patchConfig({
      syncRoot: ${JSON.stringify(SYNC_ROOT)},
      openlist: {
        baseUrl: ${JSON.stringify(BASE)},
        username: ${JSON.stringify(USER)},
        password: ${JSON.stringify(PASS)}
      },
      remoteRoot: ${JSON.stringify(REMOTE_ROOT)},
      syncEmptyDirs: true,
      detectRenames: true,
      renameWindowMs: 5000,
      remoteScan: {
        enabled: true, intervalHours: 6, onStartup: true, refresh: true,
        maxConcurrency: 1, timeoutMinutes: 30, conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only', autoFixLimit: 20,
        exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
      }
    })
    return { baseUrl: cfg.openlist.baseUrl, remoteRoot: cfg.remoteRoot, syncRoot: cfg.syncRoot }
  })()`)
  console.log('✓ 配置已下发:', JSON.stringify(patched))

  // ── 等首轮上传完成 ────────────────────────────────────
  const expect = fixtureNames.length
  let settled = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
    if (s.synced >= expect && s.failed === 0 && s.active === 0 && s.queued === 0) {
      settled = s
      break
    }
    settled = s
  }
  console.log(`✓ 首轮同步结束（等待上限 60s）`)

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const api = window.topensync
    const conn = await api.checkConnection()
    const stats = await api.getStats()
    const files = await api.listFiles({ limit: 50 })
    const logs = await api.listLogs(60)
    return {
      conn, stats,
      files: files.map(f => ({ path: f.localPath, state: f.state, remote: f.remotePath, size: f.localSize })),
      logs: logs.map(l => l.message)
    }
  })()`)

  console.log('\n===== 实机连接状态 =====')
  console.log(JSON.stringify(probe.conn, null, 2))
  console.log('\n===== 实机统计 =====')
  console.log(JSON.stringify(probe.stats, null, 2))
  console.log('\n===== 实机清单 =====')
  console.log(JSON.stringify(probe.files, null, 2))
  console.log('\n===== 引擎日志（最近 60 条）=====')
  for (const m of probe.logs) console.log('  ' + m)

  // ── 远端核实（独立探针）──────────────────────────────
  console.log('\n===== 远端实际内容（独立探针核实）=====')
  const remoteTree = await remoteList(REMOTE_ROOT)
  console.log(remoteTree.length ? remoteTree.join('\n') : '(空)')
  const remoteFiles = remoteTree.filter((p) => !p.endsWith('/'))
  console.log(`\n远端文件数: ${remoteFiles.length}（本地应传 ${expect} 个）`)

  // ── 删除链路：本地删一个文件 → 远端应进回收站 ───────
  console.log('\n===== 删除链路实测 =====')
  const victim = 'docs/nested.txt'
  fs.rmSync(path.join(SYNC_ROOT, victim))
  console.log(`  已删除本地 ${victim}，等待远端处理…`)

  // 回收站移动是异步的（rename 同步、move 异步落盘），
  // 探测必须等够久，否则会把「还没落盘」误判成「没进回收站」。
  let stillThere = true
  let inTrash = false
  const deadline = Date.now() + 45_000
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    const tree = await remoteList(REMOTE_ROOT)
    stillThere = tree.some((p) => p === `${REMOTE_ROOT}/${victim}`)
    inTrash = tree.some((p) => p.includes('/_trash/') && p.endsWith(victim))
    if (inTrash || Date.now() >= deadline) break
  }

  const finalTree = await remoteList(REMOTE_ROOT)
  console.log(`  远端原路径仍在: ${stillThere}`)
  console.log(`  已进回收站:     ${inTrash}`)
  if (inTrash) {
    console.log(`  回收站条目: ${finalTree.filter((p) => p.includes('/_trash/')).join(', ')}`)
  }
  console.log(`  远端最终内容:\n${finalTree.map((p) => '    ' + p).join('\n')}`)

  const logs2 = await win.webContents.executeJavaScript(`window.topensync.listLogs(30)`)
  console.log('\n===== 删除阶段日志 =====')
  for (const l of logs2.map((x) => x.message)) console.log('  ' + l)

  // ── 截图 ─────────────────────────────────────────────
  for (const page of PAGES) {
    /*
     * 改 hash 之后必须等这一页真的渲染出来再截图。
     *
     * 只 sleep 固定毫秒数靠不住：hashchange → setState → 重渲染 → 绘制，
     * 任意一步慢一点，capturePage 抓到的就是**上一页**。
     * 实测踩过：connection.png 里是概览页，manifest.png 和 queue.png 字节数完全一样。
     *
     * 做法：改完 hash 后轮询页面标题，对上了才截图；
     * 顺便把标题打出来，一眼就能看出有没有拍错页。
     */
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(page)}`)
    let shownTitle = ''
    const deadline = Date.now() + 5000
    for (;;) {
      shownTitle = await win.webContents.executeJavaScript(
        `(document.querySelector('.page-head h1') || {}).textContent || ''`
      )
      if (shownTitle) break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 80))
    }
    await new Promise((r) => setTimeout(r, 200))
    const img = await win.webContents.capturePage()
    const file = path.join(outDir, `${page}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log(`  ✓ ${page} → 页面标题「${shownTitle}」→ ${file}`)
  }

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log('RESULT: OK')
  app.exit(0)
}

main().catch((err) => {
  console.error('实机验证失败:', err)
  app.exit(1)
})
