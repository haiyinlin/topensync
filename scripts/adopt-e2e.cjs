// 端到端验证：起真实应用 + 本地 Mock OpenList，验证「重复上传」是否真的被挡住。
//
// 场景（就是用户报的那个问题）：
//   本地有一批文件，远端**已经有**同名同大小的文件，
//   但本程序**从未同步过**它们（清过 userData / 换了台设备）。
//   以前：L1 快筛与 L2 哈希判重都不命中 → 整批完整上行一遍，
//         远端被覆盖，还留下 .openlist_to_delete 中间态。
//   现在：L1.5 认领闸门命中 → 零上行，并打上「仅大小」标记。
//
// 断言：
//   1. Mock 服务端**一次 PUT 都没收到**（这就是「不重复传」的硬证据）
//   2. 清单里两条记录都是 synced + verify_level='size'
//   3. 没有多余的远端目录/删除动作
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/adopt-e2e.cjs
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

const USER_DATA = path.join(os.tmpdir(), 'topensync-adopt-e2e')
const SYNC_DIR = path.join(os.tmpdir(), 'topensync-adopt-e2e-sync')
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.rmSync(SYNC_DIR, { recursive: true, force: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(SYNC_DIR, { recursive: true })

// 本地文件：内容与大小决定远端那份能不能被认领
const FILES = [
  { name: 'photo-01.jpg', body: 'JPEG-DATA-0001' },
  { name: 'photo-02.jpg', body: 'JPEG-DATA-0002' },
  { name: 'notes.txt', body: 'hello world' }
]
for (const f of FILES) fs.writeFileSync(path.join(SYNC_DIR, f.name), f.body)

/**
 * 用例（环境变量 ADOPT_CASE）：
 *   match     远端同名同大小 → 应当认领、零上传（默认）
 *   size-diff 远端同名但大小不同 → 应当照常上传
 *   off       关掉认领开关 → 应当照常上传
 */
const CASE = process.env.ADOPT_CASE || 'match'

/** Mock 端的远端树：根下已有这三个同名同大小的文件 */
const REMOTE_TREE = {
  '/backup': FILES.map((f) => ({
    name: f.name,
    // size-diff 用例：远端那份大小不同 → 不该被认领
    size: CASE === 'size-diff' ? Buffer.byteLength(f.body) + 1 : Buffer.byteLength(f.body),
    isDir: false
  }))
}

const calls = { put: [], list: [], mkdir: [], remove: [], move: [], get: [] }

/** 已经「上传」到 Mock 端的文件：路径 → 大小。上传后的校验要靠它 */
const uploaded = new Map()

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const json = (obj, code = 200) => {
      const text = JSON.stringify(obj)
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(text)
    }

    if (req.url === '/api/auth/login') {
      json({ code: 200, data: { token: 'mock-token' } })
      return
    }

    let payload = {}
    try {
      payload = body ? JSON.parse(body) : {}
    } catch {
      payload = {}
    }

    if (req.url === '/api/fs/list') {
      calls.list.push(payload.path)
      const entries = REMOTE_TREE[payload.path] || []
      json({
        code: 200,
        data: {
          content: entries.map((e) => ({
            name: e.name,
            size: e.size,
            is_dir: e.isDir === true,
            modified: '2026-01-01T00:00:00Z',
            sign: 'mock-sign'
          })),
          total: entries.length,
          provider: 'mock'
        }
      })
      return
    }

    if (req.url === '/api/fs/get') {
      calls.get.push(payload.path)
      /*
       * 上传后的元信息查询。
       *
       * 真实 OpenList 在 PUT 之后能查到文件；Mock 也必须如此——
       * 否则上传后的「远端一致性校验」必然失败，文件会被判失败并重试，
       * 测出来的就不是「认领闸门」而是「校验闸门」。
       */
      const uploadedSize = uploaded.get(payload.path)
      if (uploadedSize !== undefined) {
        json({
          code: 200,
          data: {
            name: payload.path.split('/').pop(),
            size: uploadedSize,
            is_dir: false,
            modified: '2026-01-01T00:00:00Z',
            sign: 'mock-sign'
          }
        })
        return
      }
      json({ code: 500, message: 'failed get object: object not found' })
      return
    }

    if (req.url === '/api/fs/put') {
      const p = decodeURI(req.headers['file-path'] || '')
      calls.put.push(p)
      uploaded.set(p, Number(req.headers['content-length'] || 0))
      json({ code: 200, data: null })
      return
    }

    if (req.url === '/api/fs/mkdir') {
      calls.mkdir.push(payload.path)
      json({ code: 200, data: null })
      return
    }

    if (req.url === '/api/fs/remove') {
      calls.remove.push(payload)
      json({ code: 200, data: null })
      return
    }

    if (req.url === '/api/fs/move') {
      calls.move.push(payload)
      json({ code: 200, data: null })
      return
    }

    json({ code: 200, data: null })
  })
})

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

/** 读清单库（另开一个只读连接，WAL 允许并发读） */
function readManifest() {
  const db = new DatabaseSync(path.join(USER_DATA, 'manifest.db'), { readOnly: true })
  const rows = db
    .prepare('SELECT local_path, state, synced_size, synced_md5, synced_sha1, verify_level FROM files')
    .all()
  db.close()
  return rows
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log('Mock OpenList 监听:', baseUrl)

  fs.writeFileSync(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify(
      {
        syncRoot: SYNC_DIR,
        openlist: { baseUrl, username: 'mock', password: 'mock' },
        remoteRoot: '/backup',
        hashConcurrency: 2,
        uploadConcurrency: 2,
        remoteScan: {
          enabled: true,
          intervalHours: 6,
          onStartup: true,
          refresh: true,
          maxConcurrency: 1,
          timeoutMinutes: 5,
          conflictPolicy: 'local-wins',
          remoteOnlyPolicy: 'record-only',
          autoFixLimit: 20,
          adoptByNameAndSize: CASE !== 'off',
          exclude: []
        }
      },
      null,
      2
    ),
    'utf8'
  )

  /*
   * 必须**先写配置再加载主模块**。
   *
   * Engine 在 app.whenReady() 里构造，构造那一刻就会 loadConfig()。
   * 配置晚一步写入 → 引擎拿到的是默认配置（syncRoot 为空）→
   * 没有 watcher、没有连接，Mock 端一个请求都收不到。
   */
  try {
    require(MAIN)
  } catch (err) {
    console.error('✗ 主模块加载失败:', err)
    server.close()
    app.exit(1)
    return
  }

  // 等引擎起来（连接自检 + watcher 初次扫描 + 流水线跑完）
  await new Promise((r) => setTimeout(r, 9000))

  const rows = readManifest()
  console.log('\n===== 清单 =====')
  for (const r of rows) console.log(' ', JSON.stringify(r))

  let failed = 0
  const check = (ok, msg) => {
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} ${msg}`)
  }

  console.log('\n===== Mock 收到的请求 =====')
  console.log(' PUT:', JSON.stringify(calls.put))
  console.log(' list:', JSON.stringify(calls.list))
  console.log(' mkdir:', JSON.stringify(calls.mkdir))
  console.log(' remove:', JSON.stringify(calls.remove))
  console.log(' move:', JSON.stringify(calls.move))

  check(calls.remove.length === 0, '没有误删远端文件')
  check(calls.move.length === 0, '没有误移动远端文件')

  if (CASE === 'match') {
    check(calls.put.length === 0, `一次上传都没有（PUT 次数 = ${calls.put.length}）——这就是「不重复传」`)
    check(rows.length === 3, `清单里有 3 条记录（实际 ${rows.length}）`)
    const allSynced = rows.length === 3 && rows.every((r) => r.state === 'synced')
    check(allSynced, '三条记录都是「已同步」')
    const allSize = rows.every((r) => r.verify_level === 'size')
    check(allSize, '三条记录都标记为「仅大小」弱认定')
    const noHash = rows.every((r) => r.synced_md5 === null && r.synced_sha1 === null)
    check(noHash, '认领没有写哈希基准（没校验内容不能谎称哈希确认）')
  } else {
    // 反向用例：不该认领的时候必须照常上传
    check(
      calls.put.length === 3,
      `不满足认领条件时照常上传（PUT 次数 = ${calls.put.length}，期望 3）`
    )
    const notAdopted = rows.every((r) => r.verify_level !== 'size')
    check(notAdopted, '没有记录被标成「仅大小」')
  }

  console.log('\n渲染进程窗口数:', BrowserWindow.getAllWindows().length)
  server.close()
  console.log(failed === 0 ? '\nRESULT: 全部通过' : `\nRESULT: ${failed} 项未通过`)
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('✗ 端到端脚本异常:', err)
    try {
      server.close()
    } catch {
      /* ignore */
    }
    app.exit(1)
  })
})
