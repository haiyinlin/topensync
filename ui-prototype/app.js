// 页面路由
const nav = document.getElementById('nav');
const railFoot = document.querySelector('.rail-foot');
const pages = [...document.querySelectorAll('.page')];
const scroll = document.getElementById('scroll');

function show(name){
  if (!pages.some(p => p.dataset.page === name)) name = 'overview';
  pages.forEach(p => p.classList.toggle('active', p.dataset.page === name));
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.page === name));
  scroll.scrollTop = 0;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}

document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', e => {
    if (el.tagName === 'A' || el.classList.contains('nav-item')) e.preventDefault();
    show(el.dataset.page);
  });
});

// 顶部导航项（含页内链接）也能跳转
document.querySelectorAll('.lnk[data-page]').forEach(el => {
  el.addEventListener('click', () => show(el.dataset.page));
});

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1) || 'overview');

// ── 顶栏：暂停 / 继续 ───────────────────────────────────
const btnToggle = document.getElementById('btnToggle');
let running = true;
btnToggle.addEventListener('click', () => {
  running = !running;
  btnToggle.innerHTML = running
    ? '<svg class="ic"><use href="#i-pause"/></svg>暂停同步'
    : '<svg class="ic"><use href="#i-play"/></svg>继续同步';
  btnToggle.classList.toggle('primary', running);
  const dot = document.querySelector('#connPill .dot');
  dot.style.background = running ? 'var(--accent)' : 'var(--tx3)';
  dot.style.boxShadow = running ? '0 0 0 3px var(--accent-bg)' : 'none';
  document.getElementById('connText').textContent = running
    ? '已连接 · OpenList 192.168.1.20:5244'
    : '已暂停 · OpenList 192.168.1.20:5244';
});

// ── 远端对账：演示进行中状态 ────────────────────────────
// 两条通道各自独立：本地扫描常驻，远端对账是周期任务，
// 进行中必须在界面上有明确指示，不能让人以为卡死。
const reconcileBtns = [
  document.getElementById('btnReconcile'),
  document.getElementById('btnReconcile2'),
].filter(Boolean);

function setReconcileState(state) {
  reconcileBtns.forEach(b => {
    if (state === 'running') {
      b.innerHTML = '<svg class="ic"><use href="#i-pause"/></svg>对账中…';
      b.classList.add('busy');
      b.disabled = true;
    } else {
      b.innerHTML = '<svg class="ic"><use href="#i-diff"/></svg>'
        + (b.id === 'btnReconcile2' ? '立即对账' : '对账远端');
      b.classList.remove('busy');
      b.disabled = false;
    }
  });

  // 概览页的远端通道行切换为进行态
  const chState = document.querySelectorAll('.channel')[1]?.querySelector('.ch-state');
  const chSub = document.querySelectorAll('.channel')[1]?.querySelector('.ch-sub');
  const chBar = document.querySelectorAll('.channel')[1]?.querySelector('.bar');
  if (!chState) return;
  if (state === 'running') {
    chState.className = 'ch-state live';
    chState.innerHTML = '<i class="pulse"></i>对账进行中';
    if (chSub) chSub.textContent = '已扫描 128 / 312 个目录 · 远端文件 5,204 …';
    if (chBar) { chBar.classList.remove('idle'); chBar.querySelector('i').style.width = '41%'; }
  } else {
    chState.className = 'ch-state idle';
    chState.textContent = '刚刚完成';
    if (chSub) chSub.textContent = '扫描 312 个目录 · 12,847 个文件 · 发现 3 处差异';
    if (chBar) chBar.classList.add('idle');
  }
}

reconcileBtns.forEach(b => {
  b.addEventListener('click', () => {
    setReconcileState('running');
    setTimeout(() => setReconcileState('done'), 2600);
  });
});

// ── 筛选 chips ──────────────────────────────────────────
document.querySelectorAll('.chips').forEach(group => {
  group.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
  });
});

// ── 滑块数值回显 ────────────────────────────────────────
document.querySelectorAll('.range').forEach(r => {
  const out = r.parentElement.querySelector('.val');
  const sync = () => { if (out) out.textContent = r.value; };
  r.addEventListener('input', sync);
  sync();
});

// ── 密码显隐 ────────────────────────────────────────────
document.querySelectorAll('.eye').forEach(b => {
  b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = `<svg class="ic"><use href="#i-${show ? 'eye-off' : 'eye'}"/></svg>`;
  });
});

// ── 分段控件 ────────────────────────────────────────────
document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });
});

// ── 队列徽标随筛选变化 ──────────────────────────────────
const badge = document.getElementById('queueBadge');
document.getElementById('queueChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const n = chip.querySelector('i').textContent;
  badge.textContent = chip.dataset.f === 'all' ? n : n;
});

// ── 键盘快捷键（原型演示）──────────────────────────────
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); document.getElementById('btnScan').click(); }
  if (k === 'd') {
    e.preventDefault();
    const b = document.getElementById('btnReconcile');
    if (b) b.click();
  }
  if (k === 's') { e.preventDefault(); btnToggle.click(); }
  if (k === 'k') {
    e.preventDefault();
    const input = document.querySelector('.rail-search input');
    if (input) { input.focus(); input.select(); }
  }
});
