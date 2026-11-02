// 界面断言脚本：起真实应用，核对「同名同大小认领」这一轮改动的界面表现。
//
// 断言四件事：
//   1. 文件清单页多出「可信度」一列，且能区分「哈希确认」与「仅大小」
//   2. 远端对账页**不再**出现「时间差异」这一类差异
//   3. 对账规则页多出「按文件名 + 大小认领」开关
//   4. 文件清单页的批量操作里多出「深度校验」入口
//
// 为什么不用肉眼看截图：截图只能拍到可见区，而且读文字容易看走眼；
// 直接量 DOM 文本更可靠。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/ui-verify-adopt.cjs <输出目录>
const path = require('path')
const fs = require('fs')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

// 固定目录 + 每次跑前清空，避免临时目录越堆越多
const USER_DATA = path.join(os.tmpdir(), 'topensync-uiverify-adopt')
const SYNC_DIR = path.join(os.tmpdir(), 'topensync-uiverify-adopt-sync')
const outDir = process.argv[2] || path.join(os.tmpdir(), 'topensync-ui-adopt-' + Date.now())
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.rmSync(SYNC_DIR, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(SYNC_DIR, { recursive: true })

// 造两个本地文件
fs.writeFileSync(path.join(SYNC_DIR, 'hash-verified.txt'), 'hello')
fs.writeFileSync(path.join(SYNC_DIR, 'size-adopted.txt'), 'world')

// 配置：只填本地同步目录，OpenList 留空（不连任何真实实例）
fs.writeFileSync(
  path.join(USER_DATA, 'config.json'),
  JSON.stringify(
    {
      syncRoot: SYNC_DIR,
      openlist: { baseUrl: '', username: '', password: '' },
      remoteRoot: '/quark-backup',
      remoteScan: {
        enabled: false,
        intervalHours: 6,
        onStartup: false,
        refresh: true,
        maxConcurrency: 1,
        timeoutMinutes: 30,
        conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only',
        autoFixLimit: 20,
        adoptByNameAndSize: true,
        exclude: []
      }
    },
    null,
    2
  ),
  'utf8'
)

/*
 * 预置清单库。
 *
 * 直接塞两条记录：一条 verify_level='hash'（内容经哈希确认），
 * 一条 verify_level='size'（仅凭同名同大小弱认定）。
 * 这样界面上的两种标记都能被断言到，不必真的连远端跑一轮。
 */
const db = new DatabaseSync(path.join(USER_DATA, 'manifest.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    id              INTEGER PRIMARY KEY,
    local_path      TEXT NOT NULL UNIQUE,
    local_size      INTEGER NOT NULL,
    mtime_ms        INTEGER NOT NULL,
    md5             TEXT,
    sha1            TEXT,
    remote_path     TEXT,
    remote_size     INTEGER,
    remote_etag     TEXT,
    synced_size     INTEGER,
    synced_mtime_ms INTEGER,
    synced_md5      TEXT,
    synced_sha1     TEXT,
    local_inode     TEXT,
    verify_level    TEXT,
    state           TEXT NOT NULL DEFAULT 'pending',
    last_sync_at    INTEGER,
    last_verify_at  INTEGER,
    error_msg       TEXT,
    first_seen_at   INTEGER NOT NULL,
    deleted_at      INTEGER
  );
`)
const now = Date.now()
const ins = db.prepare(
  `INSERT INTO files
     (local_path, local_size, mtime_ms, remote_path, remote_size,
      synced_size, synced_mtime_ms, synced_md5, synced_sha1,
      verify_level, state, last_sync_at, first_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`
)
ins.run('hash-verified.txt', 5, now, '/quark-backup/hash-verified.txt', 5, 5, now, 'a'.repeat(32), 'b'.repeat(40), 'hash', now, now)
ins.run('size-adopted.txt', 5, now, '/quark-backup/size-adopted.txt', 5, 5, now, null, null, 'size', now, now)
db.close()

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

// 主模块加载失败要立刻退出，否则会一直挂着空转
try {
  require(MAIN)
} catch (err) {
  console.error('✗ 主模块加载失败:', err)
  app.exit(1)
}

/** 切到某页并等标题对上 */
async function goto(win, hash, expectTitle) {
  await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
  const deadline = Date.now() + 5000
  for (;;) {
    const title = await win.webContents.executeJavaScript(
      `(document.querySelector('.page-head h1') || {}).textContent || ''`
    )
    if (title.includes(expectTitle)) break
    if (Date.now() > deadline) return title
    await new Promise((r) => setTimeout(r, 80))
  }
  await new Promise((r) => setTimeout(r, 200))
  return expectTitle
}

const MANIFEST_PROBE = `(() => {
  const table = document.querySelector('.card.table-card table.tbl')
  if (!table) return { error: 'no table' }
  const heads = Array.from(table.querySelectorAll('thead th')).map((t) => t.textContent.trim())
  const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
    return { path: cells[1] || '', verify: cells[7] || '', diff: cells[8] || '' }
  })
  return { heads, rows, bodyText: table.textContent }
})()`

async function main() {
  await new Promise((r) => setTimeout(r, 3500))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('RESULT: 没有创建窗口')
    app.exit(1)
    return
  }
  win.setSize(1440, 820)

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  let failed = 0
  const check = (ok, msg) => {
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} ${msg}`)
  }

  // ── 1. 文件清单页：可信度列 ──────────────────────────
  await goto(win, 'manifest', '文件清单')
  const m = await win.webContents.executeJavaScript(MANIFEST_PROBE)
  console.log('\n===== 文件清单页 =====')
  console.log('表头:', JSON.stringify(m.heads))
  console.log('行:', JSON.stringify(m.rows))

  check(m.heads.includes('可信度'), '清单页表头含「可信度」列')
  const hashRow = (m.rows || []).find((r) => r.path.includes('hash-verified.txt'))
  const sizeRow = (m.rows || []).find((r) => r.path.includes('size-adopted.txt'))
  check(!!hashRow && hashRow.verify.includes('哈希确认'), '哈希确认的文件标记为「哈希确认」')
  check(!!sizeRow && sizeRow.verify.includes('仅大小'), '弱认领的文件标记为「仅大小」')

  // ── 2. 批量操作里有「深度校验」 ──────────────────────
  // 批量条在「未勾选任何项」时整体不渲染（BatchBar 里 count===0 直接返回 null），
  // 所以先勾一行再断言。
  await win.webContents.executeJavaScript(`(() => {
    const cb = document.querySelector('.card.table-card tbody input[type=checkbox]')
    if (cb) { cb.click() }
  })()`)
  await new Promise((r) => setTimeout(r, 250))
  const batchLabels = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.batch-actions .btn')).map((b) => b.textContent.trim())`
  )
  check(
    batchLabels.some((t) => t.includes('深度校验')),
    `勾选后批量条出现「深度校验」（实际：${JSON.stringify(batchLabels)}）`
  )

  const shot1 = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'manifest.png'), shot1.toPNG())

  // ── 3. 远端对账页：不再有「时间差异」 ─────────────────
  await goto(win, 'reconcile', '远端对账')
  const recon = await win.webContents.executeJavaScript(
    `(() => ({
      body: document.body.innerText,
      stats: Array.from(document.querySelectorAll('.dstat')).map((d) => d.textContent.trim())
    }))()`
  )
  console.log('\n===== 远端对账页 =====')
  console.log('差异卡片:', JSON.stringify(recon.stats))
  check(!recon.body.includes('时间差异'), '对账页不再出现「时间差异」')
  check(recon.stats.length === 3, `对账页差异卡片只剩 3 类（实际 ${recon.stats.length}）`)

  const shot2 = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'reconcile.png'), shot2.toPNG())

  // ── 4. 对账规则页：认领开关 ─────────────────────────
  await goto(win, 'reconrule', '对账规则')
  const rule = await win.webContents.executeJavaScript(
    `(() => ({
      body: document.body.innerText,
      switches: Array.from(document.querySelectorAll('.switch-row')).map((r) => r.textContent.trim())
    }))()`
  )
  console.log('\n===== 对账规则页 =====')
  check(
    rule.switches.some((t) => t.includes('文件名') && t.includes('大小')),
    '规则页有「按文件名 + 大小认领」开关'
  )

  const shot3 = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'reconrule.png'), shot3.toPNG())

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log(`\n截图目录: ${outDir}`)
  console.log(failed === 0 ? '\nRESULT: 全部通过' : `\nRESULT: ${failed} 项未通过`)
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('✗ 断言脚本异常:', err)
    app.exit(1)
  })
})
