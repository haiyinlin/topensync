import * as React from 'react'
import { Icon } from '../components/Icon'
import type { PageKey } from '../App'
import type { TransferTask } from '@shared/types'
import { useAppStore } from '../store'

/**
 * 概览页。
 *
 * 核心是「扫描通道」双行状态卡：本地扫描（常驻实时）与
 * 远端对账（周期性）必须视觉可区分，不能合并成一个进度条。
 */

/**
 * 「进行中」的口径：上传、哈希、下载都算。
 *
 * 以前只算 uploading，正在下载远端文件时概览会显示「已空闲 0 个文件」，
 * 进度条空转、侧栏徽章也不亮——用户只会以为程序死了。
 * 与队列页保持同一口径，三处数字才对得上。
 */
function isActiveState(state: TransferTask['state']): boolean {
  return state === 'uploading' || state === 'hashing' || state === 'downloading'
}

export function Overview({ onNavigate }: { onNavigate: (k: PageKey) => void }): React.JSX.Element {
  const stats = useAppStore((s) => s.stats)
  const tasks = useAppStore((s) => s.tasks)
  const diffs = useAppStore((s) => s.diffs)
  const remoteScan = useAppStore((s) => s.stats?.remoteScan ?? null)
  const localScan = useAppStore((s) => s.stats?.localScan ?? null)
  const speed = useAppStore((s) => s.stats?.speed ?? null)
  const progress = useAppStore((s) => s.progress)

  const failed = stats?.failed ?? 0
  const queued = stats?.queued ?? 0
  const active = tasks.filter((t) => isActiveState(t.state))
  const openDiffs = diffs.filter((d) => !d.resolvedAt)

  /*
   * 两条通道各自看自己的进度。
   *
   * 以前共用一个 progress 对象：对账一开始就把本地扫描的进度顶掉，
   * 本地扫描的指示灯跟着灭了——而它明明还在跑。
   */
  const localScanning = progress.local?.running === true
  const remoteScanning = progress.remote?.running === true

  // 总进度：进行中任务的平均完成度。有任务才显示，否则 0。
  const overallProgress =
    active.length > 0
      ? Math.round(
          (active.reduce((sum, t) => sum + (t.progress ?? 0), 0) / active.length) * 100
        )
      : 0

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>概览</h1>
          <p className="sub">本地扫描与远端对账两条通道的实时状态。</p>
        </div>
      </div>

      <div className="card hero">
        <div className="hero-main">
          <div className="hero-icon">
            <Icon name="upload" />
          </div>
          <div className="hero-text">
            <div className="hero-title">
              {active.length > 0 ? '正在同步' : '已空闲'}{' '}
              <span className="mono dim">{active.length}</span> 个文件
            </div>
            <div className="hero-sub">
              {active.length > 0
                ? `${active.length} 个文件进行中 · 队列剩余 ${queued} 个`
                : '当前无进行中的传输'}
            </div>
            <div className="bar big">
              <i style={{ width: `${overallProgress}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* 双通道状态：本地扫描常驻实时，远端对账周期性触发 */}
      <div className="card channel-card">
        <div className="card-head">
          <h2>扫描通道</h2>
          <span className="muted">本地变更实时响应，远端偏差周期核对</span>
        </div>
        <div className="channels">
          <div className="channel">
            <div className="ch-icon live">
              <Icon name="monitor" />
            </div>
            <div className="ch-main">
              <div className="ch-title">
                本地扫描
                {localScan?.watching ? (
                  <span className="ch-state live">
                    <i className="pulse" />
                    实时监控中
                  </span>
                ) : (
                  <span className="ch-state">未在监控</span>
                )}
              </div>
              <div className="ch-sub mono">
                {localScanning
                  ? progress.local?.detail ?? '正在扫描…'
                  : localScan?.watching
                    ? `监听本地同步目录 · 已扫描 ${localScan.scannedCount} 个文件`
                    : localScan?.error
                      ? localScan.error
                      : localScan?.root
                        ? `未在监控中（${localScan.root}）`
                        : '未在监控中（尚未设置同步目录）'}
              </div>
              {/* 扫描中才显示进度条；平时那条 100% 的条是假的 */}
              <div className={localScanning ? 'bar thin indeterminate' : 'bar thin idle'}>
                <i />
              </div>
            </div>
            <div className="ch-end">
              <div className="metric">
                <span className="mono">{queued}</span>
                <em>待处理变更</em>
              </div>
              <button
                className={`btn tiny ghost${localScanning ? ' busy' : ''}`}
                onClick={() => window.topensync?.triggerScan('local')}
                disabled={localScanning}
              >
                {localScanning ? '扫描中…' : '重新扫描'}
              </button>
            </div>
          </div>

          <div className="channel">
            <div className="ch-icon">
              <Icon name="cloud-check" />
            </div>
            <div className="ch-main">
              <div className="ch-title">
                远端对账
                {remoteScanning ? (
                  <span className="ch-state live">
                    <i className="pulse" />
                    对账进行中
                  </span>
                ) : remoteScan?.enabled ? (
                  <span className="ch-state">等待下一轮</span>
                ) : (
                  <span className="ch-state">已禁用</span>
                )}
              </div>
              <div className="ch-sub mono">
                {remoteScanning
                  ? progress.remote?.detail ?? '正在对账…'
                  : remoteScan?.lastScanAt
                    ? `上次扫描 ${remoteScan.scannedCount} 个文件 · 发现 ${remoteScan.diffCount} 处差异`
                    : remoteScan?.enabled
                      ? '尚未执行对账'
                      : '远端对账已关闭'}
              </div>
              {/* 扫描中才显示进度条；平时那条 100% 的条是假的 */}
              <div className={remoteScanning ? 'bar thin indeterminate' : 'bar thin idle'}>
                <i />
              </div>
            </div>
            <div className="ch-end">
              <div className="metric">
                <span className="mono warn-txt">{openDiffs.length}</span>
                <em>未处理差异</em>
              </div>
              <button className="btn tiny ghost" onClick={() => onNavigate('reconcile')}>
                查看差异
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid stat-grid">
        {/*
         * 传输速率。
         *
         * 三个数各有各的用处：
         * - 当前：此刻跑多快，看有没有卡住
         * - 峰值：本次运行最快到过多少，看线路上限
         * - 平均：整体效率，看这轮同步划不划算
         *
         * 平均速率用「累计字节 / 累计时长」算，不是各次速率求平均——
         * 后者会让 1KB 和 1GB 的文件等权，算出来的数没有参考价值。
         */}
        <div className="card stat">
          <div className="stat-head">
            <Icon name="gauge" className="ic teal" />
            当前速率
          </div>
          <div className="stat-val mono">{formatSpeed(speed?.current ?? 0)}</div>
          <div className="stat-foot">
            峰值 {formatSpeed(speed?.max ?? 0)} · 平均 {formatSpeed(speed?.avg ?? 0)}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-head">
            <Icon name="check" className="ic teal" />
            已同步
          </div>
          <div className="stat-val mono">{stats?.synced ?? 0}</div>
          <div className="stat-foot">远端已确认存在且大小一致</div>
        </div>
        <div className="card stat">
          <div className="stat-head">
            <Icon name="clock" className="ic blue" />
            待上传
          </div>
          <div className="stat-val mono">{queued}</div>
          <div className="stat-foot">已入队，等待上传</div>
        </div>
        <div className="card stat">
          <div className="stat-head">
            <Icon name="filters" className="ic dim" />
            本次跳过
          </div>
          <div className="stat-val mono">{stats?.skipped ?? 0}</div>
          <div className="stat-foot">
            本地未变 {stats?.skippedLocal ?? 0} · 远端已有 {stats?.skippedRemote ?? 0}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-head">
            <Icon name="down" className="ic blue" />
            本次下载
          </div>
          <div className="stat-val mono">{stats?.downloaded ?? 0}</div>
          <div className="stat-foot">远端 → 本地</div>
        </div>
        <div className="card stat">
          <div className="stat-head">
            <Icon name="diff" className="ic orange" />
            远端差异
          </div>
          <div className="stat-val mono warn-txt">{openDiffs.length}</div>
          <div className="stat-foot">
            对账发现 ·{' '}
            <span className="lnk" onClick={() => onNavigate('reconcile')}>
              查看
            </span>
          </div>
        </div>
        <div className="card stat">
          <div className="stat-head">
            <Icon name="alert" className="ic red" />
            失败
          </div>
          <div className="stat-val mono">{failed}</div>
          <div className="stat-foot">
            需人工处理 ·{' '}
            <span className="lnk" onClick={() => onNavigate('queue')}>
              查看
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * 把字节/秒格式化成人类看得懂的速率。
 *
 * 单位用 B/s、KB/s、MB/s、GB/s——不是 bit。
 * 用户看的是「每秒传了多少」，位速率会让人对不上文件大小。
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bytesPerSecond
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
