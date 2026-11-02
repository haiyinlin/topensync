// 正式启动器：像用户双击应用那样启动 TopenSync，但额外做三件事：
//   1. 首次运行时用真实 OpenList 信息初始化配置（加密落盘，之后可持久使用）
//   2. 造一个演示用的本地同步目录，放几个真实文件，触发一次真实上传
//   3. 打印实时状态并保持窗口运行（不退出），用户可以直接操作界面
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/run-app.cjs
//
// 环境变量：
//   M0_BASE / M0_USER / M0_PASS / M0_ROOT / M0_SYNC_ROOT
//
// ⚠️ 与 live-verify 的区别：那个跑完就退、用独立 profile、只碰带标记的测试目录；
//    这个是「真人试运行」——用正式 profile、窗口常驻、配置会保存下来。
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
const REMOTE_ROOT = process.env.M0_ROOT || '/qh/topensync-demo'
const SYNC_ROOT = process.env.M0_SYNC_ROOT || path.join(os.homedir(), 'Documents', 'TopenSyncDemo')

if (!BASE || !USER || !PASS) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS')
  process.exit(1)
}

// ── 演示素材 ────────────────────────────────────────────
function writeFixtures() {
  fs.mkdirSync(SYNC_ROOT, { recursive: true })
  const files = {
    '欢迎.txt': '欢迎使用 TopenSync。\n这是一个真实的试运行目录。\n',
    '说明.md': '# 试运行说明\n\n- 程序已连上你的内网 OpenList\n- 下列文件正在上传到夸克网盘\n',
    '文档/需求记录.md': '# 需求记录\n\n1. 双向箭头图标\n2. 区块间距\n3. 真实连接状态\n',
    '文档/数据/sample.csv': 'name,size,state\nreadme,1024,synced\n'
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(SYNC_ROOT, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return Object.keys(files)
}

// ── 启动 ────────────────────────────────────────────────
const { app, BrowserWindow } = require('electron')
require(MAIN)

const startedAt = Date.now()
console.log('正在启动 TopenSync…')

app.whenReady().then(async () => {
  console.log('userData:', app.getPath('userData'))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('✗ 没有创建窗口')
    app.exit(1)
    return
  }

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  // 演示目录先建好，再下发配置
  const names = writeFixtures()
  console.log(`✓ 演示目录已就绪: ${SYNC_ROOT}（${names.length} 个文件）`)

  // 下发配置：密码经 safeStorage 加密后落盘到正式 profile
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
      remoteScan: {
        enabled: true, intervalHours: 6, onStartup: true, refresh: true,
        maxConcurrency: 1, timeoutMinutes: 30, conflictPolicy: 'local-wins',
        remoteOnlyPolicy: 'record-only', autoFixLimit: 20,
        exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
      }
    })
    return { baseUrl: cfg.openlist.baseUrl, username: cfg.openlist.username, remoteRoot: cfg.remoteRoot, syncRoot: cfg.syncRoot }
  })()`)
  console.log('✓ 配置已保存到正式 profile:', JSON.stringify(patched))

  // 触发一次本地扫描 → 走完整上传链路
  await new Promise((r) => setTimeout(r, 1500))
  await win.webContents.executeJavaScript(`window.topensync.triggerScan('local')`)
  console.log('→ 已触发本地扫描，等待上传…')

  // 轮询直到队列跑空
  let last = ''
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await win.webContents.executeJavaScript(`window.topensync.getStats()`)
    const line = `  队列: ${s.queued} 上传中: ${s.active} 已完成: ${s.synced} 失败: ${s.failed}`
    if (line !== last) {
      console.log(line)
      last = line
    }
    if (s.synced >= names.length && s.failed === 0 && s.active === 0 && s.queued === 0) break
  }

  const conn = await win.webContents.executeJavaScript(`window.topensync.checkConnection()`)
  console.log('\n===== 连接状态 =====')
  console.log(JSON.stringify(conn, null, 2))

  const files = await win.webContents.executeJavaScript(`window.topensync.listFiles({ limit: 50 })`)
  console.log('\n===== 清单 =====')
  for (const f of files) {
    console.log(`  [${f.state}] ${f.localPath} → ${f.remotePath}`)
  }

  // 截一张图，证明界面渲染正常
  const shotDir = process.env.M0_SHOT_DIR || path.join(os.tmpdir(), 'topensync-run')
  fs.mkdirSync(shotDir, { recursive: true })
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(shotDir, 'running.png'), img.toPNG())
  console.log(`\n✓ 截图: ${path.join(shotDir, 'running.png')}`)

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')
  console.log(`\n===== 应用保持运行中（已运行 ${Math.round((Date.now() - startedAt) / 1000)}s）=====`)
  console.log('关闭窗口即退出。Ctrl+C 也能退出。')

  // 不调用 app.exit()：窗口常驻，用户直接用界面
})

process.on('uncaughtException', (err) => {
  console.error('启动器异常:', err)
  app.exit(1)
})