// 一次性：把远端 demo 目录铺成「与本地一致 + 一个远端独有文件」的状态。
//
// 用法：
//   MSYS_NO_PATHCONV=1 M0_BASE=... M0_USER=... M0_PASS=... \
//   node scripts/seed-remote.cjs <远端根> <本地目录>
//
// 走的是和程序完全一样的接口：PUT /api/fs/put（不是 POST）。
// 上传是异步落盘（夸克侧约 1 秒可见），传完会轮询确认。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const REMOTE_ROOT = process.argv[2]
const LOCAL_ROOT = process.argv[3]

if (!BASE || !USER || !PASS || !REMOTE_ROOT || !LOCAL_ROOT) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS 或参数')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let token = ''

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })
  const json = await res.json()
  if (json.code !== 200) throw new Error(`登录失败: ${json.message}`)
  token = json.data.token
}

async function list(p, refresh = true) {
  const res = await fetch(`${BASE}/api/fs/list`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, page: 1, per_page: 99999, refresh })
  })
  const json = await res.json()
  if (json.code !== 200) return null
  return json.data.content || []
}

async function mkdirp(p) {
  const parts = p.split('/').filter(Boolean)
  let cur = ''
  for (const part of parts) {
    cur += `/${part}`
    const parent = cur.slice(0, cur.lastIndexOf('/')) || '/'
    const items = await list(parent, false)
    if (items && items.some((x) => x.name === part && x.is_dir)) continue
    const res = await fetch(`${BASE}/api/fs/mkdir`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cur })
    })
    const json = await res.json()
    if (json.code !== 200) console.log(`  (mkdir ${cur}: ${json.message})`)
    await sleep(400)
  }
}

/** 传一个文件，等它在远端可见 */
async function putFile(remotePath, content) {
  const buf = Buffer.from(content)
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
  const json = await res.json()
  if (json.code !== 200) throw new Error(`上传 ${remotePath} 失败: ${json.message}`)
  // 落盘是异步的：轮询确认可见
  const parent = remotePath.slice(0, remotePath.lastIndexOf('/'))
  const name = remotePath.slice(remotePath.lastIndexOf('/') + 1)
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const items = await list(parent, true)
    if (items && items.some((x) => x.name === name)) return
  }
  throw new Error(`上传 ${remotePath} 后一直不可见`)
}

/** 收集本地文件（相对路径 + 内容） */
function collect(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(abs, base))
    else out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs })
  }
  return out
}

async function main() {
  await login()
  console.log('远端根:', REMOTE_ROOT)
  console.log('本地根:', LOCAL_ROOT)

  const files = collect(LOCAL_ROOT)
  console.log(`本地 ${files.length} 个文件`)

  await mkdirp(REMOTE_ROOT)
  const dirs = new Set()
  for (const f of files) {
    const dir = path.posix.dirname(f.rel)
    if (dir && dir !== '.') dirs.add(dir)
  }
  for (const d of dirs) await mkdirp(`${REMOTE_ROOT}/${d}`)

  for (const f of files) {
    await putFile(`${REMOTE_ROOT}/${f.rel}`, fs.readFileSync(f.abs))
    console.log(`  ✓ 上传 ${f.rel}`)
  }

  // 加一个「远端独有」文件：本地没有它 → 对账页会出现 remote_only 差异
  const extra = `${REMOTE_ROOT}/远端独有的说明.txt`
  await putFile(extra, '这个文件只存在于远端，用来演示「远端对账」与删除操作。\n')
  console.log(`  ✓ 上传 远端独有的说明.txt（仅远端存在）`)

  console.log('\n远端现状:')
  const walk = async (p, indent = '') => {
    const items = await list(p, true)
    if (!items) {
      console.log(`${indent}${p} → 读取失败`)
      return
    }
    for (const item of items) {
      console.log(`${indent}[${item.is_dir ? 'D' : 'F'}] ${item.name} ${item.size ?? ''}`)
      if (item.is_dir) await walk(`${p}/${item.name}`, indent + '  ')
    }
  }
  await walk(REMOTE_ROOT)
  console.log('\n✓ 远端已就绪')
}

main().catch((err) => {
  console.error('✗', err.message || err)
  process.exit(1)
})
