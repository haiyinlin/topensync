// 界面断言脚本：起真实应用，直接量 DOM，核对三件事——
//   1. 侧栏 logo 真的加载出来了（不是空 <span>）
//   2. 右侧内容区能真正下拉（scrollHeight > clientHeight 且 scrollTop 能变）
//   3. 页面区块之间有纵向间隔（相邻兄弟节点的间距 > 0）
//
// 为什么不用肉眼看截图：截图只能拍到可见区，「能不能下拉」这件事拍不出来；
// 靠 sleep 等固定毫秒数再截图还会拍到上一页（live-verify 已经踩过这个坑）。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/ui-verify.cjs <输出目录>
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(MAIN)) {
  console.error('✗ 缺少构建产物，请先 npm run build')
  process.exit(1)
}

// 固定目录 + 每次跑前清空。
// 用带时间戳的目录会让临时目录越堆越多（实测一轮验证就多 7 个），
// 而验证结果又不需要跨轮次保留。
const USER_DATA = path.join(os.tmpdir(), 'topensync-uiverify')
const outDir = process.argv[2] || path.join(os.tmpdir(), 'topensync-ui-' + Date.now())
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })

// 连接状态三态验证要连真实实例
const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS

const { app, BrowserWindow } = require('electron')
app.setPath('userData', USER_DATA)

// 主模块加载失败要立刻退出。
// 否则 Electron 会打印一句 "App threw an error during load" 然后**一直挂着**，
// 看起来像「卡住」，实际是空转——这个坑踩过一次。
try {
  require(MAIN)
} catch (err) {
  console.error('✗ 主模块加载失败:', err)
  app.exit(1)
}

const PAGES = ['overview', 'connection', 'queue', 'manifest', 'reconcile', 'logs', 'advanced', 'help']

/** 每个页面标题栏里的 H1，用来确认「拍到的确实是这一页」 */
const PAGE_TITLES = {
  overview: '概览',
  connection: '连接与路径',
  queue: '传输队列',
  manifest: '文件清单',
  reconcile: '远端对账',
  logs: '运行日志',
  advanced: '高级',
  help: '帮助'
}

/** 在渲染进程里量滚动容器的状态 */
const MEASURE = `(() => {
  const el = document.querySelector('.scroll')
  if (!el) return { error: 'no .scroll element' }
  const sec = el.querySelector(':scope > section')
  const kids = sec ? Array.from(sec.children) : []
  const gaps = []
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1].getBoundingClientRect()
    const b = kids[i].getBoundingClientRect()
    gaps.push(Math.round(b.top - a.bottom))
  }
  const logo = document.querySelector('.brand-mark')
  return {
    overflowY: getComputedStyle(el).overflowY,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    canScroll: el.scrollHeight > el.clientHeight,
    childCount: kids.length,
    childClasses: kids.map((k) => k.className || k.tagName),
    gaps,
    minGap: gaps.length ? Math.min.apply(null, gaps) : null,
    logoTag: logo ? logo.tagName : null,
    logoComplete: logo && logo.tagName === 'IMG' ? logo.complete : null,
    logoNaturalWidth: logo && logo.tagName === 'IMG' ? logo.naturalWidth : null,
    logoBox: logo ? (() => { const r = logo.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })() : null,
    pageTitle: (document.querySelector('.page-head h1') || {}).textContent || '',
    hash: location.hash,
    allH1: Array.from(document.querySelectorAll('.page-head h1')).map((h) => h.textContent)
  }
})()`

/** 滚到底部，看最后一块是否进入视口 */
const SCROLL_BOTTOM = `(() => {
  const el = document.querySelector('.scroll')
  el.scrollTop = el.scrollHeight
  const sec = el.querySelector(':scope > section')
  const last = sec && sec.lastElementChild
  const er = el.getBoundingClientRect()
  const lr = last ? last.getBoundingClientRect() : null
  return {
    scrollTop: Math.round(el.scrollTop),
    maxScroll: Math.round(el.scrollHeight - el.clientHeight),
    // 末块底边进入视口即算可见。
    // 不要求它的顶边也在视口内——末块本身可能比视口还高（内容多的卡片），
    // 那种情况下顶边必然在视口外，但用户照样能滚到底看完。
    lastVisible: lr ? lr.bottom <= er.bottom + 1 : false,
    lastRect: lr ? { top: Math.round(lr.top), bottom: Math.round(lr.bottom) } : null,
    containerRect: { top: Math.round(er.top), bottom: Math.round(er.bottom) }
  }
})()`

async function main() {
  await new Promise((r) => setTimeout(r, 3000))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('RESULT: 没有创建窗口')
    app.exit(1)
    return
  }
  // 刻意用矮窗口：内容装不下，滚动才会真的发生
  win.setSize(1280, 700)

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message))
  })

  let failed = 0
  for (const page of PAGES) {
    /*
     * 切页后必须等标题真的对上。
     *
     * 固定 sleep 靠不住：hashchange → setState → 重渲染 → 绘制，
     * 任意一步慢一点就会读到上一页。实测偶发过第一次循环读到「传输队列」。
     * 轮询标题既不会误判，也不会掩盖真问题（超时会明确报出实际标题）。
     */
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(page)}`)
    const expected = PAGE_TITLES[page]
    let title = ''
    const deadline = Date.now() + 4000
    for (;;) {
      title = await win.webContents.executeJavaScript(
        `(document.querySelector('.page-head h1') || {}).textContent || ''`
      )
      if (title.includes(expected)) break
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 80))
    }
    await new Promise((r) => setTimeout(r, 150))

    const m = await win.webContents.executeJavaScript(MEASURE)
    const b = await win.webContents.executeJavaScript(SCROLL_BOTTOM)

    const problems = []
    if (!title.includes(expected)) problems.push(`切页未生效（期望「${expected}」，实际「${title}」）`)
    if (m.overflowY !== 'auto') problems.push(`overflow-y=${m.overflowY}（应为 auto）`)
    if (m.minGap !== null && m.minGap < 8) problems.push(`区块间距 ${m.minGap}px 过小`)
    if (m.logoTag !== 'IMG' || m.logoNaturalWidth === 0) problems.push('logo 未加载')
    if (m.canScroll && b.scrollTop === 0) problems.push('内容超高但滚不动')
    if (m.canScroll && b.scrollTop < b.maxScroll - 2) problems.push(`滚不到底 ${b.scrollTop}/${b.maxScroll}`)
    if (m.canScroll && !b.lastVisible) problems.push('滚到底部后末块仍不可见')

    if (problems.length) failed++
    console.log(
      `${problems.length ? '✗' : '✓'} ${page}「${m.pageTitle}」` +
        ` 溢出=${m.overflowY} scrollH=${m.scrollHeight} clientH=${m.clientHeight}` +
        ` 可滚=${m.canScroll} 滚到底=${b.scrollTop}/${b.maxScroll} 末块可见=${b.lastVisible}` +
        ` 区块间距=${JSON.stringify(m.gaps)}` +
        ` logo=${m.logoTag}/${m.logoNaturalWidth}px ${JSON.stringify(m.logoBox)}` +
        (problems.length ? `\n    → ${problems.join('；')}` : '')
    )

    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `${page}-bottom.png`), img.toPNG())
  }

  console.log('\n渲染进程错误:', errors.length ? errors.slice(0, 5) : '(无)')

  // ── 连接状态三态 ─────────────────────────────────────
  // 界面上的连接状态必须跟着主进程的真实探测结果走，
  // 不能停在首屏那一刻的旧值（那正是「进来默认显示未配置」的来源）。
  if (BASE && USER && PASS) {
    console.log('\n===== 连接状态三态 =====')
    const readPills = `(() => ({
      topbar: (() => {
        const el = document.querySelector('.conn-pill span:last-child')
        return el ? el.textContent.trim() : '(缺失)'
      })(),
      card: (() => {
        const el = document.querySelector('.card.form .card-head .pill')
        return el ? el.textContent.trim() : '(缺失)'
      })()
    }))()`

    const gotoConnection = async () => {
      await win.webContents.executeJavaScript(`(async () => {
        location.hash = 'connection'
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      })()`)
      await new Promise((r) => setTimeout(r, 300))
    }

    const setConn = async (baseUrl, username, password) => {
      await win.webContents.executeJavaScript(
        `window.topensync.patchConfig({ openlist: { baseUrl: ${JSON.stringify(baseUrl)}, username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} } })`
      )
    }

    /*
     * 等界面上的状态文字变成期望值，而不是死等固定秒数。
     * 死等既慢又不准——探测早就完了还在等，或者探测卡住时照样等满。
     */
    const waitPill = async (expect, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      let last = { topbar: '(无)', card: '(无)' }
      for (;;) {
        last = await win.webContents.executeJavaScript(readPills)
        if (last.card.includes(expect)) return last
        if (Date.now() > deadline) return last
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    await gotoConnection()

    // 场景 1：真实可达地址 → 应显示「已连接」
    await setConn(BASE, USER, PASS)
    const ok = await waitPill('已连接')
    console.log(`  可达地址      → 顶栏「${ok.topbar}」 / 卡片「${ok.card}」`)
    if (!ok.topbar.includes('已连接') || !ok.card.includes('已连接')) {
      failed++
      console.log('    → ✗ 可达时应显示「已连接」')
    } else {
      console.log('    → ✓ 显示「已连接」')
    }

    // 场景 2：地址不可达 → 应显示「连接失败」（不是「未配置」）
    await setConn('http://127.0.0.1:59999', USER, PASS)
    const bad = await waitPill('连接失败')
    console.log(`  不可达地址    → 顶栏「${bad.topbar}」 / 卡片「${bad.card}」`)
    if (!bad.topbar.includes('连接失败') || !bad.card.includes('连接失败')) {
      failed++
      console.log('    → ✗ 不可达时应显示「连接失败」')
    } else {
      console.log('    → ✓ 显示「连接失败」')
    }

    // 场景 3：清空账号 → 应显示「未配置」
    await setConn(BASE, '', PASS)
    const unset = await waitPill('未配置')
    console.log(`  未填账号      → 顶栏「${unset.topbar}」 / 卡片「${unset.card}」`)
    if (!unset.topbar.includes('未配置') || !unset.card.includes('未配置')) {
      failed++
      console.log('    → ✗ 未填账号时应显示「未配置」')
    } else {
      console.log('    → ✓ 显示「未配置」')
    }

    // 恢复真实配置
    await setConn(BASE, USER, PASS)
    await waitPill('已连接')
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, 'connection-real.png'), img.toPNG())
  }

  console.log(failed ? `RESULT: ${failed} 项有问题` : 'RESULT: OK')
  app.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('界面断言失败:', err)
  app.exit(1)
})
