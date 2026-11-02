// 真实实例端到端验证：认领闸门到底能不能挡住「重复上传」。
//
// 场景：本地有一批文件，远端**已经有**同名同大小的文件，
// 但本程序**从未同步过**它们。清过 userData / 换了台设备之后就是这个状态。
// 以前这一批会整批再上行一遍（覆盖远端，还留下 .openlist_to_delete 中间态）。
//
// 做法：
//   1. 在远端建一个专用测试目录（名字带 adopt-verify 标记，便于清理）
//   2. 用 OpenList API 直接把「同名同大小」的文件放进去 —— 模拟别的设备传上去的
//   3. 起真实应用连上去，让它扫本地这批文件
//   4. 断言：远端那批文件的 **modified 时间没变**（没被覆盖 = 没重复上传）
//           清单里三条都是 synced + verify_level='size'
//   5. 清理远端测试目录
//
// 用法：
//   M0_BASE=http://192.168.100.10:5244 M0_USER=admin M0_PASS=xxx \
//     env -u ELECTRON_RUN_AS_NODE npx electron scripts/adopt-live.cjs
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
if (!BASE || !USER || !PASS) {
  console.error('✗ 需要环境变量 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}

/** 远端测试根：名字带标记，绝不碰用户自己的目录 */
const REMOTE_ROOT = '/qh/topensync-adopt-verify'
if (!REMOTE_ROOT.includes('adopt-verify')) {
  console.error('✗ 远端根必须含 adopt-verify 标记，拒绝运行')
  process.exit(1)
}

const USER_DATA = path.join(os.tmpdir(), 'topensync-adopt-live')
const SYNC_DIR = path.join(os.tmpdir(), 'topensync-adopt-live-sync')
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.rmSync(SYNC_DIR, { recursive: true, force: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(SYNC_DIR, { recursive: true })

/** 用例：match（默认，同名同大小 → 应认领）/ size-diff（大小不同 → 应照常上传） */
const CASE = process.env.ADOPT_CASE || 'match'

const FILES = [
  { name: 'adopt-a.txt', body: 'ADOPT-VERIFY-CONTENT-A' },
  { name: 'adopt-b.txt', body: 'ADOPT-VERIFY-CONTENT-B' },
  { name: 'adopt-c.txt', body: 'ADOPT-VERIFY-CONTENT-C' }
]
for (const f of FILES) fs.writeFileSync(path.join(SYNC_DIR, f.name), f.body)

/*
 * 远端预置用**同长度但不同字节**的内容。
 *
 * 这样「有没有被覆盖上传」就能靠**内容比对**判定，
 * 不必依赖 modified 时间戳——
 * 夸克侧的落盘是异步的，文件真正落地时 modified 还会再漂一次，
 * 拿它做断言会误报（实测踩过：PUT 后 1~2 秒 modified 还在变）。
 *
 * length 相同：长度不同就触发不了「同名 + 同大小」认领，
 * 测的就不是认领闸门了。
 * size-diff 用例则故意用不同长度——这时应当照常上传。
 */
const REMOTE_BODY = (body) =>
  CASE === 'size-diff' ? body + '-LONGER' : (body[0] === 'A' ? 'X' : 'A') + body.slice(1)

let token = ''

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text, status: res.status }
  }
}

async function listDir(dir) {
  const j = await api('POST', '/api/fs/list', {
    path: dir,
    password: '',
    page: 1,
    per_page: 99999,
    refresh: false
  })
  return j.data?.content || []
}

async function mkdirp(dir) {
  const parts = dir.split('/').filter(Boolean)
  let cur = ''
  for (const p of parts) {
    cur += `/${p}`
    await api('POST', '/api/fs/mkdir', { path: cur })
  }
}

/** 用 OpenList 的 PUT 放一个文件上去（模拟别的设备上传） */
async function putFile(remotePath, content) {
  const buf = Buffer.from(content, 'utf8')
  const md5 = crypto.createHash('md5').update(buf).digest('hex')
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex')
  const res = await fetch(`${BASE}/api/fs/put`, {
    method: 'PUT',
    headers: {
      Authorization: token,
      'File-Path': encodeURI(remotePath),
      'Content-Length': String(buf.length),
      'X-File-Md5': md5,
      'X-File-Sha1': sha1,
      'Last-Modified': String(Date.now()),
      'Content-Type': 'application/octet-stream',
      Overwrite: 'true'
    },
    body: buf
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, code: parsed?.code, message: parsed?.message }
}

async function removeTree(dir) {
  const content = await listDir(dir)
  for (const c of content) {
    const p = `${dir}/${c.name}`
    if (c.is_dir) await removeTree(p)
    else await api('POST', '/api/fs/remove', { dir, names: [c.name] })
  }
  const parent = dir.slice(0, dir.lastIndexOf('/'))
  const name = dir.slice(dir.lastIndexOf('/') + 1)
  await api('POST', '/api/fs/remove', { dir: parent, names: [name] })
}

/** 下载远端文件的内容（GET /d 必须带 sign） */
async function downloadRemote(remotePath, sign) {
  const url = `${BASE}/d${encodeURI(remotePath)}${sign ? `?sign=${encodeURIComponent(sign)}` : ''}`
  const res = await fetch(url, { headers: token ? { Authorization: token } : {} })
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer()).toString('utf8')
}

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

function readManifest() {
  const p = path.join(USER_DATA, 'manifest.db')
  if (!fs.existsSync(p)) return []
  const db = new DatabaseSync(p, { readOnly: true })
  const rows = db
    .prepare(
      'SELECT local_path, state, synced_size, synced_md5, synced_sha1, verify_level FROM files'
    )
    .all()
  db.close()
  return rows
}

async function main() {
  // ── 1. 登录并准备远端测试目录 ──────────────────────
  const lj = await api('POST', '/api/auth/login', { username: USER, password: PASS })
  if (!lj?.data?.token) {
    console.error('✗ 登录失败:', JSON.stringify(lj).slice(0, 200))
    app.exit(1)
    return
  }
  token = lj.data.token
  console.log('已登录:', BASE)

  await removeTree(REMOTE_ROOT).catch(() => undefined)
  await mkdirp(REMOTE_ROOT)

  for (const f of FILES) {
    const r = await putFile(`${REMOTE_ROOT}/${f.name}`, REMOTE_BODY(f.body))
    console.log(`  远端预置 ${f.name} → HTTP ${r.status} code=${r.code}`)
  }

  // 等远端可见（OpenList 的落盘是异步的）
  for (let i = 0; i < 20; i++) {
    const c = await listDir(REMOTE_ROOT)
    if (c.filter((x) => !x.is_dir).length === FILES.length) break
    await new Promise((r) => setTimeout(r, 1000))
  }

  /*
   * 等远端**稳定**再拍「应用启动前」的快照。
   *
   * OpenList 的落盘是异步的：PUT 返回 200 时，夸克侧的文件还没进目录列表，
   * 它的 modified 会在之后陆续变成真正的落盘时间。
   * 刚 PUT 完就拍快照，拍到的是「还没稳定」的中间态，
   * 后面再比就会误判成「被覆盖上传了」。
   *
   * 判据：连续两次列举得到的 modified 完全一致，才算稳定。
   */
  let before = []
  for (let i = 0; i < 20; i++) {
    const cur = (await listDir(REMOTE_ROOT)).filter((x) => !x.is_dir)
    const sig = cur.map((c) => `${c.name}:${c.size}:${c.modified}`).join('|')
    const prevSig = before.map((c) => `${c.name}:${c.size}:${c.modified}`).join('|')
    if (sig === prevSig && cur.length === FILES.length) break
    before = cur
    await new Promise((r) => setTimeout(r, 1500))
  }

  console.log('\n远端测试目录（应用启动前，已稳定）:')
  for (const c of before) {
    console.log(`   ${c.name}  size=${c.size}  modified=${c.modified}`)
  }
  const modifiedBefore = new Map(before.map((c) => [c.name, c.modified]))

  // ── 2. 起真实应用并配好连接 ────────────────────────
  try {
    require(MAIN)
  } catch (err) {
    console.error('✗ 主模块加载失败:', err)
    app.exit(1)
    return
  }

  await new Promise((r) => setTimeout(r, 3500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('✗ 没有创建窗口')
    app.exit(1)
    return
  }

  /*
   * 用应用自己的 IPC 写配置。
   *
   * 直接写 config.json 是不行的：密码字段在磁盘上是 safeStorage 密文，
   * 明文会被 decryptSecret 吞掉 → 密码变空 → 登录失败。
   * 走 patchConfig 才能让密文正确落盘。
   */
  await win.webContents.executeJavaScript(
    `window.topensync.patchConfig({
       syncRoot: ${JSON.stringify(SYNC_DIR)},
       openlist: { baseUrl: ${JSON.stringify(BASE)}, username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} },
       remoteRoot: ${JSON.stringify(REMOTE_ROOT)},
       remoteScan: { enabled: true, intervalHours: 6, onStartup: true, refresh: true, maxConcurrency: 1, timeoutMinutes: 10, conflictPolicy: 'local-wins', remoteOnlyPolicy: 'record-only', autoFixLimit: 20, adoptByNameAndSize: true, exclude: [] }
     })`
  )
  console.log('\n配置已写入，等待扫描与流水线跑完…')
  await new Promise((r) => setTimeout(r, 15000))

  // ── 3. 断言 ────────────────────────────────────────
  const rows = readManifest()
  const after = await listDir(REMOTE_ROOT)

  console.log('\n===== 清单 =====')
  for (const r of rows) console.log(' ', JSON.stringify(r))
  console.log('\n===== 远端测试目录（应用跑完后）=====')
  for (const c of after.filter((x) => !x.is_dir)) {
    console.log(`   ${c.name}  size=${c.size}  modified=${c.modified}`)
  }

  let failed = 0
  const check = (ok, msg) => {
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} ${msg}`)
  }

  const unchanged = after
    .filter((x) => !x.is_dir)
    .every((c) => modifiedBefore.get(c.name) === c.modified)
  console.log(`  （参考）远端 modified 时间是否变化: ${unchanged ? '未变' : '有变化'}`)

  /*
   * 决定性断言：**内容**有没有被改。
   *
   * 远端预置的是「同长度、不同字节」的内容。
   * 应用若把本地那份传上去，远端内容就会变成本地那份；
   * 若只是认领，远端内容必须一字不差地保持原样。
   */
  let contentSame = true
  for (const c of after.filter((x) => !x.is_dir)) {
    const remote = await downloadRemote(`${REMOTE_ROOT}/${c.name}`, c.sign)
    const local = FILES.find((f) => f.name === c.name)
    const expect = REMOTE_BODY(local.body)
    const ok = remote === expect
    if (!ok) contentSame = false
    console.log(
      `   ${c.name}  远端内容=${JSON.stringify(remote)}  期望=${JSON.stringify(expect)}  ${ok ? '✓' : '✗'}`
    )
  }

  if (CASE === 'match') {
    check(contentSame, '远端文件内容一字未改 —— 没有被覆盖上传（这就是「不重复传」）')
    check(rows.length === 3, `清单里有 3 条记录（实际 ${rows.length}）`)
    check(
      rows.length === 3 && rows.every((r) => r.state === 'synced'),
      '三条记录都是「已同步」'
    )
    check(
      rows.every((r) => r.verify_level === 'size'),
      '三条记录都标记为「仅大小」弱认定'
    )
    check(
      rows.every((r) => r.synced_md5 === null && r.synced_sha1 === null),
      '认领没有写哈希基准（没校验内容不能谎称哈希确认）'
    )
    check(
      rows.every((r) => r.verify_level !== 'hash'),
      '没有任何一条是「哈希确认」—— 说明走的是认领而不是上传（上传会写哈希基准）'
    )
  } else {
    // 反向用例：大小不同 → 不该认领，必须照常上传覆盖
    const overwritten = after.filter((x) => !x.is_dir).every((c) => {
      const local = FILES.find((f) => f.name === c.name)
      return c.size === Buffer.byteLength(local.body)
    })
    check(overwritten, '大小不同时照常上传（远端文件大小已变成本地那份的大小）')
    check(
      rows.every((r) => r.verify_level === 'hash'),
      '上传成功的记录标记为「哈希确认」'
    )
  }

  const shot = await win.webContents.capturePage()
  fs.writeFileSync(path.join(os.tmpdir(), 'topensync-adopt-live.png'), shot.toPNG())

  // ── 4. 清理远端测试目录 ────────────────────────────
  console.log('\n清理远端测试目录…')
  await removeTree(REMOTE_ROOT).catch((err) => console.error('清理失败:', err.message))
  const left = await listDir(REMOTE_ROOT)
  check(left.length === 0, `远端测试目录已清空（剩 ${left.length} 项）`)

  console.log(failed === 0 ? '\nRESULT: 全部通过' : `\nRESULT: ${failed} 项未通过`)
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('✗ 真实实例验证异常:', err)
    app.exit(1)
  })
})
