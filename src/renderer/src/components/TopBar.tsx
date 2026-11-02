import * as React from 'react'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'
import { formatSize, formatSpeed } from '../format'
import type { ScanProgress } from '@shared/types'

/**
 * 顶栏。
 *
 * 两条扫描通道各有独立触发按钮 —— 用户必须能一眼分辨
 * 「扫描本地」和「对账远端」不是同一件事。
 *
 * 连接状态与远端路径取自真实配置与自检结果：
 * 写死的「已连接」比没有提示更糟——用户会以为备份正常，
 * 实际上服务端早就连不上了。
 *
 * 扫描按钮的忙碌态**由主进程的真实进度驱动**，不是本地计时器：
 * 计时器猜的时长（大文件对账可能几分钟）很快就对不上，
 * 按钮会在对账还在跑时就恢复常态，用户会以为没生效。
 */
export function TopBar(): React.JSX.Element {
  const config = useAppStore((s) => s.config)
  const connection = useAppStore((s) => s.connection)
  const remoteScan = useAppStore((s) => s.stats?.remoteScan ?? null)
  const paused = useAppStore((s) => s.stats?.paused ?? false)
  const started = useAppStore((s) => s.stats?.started ?? false)
  const progress = useAppStore((s) => s.progress)
  const speed = useAppStore((s) => s.stats?.speed ?? null)
  const lastError = useAppStore((s) => s.lastError)
  const clearError = useAppStore((s) => s.clearError)
  const togglePause = useAppStore((s) => s.togglePause)
  const startSync = useAppStore((s) => s.startSync)

  // 点击瞬间就要有反馈：主进程推回进度之前，先按「已发起」处理。
  const [requested, setRequested] = useState<{ kind: 'local' | 'remote'; at: number } | null>(null)

  /*
   * 失败态。
   *
   * 主进程在失败路径（如「尚未连接 OpenList」）推回来的是 running:false，
   * 光看 running 的话按钮会立刻恢复可点——用户以为程序坏了，
   * 还会连着点，触发并发对账。
   * 这里把主进程给的失败原因留在按钮上，过几秒再恢复常态。
   */
  const [failure, setFailure] = useState<{ kind: 'local' | 'remote'; message: string } | null>(null)

  /*
   * 两条通道的忙碌态各自独立。
   *
   * 以前共用一个 progress 对象：本地扫描和对账互相顶掉，
   * 正在扫描时点对账，本地扫描的指示就灭了；
   * 对账结束后进度条还挂着（成功路径不推终态），按钮永远显示「对账中…」。
   */
  const localBusy = requested?.kind === 'local' || progress.local?.running === true
  const remoteBusy = requested?.kind === 'remote' || progress.remote?.running === true

  const localFailure = failure?.kind === 'local' ? failure : null
  const remoteFailure = failure?.kind === 'remote' ? failure : null

  /*
   * 主进程回了终态（progress 存在且 running=false）→ 解除「已发起」标记。
   *
   * 这里必须盯**整个 progress 对象**而不是 `progress?.running`：
   * 「未设置同步目录」「尚未连接 OpenList」这类失败路径推回来的是
   * `running: false`，而 running 在等待前后都是 false——
   * 只依赖它，effect 根本不会重跑，按钮就永远钉在「扫描中…」。
   */
  React.useEffect(() => {
    if (!requested) return
    const p = requested.kind === 'local' ? progress.local : progress.remote
    if (p && !p.running) {
      setRequested(null)
    }
  }, [requested, progress])

  /*
   * 终态里带 error 的 progress 就是「这次没跑成」。
   *
   * 没有这一步的话失败与成功在界面上长得一模一样：
   * 按钮变回可点，用户完全看不出刚才的对账失败了。
   *
   * 两条通道各看各的：本地扫描失败不该把对账按钮也染红。
   */
  React.useEffect(() => {
    for (const p of [progress.local, progress.remote]) {
      if (!p || p.running) continue
      const message = readProgressError(p)
      if (!message) continue
      setFailure({ kind: p.kind, message })
      return
    }
  }, [progress])

  /*
   * 失败提示不能一直挂着：几秒后恢复常态，
   * 否则按钮永远停在「对账失败」，用户以为要重启程序。
   */
  React.useEffect(() => {
    if (!failure) return
    const timer = setTimeout(() => setFailure(null), 5000)
    return () => clearTimeout(timer)
  }, [failure])

  /*
   * 超时兜底。
   *
   * 主进程完全没回应（IPC 断了、引擎卡在启动）时，
   * 按钮不能因为等不到 progress 就永远停在禁用态——
   * 用户会以为程序死了，连「暂停同步」都点不了。
   */
  React.useEffect(() => {
    if (!requested) return
    const timer = setTimeout(() => setRequested(null), 15_000)
    return () => clearTimeout(timer)
  }, [requested])

  const triggerLocal = (): void => {
    if (localBusy) return
    // 重新发起前先抹掉上一轮的失败提示，否则按钮会同时显示「扫描中…」和「扫描失败」
    setFailure(null)
    setRequested({ kind: 'local', at: Date.now() })
    window.topensync?.triggerScan('local')
  }

  const triggerReconcile = (): void => {
    if (remoteBusy) return
    setFailure(null)
    setRequested({ kind: 'remote', at: Date.now() })
    window.topensync?.triggerScan('remote')
  }

  // 四态：还没探测完 / 可达 / 连不上 / 压根没填连接信息。
  // 少一态就会出现「刚进界面就显示未配置」——那其实是「还没探测完」。
  const connState: 'checking' | 'ok' | 'bad' | 'unset' =
    connection === null
      ? 'checking'
      : connection.reachable
        ? 'ok'
        : connection.configured
          ? 'bad'
          : 'unset'
  const connLabel =
    connState === 'checking'
      ? '检测中'
      : connState === 'ok'
        ? '已连接'
        : connState === 'bad'
          ? '连接失败'
          : '未配置'

  // 地址只显示主机部分，账号密码绝不出现在顶栏
  const host = (): string => {
    const url = config?.openlist.baseUrl
    if (!url) return 'OpenList'
    try {
      const u = new URL(url)
      return `OpenList ${u.host}`
    } catch {
      return `OpenList ${url}`
    }
  }

  const remoteRoot = config?.remoteRoot || '/'

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="conn-pill">
          <span
            className="dot"
            style={
              connState === 'ok'
                ? { background: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-bg)' }
                : {
                    background: connState === 'bad' ? 'var(--red)' : 'var(--tx3)',
                    boxShadow: 'none'
                  }
            }
          />
          <span title={connection?.error ?? undefined}>
            {connLabel} · {host()}
          </span>
        </div>
        <span className="sep" />
        <span className="muted" title="远端根目录">
          {remoteRoot}
        </span>
        {remoteScan?.running && <span className="pill amber">对账中</span>}
        {/*
         * 传输速率。
         *
         * 放在顶栏而不是只在概览页：用户看传输进度时多半在「传输队列」，
         * 而「线路现在跑多快、峰值多少、整体平均多少」是那个页面上
         * 最需要的信息。顶栏常驻，任何页面都看得到。
         *
         * 只在本次运行真的传过数据之后才显示——一直挂着几个 0 B/s
         * 只会让人以为是坏掉的控件。
         */}
        {speed && speed.totalBytes > 0 && (
          <span className="speed-pill" title={`本次运行已传输 ${formatSize(speed.totalBytes)}`}>
            <Icon name="gauge" className="ic" />
            <b className="mono">{formatSpeed(speed.current)}</b>
            <span className="dim mono">
              峰值 {formatSpeed(speed.max)} · 平均 {formatSpeed(speed.avg)}
            </span>
          </span>
        )}
        {/*
         * 全局失败提示。
         *
         * IPC 失败都记在 store 的 lastError 里——不放出来的话，
         * 「保存配置失败」「删除本地文件失败」这些就等于没发生过。
         */}
        {lastError && (
          <span
            className="pill red"
            title={`${lastError}（点击清除）`}
            onClick={clearError}
            style={{ cursor: 'pointer', maxWidth: 260 }}
          >
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {lastError}
            </span>
          </span>
        )}
      </div>

      <div className="topbar-right">
        <button
          className={`btn ghost${localBusy ? ' busy' : ''}`}
          title={localFailure ? `扫描失败：${localFailure.message}` : '重新扫描本地同步目录'}
          style={localFailure ? { color: 'var(--red)', borderColor: 'var(--red)' } : undefined}
          onClick={triggerLocal}
          disabled={localBusy}
        >
          <Icon name="monitor" />
          {localBusy ? '扫描中…' : localFailure ? '扫描失败' : '扫描本地'}
        </button>
        <button
          className={`btn ghost${remoteBusy ? ' busy' : ''}`}
          title={remoteFailure ? `对账失败：${remoteFailure.message}` : '立即对账远端（列出远端树并比对差异）'}
          style={remoteFailure ? { color: 'var(--red)', borderColor: 'var(--red)' } : undefined}
          onClick={triggerReconcile}
          disabled={remoteBusy}
        >
          <Icon name="diff" />
          {remoteBusy ? '对账中…' : remoteFailure ? '对账失败' : '对账远端'}
        </button>
        {/*
         * 开始 / 暂停。
         *
         * 启动后默认**不开始**：本地扫描、远端对账、上传队列
         * 都要用户点一下才启动。备份工具多半开机自启，
         * 用户可能只是路过看一眼状态，不该一开就抢带宽扫全盘。
         *
         * 三态分开：「开始同步 / 继续同步 / 暂停同步」——
         * 「还没开始过」和「中途暂停了」对用户是两回事。
         */}
        {started ? (
          <button
            className={`btn${paused ? ' primary' : ''}`}
            title={paused ? '恢复本地监控与远端对账' : '暂停同步（保留清单与配置）'}
            onClick={() => void togglePause()}
          >
            <Icon name={paused ? 'play' : 'pause'} />
            {paused ? '继续同步' : '暂停同步'}
          </button>
        ) : (
          <button
            className="btn primary"
            title="开始本地扫描、远端对账与上传"
            onClick={() => void startSync()}
          >
            <Icon name="play" />
            开始同步
          </button>
        )}
      </div>
    </header>
  )
}

/**
 * 主进程推回的 progress 里可能带一个 error 字段（这次为什么失败）。
 *
 * shared/types.ts 里的 ScanProgress 还没有这个字段，而那个文件正被别人改着——
 * 所以这里做宽松读取，不去动类型定义。
 */
function readProgressError(progress: ScanProgress | null): string | null {
  if (!progress) return null
  const message = (progress as { error?: string }).error
  return typeof message === 'string' && message ? message : null
}

/**
 * 扫描进度条。
 *
 * 为什么放在顶栏下方而不是各页面里：
 * 扫描是对**全局**的操作——用户可能在任何一页点了「扫描本地」，
 * 进度条必须在他当前所在的页面上也看得见。
 *
 * 总量未知时（遍历型操作事先数不出总数）显示不确定态动画条 + 已处理计数。
 *
 * **两条通道各画一条**，不合并：
 * 本地扫描和远端对账可以同时在跑，合并成一条的话
 * 一条通道的进度会把另一条顶掉，用户根本不知道自己在看什么。
 */
export function ScanProgressBar(): React.JSX.Element | null {
  const progress = useAppStore((s) => s.progress)
  const local = progress.local
  const remote = progress.remote
  if (!local?.running && !remote?.running) return null

  return (
    <>
      {local?.running === true && <ProgressRow progress={local} />}
      {remote?.running === true && <ProgressRow progress={remote} />}
    </>
  )
}

function ProgressRow({ progress }: { progress: ScanProgress }): React.JSX.Element {
  const label = progress.kind === 'local' ? '扫描本地' : '远端对账'
  const percent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null

  return (
    <div className="scan-progress" role="status" aria-live="polite">
      <div className="sp-row">
        <span className="sp-label">{label}</span>
        <span className="sp-detail mono">{progress.detail}</span>
        {percent !== null && <span className="sp-pct mono">{percent}%</span>}
      </div>
      <div className={percent === null ? 'bar thin indeterminate' : 'bar thin'}>
        <i style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
    </div>
  )
}
