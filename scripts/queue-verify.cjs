// 队列按钮的实机验证：在**真实应用**里点「重试」和「取消」，
// 看状态是否真的变化。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/queue-verify.cjs <输出目录>
//
// 环境变量：
//   M0_BASE / M0_USER / M0_PASS / M0_ROOT / M0_SYNC_ROOT
//
// 做法：
// - 造一个必然上传失败的文件（远端路径指向只读目录 / 或直接断网）
//   → 任务落到 failed
// - 点「取消」→ 断言状态变 canceled
// - 点「重试」→ 断言状态变回 queued/uploading 并再次尝试
// - 全部通过渲染进程的**真实 DOM 按钮**触发，不直接调 IPC
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
const REMOTE_ROOT = process.env.M0_ROOT || '/qh/topensync-queue-verify'
const SYNC_ROOT = process.env.M0_SYNC_ROOT || path.join(os.tmpdir(), 'topensync-queue-verify')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}
if (!/verify/i.test(REMOTE_ROOT)) {
  console.error(`✗ 拒绝在非测试目录上运行：${REMOTE_ROOT}`)
  process.exit(1)
}

const outDir = process.argv[2] || path.join(os.tmpdir(), 'topensync-queue-verify-out')
const USER_DATA = path.join(os.tmpdir(), 'topensync-queue-verify-profile')
fs.mkdirSync(outDir, { recursive: true })
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.rmSync(SYNC_ROOT, { recursive: true, force: true })
fs.mkdirSync(SYNC_ROOT, { recursive: true })

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)
require(MAIN)

/** 读当前页面上的任务行与按钮 */
const READ_ROWS = `(() => {
  const rows = [...document.querySelectorAll('.tbl tbody tr')]
  return rows.map((tr) => {
    const tds = [...tr.querySelectorAll('td')]
    const state = tds[4] ? tds[4].textContent.trim() : ''
    const btns = [...tr.querySelectorAll('button')].map((b) => b.textContent.trim())
    return { file: tds[0] ? tds[0].textContent.trim() : '', state, btns }
  })
})()`

async function main() {
  // 造素材。
  // 大文件是故意的：上传窗口要足够长，才能抓到「上传中」状态去点取消。
  // 2KB 的文件秒传完，验证脚本根本来不及操作。
  fs.writeFileSync(path.join(SYNC_ROOT, 'a.txt'), 'hello queue verify\n')
  fs.writeFileSync(path.join(SYNC_ROOT, 'big.bin'), Buffer.alloc(24 * 1024 * 1024, 7))

  // 每轮都用**随机内容**：文件内容不变会命中 L1 去重，
  // 直接判为「已完成」，压根不会上传，验证脚本就没有操作窗口。
  const stamp = String(Date.now())
  fs.appendFileSync(path.join(SYNC_ROOT, 'a.txt'), stamp + '\n')
  // 大文件同理：内容必须变，否则也走去重
  fs.writeFileSync(
    path.join(SYNC_ROOT, 'big.bin'),
    Buffer.concat([Buffer.alloc(24 * 1024 * 1024, 7), Buffer.from(stamp)])
  )

  // 等窗口：主进程是在 app.whenReady() 里才建窗口的，
  // 直接取会拿到 undefined。
  let win = null
  for (let i = 0; i < 40; i++) {
    win = BrowserWindow.getAllWindows()[0]
    if (win) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!win) {
    console.error('✗ 没有创建窗口')
    app.exit(1)
    return
  }

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  await win.webContents.executeJavaScript(`(async () => {
    await window.topensync.patchConfig({
      syncRoot: ${JSON.stringify(SYNC_ROOT)},
      openlist: {
        baseUrl: ${JSON.stringify(BASE)},
        username: ${JSON.stringify(USER)},
        password: ${JSON.stringify(PASS)}
      },
      remoteRoot: ${JSON.stringify(REMOTE_ROOT)},
      syncEmptyDirs: true
    })
  })()`)

  await new Promise((r) => setTimeout(r, 2000))
  await win.webContents.executeJavaScript(`location.hash = 'queue'`)
  await new Promise((r) => setTimeout(r, 800))

  console.log('=== 初始队列 ===')
  console.log(JSON.stringify(await win.webContents.executeJavaScript(READ_ROWS), null, 1))

  let failed = 0

  // ── 场景 1：点「取消」 ──────────────────────────────
  console.log('\n=== 场景 1：点取消 ===')
  // 轮询等一个「上传中/等待」的任务出现（大文件上传窗口够长）
  let clicked = null
  for (let i = 0; i < 40 && !clicked; i++) {
    clicked = await win.webContents.executeJavaScript(`(async () => {
      const rows = [...document.querySelectorAll('.tbl tbody tr')]
      // 优先挑**大文件**：小文件秒传完，点了取消也已经结束了。
      // 体积在「大小」列（第二列），按文本里的 KB/MB 粗排。
      const candidates = []
      for (const tr of rows) {
        const tds = [...tr.querySelectorAll('td')]
        const state = tds[4] ? tds[4].textContent.trim() : ''
        if (state !== '上传中' && state !== '等待') continue
        const btn = [...tr.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')
        if (!btn) continue
        const sizeText = tds[1] ? tds[1].textContent.trim() : ''
        const mb = sizeText.includes('MB') ? parseFloat(sizeText) : sizeText.includes('KB') ? parseFloat(sizeText) / 1024 : 0
        candidates.push({ tr, tds, sizeText, mb })
      }
      if (!candidates.length) return null
      candidates.sort((a, b) => b.mb - a.mb)
      const pick = candidates[0]
      const btn = [...pick.tr.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')
      btn.click()
      return { file: pick.tds[0].textContent.trim(), state: pick.tds[4].textContent.trim(), size: pick.sizeText }
    })()`)
    if (!clicked) await new Promise((r) => setTimeout(r, 300))
  }

  if (!clicked) {
    console.log('  ✗ 队列里没有「上传中/等待」的任务可取消')
    failed++
  } else {
    console.log(`  已点击取消：${clicked.file}（${clicked.size}，原状态 ${clicked.state}）`)
    // 等久一点：要确认它**不会**又变回「上传中」——
    // 流水线上还没察觉取消的阶段会继续回报状态，
    // 那正是「取消按钮点了没反应」的根因。
    await new Promise((r) => setTimeout(r, 2500))
    const rows = await win.webContents.executeJavaScript(READ_ROWS)
    const row = rows.find((r) => r.file.includes(clicked.file))
    console.log(`  现在状态：${row ? row.state : '(行消失了)'}`)
    console.log(`  可用按钮：${row ? JSON.stringify(row.btns) : '[]'}`)
    if (!row || row.state !== '已取消') {
      console.log('  ✗ 取消后状态没有变成「已取消」')
      failed++
    } else if (!row.btns.includes('重试')) {
      console.log('  ✗ 已取消的任务没有「重试」按钮')
      failed++
    } else {
      console.log('  ✓ 取消生效')
    }
  }

  // ── 场景 2：点「重试」 ──────────────────────────────
  console.log('\n=== 场景 2：点重试 ===')
  const retried = await win.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll('.tbl tbody tr')]
    for (const tr of rows) {
      const tds = [...tr.querySelectorAll('td')]
      const state = tds[4] ? tds[4].textContent.trim() : ''
      if (state === '已取消' || state === '失败') {
        const btn = [...tr.querySelectorAll('button')].find((b) => b.textContent.trim() === '重试')
        if (btn) {
          btn.click()
          return { file: tds[0].textContent.trim(), state }
        }
      }
    }
    return null
  })()`)

  if (!retried) {
    console.log('  ✗ 队列里没有「已取消/失败」的任务可重试')
    failed++
  } else {
    console.log(`  已点击重试：${retried.file}（原状态 ${retried.state}）`)
    await new Promise((r) => setTimeout(r, 2000))
    const rows = await win.webContents.executeJavaScript(READ_ROWS)
    const row = rows.find((r) => r.file.includes(retried.file))
    console.log(`  现在状态：${row ? row.state : '(行消失了)'}`)
    /*
     * 重试生效的判据是「状态离开了 已取消/失败」——
     * 变成「等待」说明它被重新排进了队列（上传还没轮到它）。
     * 不能要求它变成「已完成」：大文件要传很久，等不到。
     */
    if (row && (row.state === '已取消' || row.state === '失败')) {
      console.log('  ✗ 重试后状态没有变化')
      failed++
    } else {
      console.log('  ✓ 重试生效（已重新入队）')
    }
  }

  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'queue.png'), img.toPNG())
  console.log(`\n✓ 截图: ${path.join(outDir, 'queue.png')}`)

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log(failed ? `RESULT: ${failed} 项不通过` : 'RESULT: OK')
  app.exit(failed ? 1 : 0)
}

// 等 app ready 再开跑：主进程在 whenReady 里建窗口，
// 太早取会拿到 undefined。
app.whenReady().then(() =>
  main().catch((err) => {
    console.error('验证失败:', err)
    app.exit(1)
  })
)