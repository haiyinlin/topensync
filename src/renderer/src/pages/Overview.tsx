import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import type { PageKey } from '../App'
import type { DiffEntry, ScanRecord, TransferTask } from '@shared/types'

/**
 * 概览页。
 *
 * 核心是「扫描通道」双行状态卡：本地扫描（常驻实时）与
 * 远端对账（周期性）必须视觉可区分，不能合并成一个进度条。
 */
export function Overview({ onNavigate }: { onNavigate: (k: PageKey) => void }): React.JSX.Element {
  const [tasks, setTasks] = useState<TransferTask[]>([])
  const [diffs, setDiffs] = useState<DiffEntry[]>([])
  const [remoteScan, setRemoteScan] = useState<ScanRecord | null>(null)

  useEffect(() => {
    const offTask = window.quarksync?.onTransferUpdate((t) =>
      setTasks((prev) => [...prev.filter((x) => x.id !== t.id), t])
    )
    const offDiff = window.quarksync?.onDiffUpdate((d) => setDiffs((prev) => [d, ...prev]))
    const offScan = window.quarksync?.onScanUpdate((s) => {
      if (s.kind === 'remote') setRemoteScan(s)
    })
    return () => {
      offTask?.()
      offDiff?.()
      offScan?.()
    }
  }, [])

  const failed = tasks.filter((t) => t.state === 'failed').length
  const queued = tasks.filter((t) => t.state === 'queued').length
  const active = tasks.filter((t) => t.state === 'uploading')
  const openDiffs = diffs.filter((d) => !d.resolvedAt)

  const remoteState = remoteScan?.status === 'running' ? 'running' : 'idle'

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
              {active.length > 0 ? '正在同步' : '已空闲'} <span className="mono dim">0</span> 个文件
            </div>
            <div className="hero-sub">
              {active.length > 0
                ? `${active.length} 个文件进行中 · 队列剩余 ${queued} 个`
                : '当前无进行中的传输'}
            </div>
            <div className="bar big">
              <i style={{ width: active.length > 0 ? '32%' : '0%' }} />
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
                <span className="ch-state live">
                  <i className="pulse" />
                  实时监控中
                </span>
              </div>
              <div className="ch-sub mono">监听本地同步目录 · 待处理变更 {queued}</div>
              <div className="bar thin idle">
                <i style={{ width: '100%' }} />
              </div>
            </div>
            <div className="ch-end">
              <div className="metric">
                <span className="mono">{queued}</span>
                <em>待处理变更</em>
              </div>
              <button className="btn tiny ghost">重新扫描</button>
            </div>
          </div>

          <div className="channel">
            <div className="ch-icon">
              <Icon name="cloud-check" />
            </div>
            <div className="ch-main">
              <div className="ch-title">
                远端对账
                <span className={remoteState === 'running' ? 'ch-state live' : 'ch-state idle'}>
                  {remoteState === 'running' ? (
                    <>
                      <i className="pulse" />
                      对账进行中
                    </>
                  ) : (
                    '尚未运行'
                  )}
                </span>
              </div>
              <div className="ch-sub mono">
                {remoteScan
                  ? `扫描 ${remoteScan.scannedCount} 个目录 · 发现 ${remoteScan.changedCount} 处差异`
                  : '尚未执行对账'}
              </div>
              <div className="bar thin idle">
                <i style={{ width: '100%' }} />
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
        <div className="card stat">
          <div className="stat-head">
            <Icon name="check" className="ic teal" />
            已同步
          </div>
          <div className="stat-val mono">0</div>
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
          <div className="stat-val mono">0</div>
          <div className="stat-foot">本地去重命中 · 零上行</div>
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
