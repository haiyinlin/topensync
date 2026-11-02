// 界面断言脚本：核对本轮三项改造在真实应用里的表现。
//
//   1. 文件清单：措辞自解释 + 「可信度」筛选能真的筛出不同的行
//   2. 扫描按钮：点击有即时反馈（禁用 + 文案变化）+ 进度条出现并收掉
//   3. 运行日志：每条带类别与文件路径，按类别筛选有效
//
// 为什么不用肉眼看截图：截图只能拍到可见区，而且读文字容易看走眼；
// 直接量 DOM 更可靠。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/ui-verify-ux.cjs <输出目录>
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

const USER_DATA = path.join(os.tmpdir(), 'topensync-uiverify-ux')
const SYNC_DIR = path.join(os.tmpdir(), 'topensync-uiverify-ux-sync')
const outDir = process.argv[2] || path.join(os.tmpdir(), 'topensync-ui-ux-' + Date.now())
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.rmSync(SYNC_DIR, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(SYNC_DIR, { recursive: true })

// 放一批小文件：本地扫描要跑一会儿，进度条才不是「一闪而过」
for (let i = 0; i < 120; i++) {
  fs.writeFileSync(path.join(SYNC_DIR, `file-${i}.txt`), `content-${i}`)
}

// 只填本地同步目录，OpenList 留空（不连任何真实实例）
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
 * 预置清单库：三类可信度各一条，外加一条「只在远端」的差异，
 * 以及四条带类别的日志。
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
  CREATE TABLE IF NOT EXISTS diffs (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL,
    local_path    TEXT,
    remote_path   TEXT NOT NULL,
    local_size    INTEGER,
    remote_size   INTEGER,
    local_mtime   INTEGER,
    remote_mtime  INTEGER,
    detected_at   INTEGER NOT NULL,
    resolved_at   INTEGER,
    resolution    TEXT
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    level       TEXT NOT NULL,
    message     TEXT NOT NULL,
    file_id     INTEGER,
    remote      TEXT,
    category    TEXT,
    local_path  TEXT
  );
`)
const now = Date.now()
const insFile = db.prepare(
  `INSERT INTO files
     (local_path, local_size, mtime_ms, remote_path, remote_size,
      synced_size, synced_mtime_ms, synced_md5, synced_sha1,
      verify_level, state, last_sync_at, first_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`
)
insFile.run('hash-verified.txt', 5, now, '/quark-backup/hash-verified.txt', 5, 5, now, 'a'.repeat(32), 'b'.repeat(40), 'hash', now, now)
insFile.run('size-adopted.txt', 5, now, '/quark-backup/size-adopted.txt', 5, 5, now, null, null, 'size', now, now)
insFile.run('never-verified.txt', 5, now, null, null, null, null, null, null, null, now, now)

// 一条「远端有、本地无」的差异：用来验证清单页那段独立列表的标题
db.prepare(
  `INSERT INTO diffs (kind, local_path, remote_path, local_size, remote_size, detected_at)
   VALUES ('remote_only', NULL, '/quark-backup/only-on-remote.txt', NULL, 128, ?)`
).run(now)

const insLog = db.prepare(
  'INSERT INTO sync_log (ts, level, message, file_id, remote, category, local_path) VALUES (?, ?, ?, NULL, ?, ?, ?)'
)
insLog.run(now - 4000, 'info', '已上传 hash-verified.txt → /quark-backup/hash-verified.txt', '/quark-backup/hash-verified.txt', 'upload', 'hash-verified.txt')
insLog.run(now - 3000, 'info', '跳过 size-adopted.txt：远端已有同名同大小文件（未校验内容）', null, 'skip', 'size-adopted.txt')
insLog.run(now - 2000, 'info', '已下载 only-on-remote.txt → only-on-remote.txt', '/quark-backup/only-on-remote.txt', 'download', 'only-on-remote.txt')
insLog.run(now - 1000, 'info', '连接已建立', null, 'system', null)
db.close()

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

try {
  require(MAIN)
} catch (err) {
  console.error('✗ 主模块加载失败:', err)
  app.exit(1)
}

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
  await new Promise((r) => setTimeout(r, 250))
  return expectTitle
}

/** 点某个 chip，按可见文字匹配；返回该 chip 上的文字与计数 */
async function clickChip(win, text) {
  return win.webContents.executeJavaScript(`(() => {
    const chip = Array.from(document.querySelectorAll('.chip'))
      .find((c) => c.textContent.includes(${JSON.stringify(text)}))
    if (!chip) return { ok: false }
    chip.click()
    return { ok: true, text: chip.textContent.trim() }
  })()`)
}

/**
 * 清单主表的当前行数与内容。
 *
 * 注意：不能用 `querySelector('.card.table-card table.tbl')`——
 * 清单页有**两张** table-card，「只在远端的文件」那张排在主表前面，
 * 取第一个拿到的是它（只有 1 行），断言就会对着错误的表下结论。
 * 这里按表头含「可信度」精确锁定主表。
 */
const ROWS_PROBE = `(() => {
  const tables = Array.from(document.querySelectorAll('.card.table-card table.tbl'))
  const table = tables.find((t) =>
    Array.from(t.querySelectorAll('thead th')).some((th) => th.textContent.includes('可信度'))
  )
  if (!table) return { error: 'no main table' }
  const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
    return { path: cells[1] || '', verify: (cells.find((c) => c.includes('哈希确认') || c.includes('仅大小')) || '') }
  })
  return { count: rows.length, rows }
})()`

async function main() {
  await new Promise((r) => setTimeout(r, 4000))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('RESULT: 没有创建窗口')
    app.exit(1)
    return
  }
  win.setSize(1440, 860)

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  let failed = 0
  const check = (ok, msg) => {
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} ${msg}`)
  }

  // ── 1. 文件清单：可信度筛选 ──────────────────────────
  await goto(win, 'manifest', '文件清单')
  const body = await win.webContents.executeJavaScript('document.body.innerText')
  check(body.includes('远端独有文件'), '清单页有「远端独有文件」独立区块（不再叫「仅远端存在」）')
  check(!body.includes('仅远端存在'), '清单页不再出现含糊的「仅远端存在」措辞')

  /*
   * 两张表的表头必须**名字不同**，否则用户分不清哪一列属于哪一张表。
   * （曾经两边都叫「远端路径」，同屏出现两个同名表头。）
   */
  const twoTables = await win.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.card.table-card'))
    const pick = (cls) => {
      const card = cards.find((c) => c.classList.contains(cls))
      if (!card) return null
      return {
        title: (card.querySelector('.card-head h2') || {}).textContent?.trim() || '',
        heads: Array.from(card.querySelectorAll('thead th')).map((t) => t.textContent.trim())
      }
    }
    return { remote: pick('card-remote'), local: pick('card-local') }
  })()`)
  console.log('\\n===== 两张表的表头 =====')
  console.log('远端独有表:', JSON.stringify(twoTables.remote))
  console.log('本地文件表:', JSON.stringify(twoTables.local))
  check(!!twoTables.remote && !!twoTables.local, '清单页两张表都有独立标题')
  check(
    !twoTables.remote?.heads.some((h) => h.includes('远端路径')),
    '远端独有表不再用「远端路径」这个表头'
  )
  check(
    twoTables.local?.heads.includes('本地文件') && twoTables.local?.heads.includes('远端位置'),
    '本地文件表用「本地文件」/「远端位置」区分两列'
  )
  check(
    !twoTables.local?.heads.some((h) => h === '远端路径'),
    '同屏不再出现两个「远端路径」表头'
  )

  // 路径要拆成「灰色根前缀 + 亮色相对路径」，否则绝对路径太长还跟别的表撞脸
  const pathSplit = await win.webContents.executeJavaScript(`(() => {
    const roots = Array.from(document.querySelectorAll('.path-root'))
    const rels = Array.from(document.querySelectorAll('.path-rel'))
    return {
      rootCount: roots.length,
      relCount: rels.length,
      sampleRoot: roots[0] ? roots[0].textContent.trim() : '',
      sampleRel: rels[0] ? rels[0].textContent.trim() : ''
    }
  })()`)
  console.log('路径拆分:', JSON.stringify(pathSplit))
  check(pathSplit.rootCount > 0, '远端路径拆出了根前缀')
  check(pathSplit.relCount > 0, '远端路径拆出了相对路径')
  check(
    pathSplit.sampleRel.startsWith('/'),
    `相对路径以 / 开头（实际 ${pathSplit.sampleRel}）`
  )

  const filterBar = await win.webContents.executeJavaScript(`(() => {
    const bars = Array.from(document.querySelectorAll('.sub-toolbar'))
    const bar = bars.find((b) => b.textContent.includes('可信度'))
    if (!bar) return null
    return {
      chips: Array.from(bar.querySelectorAll('.chip')).map((c) => c.textContent.trim()),
      hint: (bar.querySelector('.tb-hint') || {}).textContent || ''
    }
  })()`)
  console.log('\n===== 可信度筛选条 =====')
  console.log(JSON.stringify(filterBar))
  check(!!filterBar, '清单页有「可信度」筛选条')
  if (filterBar) {
    const chipText = filterBar.chips.join('|')
    check(chipText.includes('哈希确认'), '可信度筛选含「哈希确认」')
    check(chipText.includes('仅大小'), '可信度筛选含「仅大小」')
    check(filterBar.hint.includes('未校验'), '可信度筛选旁有「未校验内容」的说明')
  }

  const allRows = await win.webContents.executeJavaScript(ROWS_PROBE)
  console.log('全部行数:', allRows.count)

  await clickChip(win, '仅大小')
  await new Promise((r) => setTimeout(r, 250))
  const sizeRows = await win.webContents.executeJavaScript(ROWS_PROBE)
  console.log('「仅大小」筛选后行数:', sizeRows.count, JSON.stringify(sizeRows.rows?.slice(0, 3)))
  check(sizeRows.count === 1, `「仅大小」只筛出 1 条（实际 ${sizeRows.count}）`)
  check(
    (sizeRows.rows || []).some((r) => r.path.includes('size-adopted.txt')),
    '「仅大小」筛出的是 size-adopted.txt'
  )

  await clickChip(win, '哈希确认')
  await new Promise((r) => setTimeout(r, 250))
  const hashRows = await win.webContents.executeJavaScript(ROWS_PROBE)
  check(hashRows.count === 1, `「哈希确认」只筛出 1 条（实际 ${hashRows.count}）`)

  /*
   * 三个维度是**叠加**的：点「仅大小」后再点状态条的「全部」，
   * 结果仍是那 1 条弱认定文件——这不是 bug，是筛选的正常语义。
   * 所以复位要靠新加的「清除筛选」链接。
   */
  const resetLink = await win.webContents.executeJavaScript(`(() => {
    const el = Array.from(document.querySelectorAll('.tb-link'))
      .find((e) => e.textContent.includes('清除筛选'))
    return { found: !!el, text: el ? el.textContent.trim() : '' }
  })()`)
  check(resetLink.found, '筛选生效时出现「清除筛选」入口')

  await win.webContents.executeJavaScript(`(() => {
    const el = Array.from(document.querySelectorAll('.tb-link'))
      .find((e) => e.textContent.includes('清除筛选'))
    if (el) el.click()
  })()`)
  await new Promise((r) => setTimeout(r, 250))
  const backRows = await win.webContents.executeJavaScript(ROWS_PROBE)
  check(backRows.count >= 3, `「清除筛选」恢复全部行（实际 ${backRows.count}）`)

  const resetGone = await win.webContents.executeJavaScript(`(() => {
    const el = Array.from(document.querySelectorAll('.tb-link'))
      .find((e) => e.textContent.includes('清除筛选'))
    return !el
  })()`)
  check(resetGone, '复位后「清除筛选」入口自动消失')

  const shot1 = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'manifest.png'), shot1.toPNG())

  // ── 2. 扫描按钮反馈 + 进度条 ────────────────────────
  console.log('\n===== 扫描按钮 =====')
  const scanProbe = await win.webContents.executeJavaScript(`(async () => {
    const btn = Array.from(document.querySelectorAll('.topbar-right .btn'))
      .find((b) => b.textContent.includes('扫描本地'))
    if (!btn) return { error: 'no button' }

    const seen = { progressShown: false, busyLabel: false, disabledDuring: false, detail: '' }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (n.classList.contains('scan-progress') || n.querySelector('.scan-progress'))) {
            seen.progressShown = true
            seen.detail = (n.textContent || '').replace(/\\s+/g, ' ').trim()
          }
        }
      }
      if (btn.disabled) {
        seen.disabledDuring = true
        if (btn.textContent.includes('扫描中')) seen.busyLabel = true
      }
    })
    obs.observe(document.body, { childList: true, subtree: true, attributes: true })

    btn.click()
    // React 对点击这类离散事件是同步提交的，这里直接读就是「点击瞬间」的状态
    await new Promise((r) => setTimeout(r, 0))
    if (btn.disabled) {
      seen.disabledDuring = true
      if (btn.textContent.includes('扫描中')) seen.busyLabel = true
    }

    const deadline = Date.now() + 5000
    while (!seen.progressShown && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
      if (btn.disabled) {
        seen.disabledDuring = true
        if (btn.textContent.includes('扫描中')) seen.busyLabel = true
      }
    }
    obs.disconnect()
    return { ...seen, labelNow: btn.textContent.trim() }
  })()`)
  console.log('扫描按钮观察:', JSON.stringify(scanProbe))
  check(scanProbe.disabledDuring === true, '点「扫描本地」后按钮立刻进入禁用态')
  check(scanProbe.busyLabel === true, '点「扫描本地」后按钮文案变为「扫描中…」')
  check(scanProbe.progressShown === true, '扫描期间出现进度条')

  // 扫描结束后按钮要恢复，不能一直卡着
  await new Promise((r) => setTimeout(r, 3000))
  const afterScan = await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('.topbar-right .btn'))
      .find((b) => b.textContent.includes('扫描本地') || b.textContent.includes('扫描中'))
    return {
      disabled: btn ? btn.disabled : null,
      label: btn ? btn.textContent.trim() : '(按钮不见了)',
      progressLeft: !!document.querySelector('.scan-progress')
    }
  })()`)
  console.log('扫描结束后:', JSON.stringify(afterScan))
  check(afterScan.disabled === false, '扫描结束后按钮恢复可用（没卡在禁用态）')
  check(afterScan.label.includes('扫描本地'), '扫描结束后按钮文案恢复')
  check(afterScan.progressLeft === false, '扫描结束后进度条已收掉')

  const shot2 = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'after-scan.png'), shot2.toPNG())

  // ── 3. 运行日志：类别 + 文件路径 ─────────────────────
  await goto(win, 'logs', '运行日志')
  const logPage = await win.webContents.executeJavaScript(`(() => {
    const table = document.querySelector('.card.table-card table.tbl')
    const heads = table ? Array.from(table.querySelectorAll('thead th')).map((t) => t.textContent.trim()) : []
    const rows = table ? Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
      return { level: cells[1] || '', category: cells[2] || '', file: cells[3] || '', message: cells[4] || '' }
    }) : []
    const chips = Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent.trim())
    return { heads, rows, chips }
  })()`)
  console.log('\n===== 运行日志页 =====')
  console.log('表头:', JSON.stringify(logPage.heads))
  console.log('类别 chips:', JSON.stringify(logPage.chips))
  console.log('行:', JSON.stringify(logPage.rows.slice(0, 6)))

  check(logPage.heads.includes('类别'), '日志表头含「类别」列')
  check(logPage.heads.includes('文件'), '日志表头含「文件」列')
  const uploadRow = (logPage.rows || []).find((r) => r.category.includes('上传'))
  const skipRow = (logPage.rows || []).find((r) => r.category.includes('跳过'))
  check(!!uploadRow && uploadRow.file.includes('hash-verified.txt'), '上传类日志带上了文件路径')
  check(!!skipRow && skipRow.file.includes('size-adopted.txt'), '跳过类日志带上了文件路径')

  await clickChip(win, '上传')
  await new Promise((r) => setTimeout(r, 250))
  const uploadOnly = await win.webContents.executeJavaScript(`(() => {
    const table = document.querySelector('.card.table-card table.tbl')
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
      return { category: cells[2] || '', file: cells[3] || '' }
    })
    return { count: rows.length, rows }
  })()`)
  console.log('「上传」筛选后:', JSON.stringify(uploadOnly))
  check(uploadOnly.count === 1, `按「上传」筛选只剩 1 条（实际 ${uploadOnly.count}）`)
  check(
    (uploadOnly.rows || []).every((r) => r.category.includes('上传')),
    '按「上传」筛选后没有混入别的类别'
  )

  await clickChip(win, '全部类别')
  await new Promise((r) => setTimeout(r, 250))
  const shot3 = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'logs.png'), shot3.toPNG())

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
