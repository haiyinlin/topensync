import * as React from 'react'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'
import type { LogCategory } from '@shared/types'

/**
 * 运行日志：时间线，按级别与类别过滤。
 *
 * 删除语义：**只清日志记录**，不碰任何同步状态。
 * 日志是给人看的流水，不是数据源——清掉它不会让程序忘记同步进度。
 *
 * 类别维度是这轮改造的重点：以前日志只有「时间 + 级别 + 一句话」，
 * 用户问「这个文件到底传了没」时无法一眼定位。
 * 现在每条日志都带**类别**（上传/下载/跳过/对账/系统）与**文件路径**，
 * 按类别筛一下就能看清同步实际做了什么。
 */
export function Logs(): React.JSX.Element {
  const logs = useAppStore((s) => s.logs)
  const exportDiagnostics = useAppStore((s) => s.exportDiagnostics)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [category, setCategory] = useState<'all' | LogCategory>('all')
  const [confirming, setConfirming] = useState(false)
  const [exportState, setExportState] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'fail'; path?: string }>(
    { kind: 'idle' }
  )

  // 各类别的条数：让用户点之前就知道那边有多少内容
  const counts = React.useMemo(() => {
    const c: Record<string, number> = {}
    for (const l of logs) c[l.category] = (c[l.category] ?? 0) + 1
    return c
  }, [logs])

  const shown = logs.filter(
    (l) =>
      (filter === 'all' || l.level === filter) && (category === 'all' || l.category === category)
  )

  const doExport = async (): Promise<void> => {
    if (exportState.kind === 'busy') return
    setExportState({ kind: 'busy' })
    const path = await exportDiagnostics()
    if (path) {
      setExportState({ kind: 'ok', path })
      // 成功后自动收起提示，避免长期占着位置
      setTimeout(() => setExportState({ kind: 'idle' }), 6000)
    } else {
      setExportState({ kind: 'fail' })
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>运行日志</h1>
          <p className="sub">
            同步过程、错误与诊断信息。每条记录都带类别与文件路径，可按类别筛选。
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => void doExport()} disabled={exportState.kind === 'busy'}>
            {exportState.kind === 'busy' ? '正在打包…' : '导出诊断包'}
          </button>
          <button
            className="btn ghost"
            disabled={logs.length === 0}
            onClick={() => setConfirming(true)}
          >
            <Icon name="trash" />
            清空日志
          </button>
        </div>
      </div>

      {confirming && (
        <div className="modal-mask" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>清空运行日志</h3>
            <p className="dim">
              将删除 {logs.length} 条日志记录。日志只是运行流水，
              清空它不会影响同步状态与已上传的文件。
            </p>
            <div className="act-row end">
              <button className="btn ghost" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  void clearLogs()
                  setConfirming(false)
                }}
              >
                确认清空
              </button>
            </div>
          </div>
        </div>
      )}

      {exportState.kind === 'ok' && exportState.path && (
        <div className="card table-card">
          <p className="note">
            <b className="ok">诊断包已导出</b>
            <br />
            <span className="mono break">{exportState.path}</span>
          </p>
        </div>
      )}
      {exportState.kind === 'fail' && (
        <div className="card table-card">
          <p className="note">
            <b className="warn">导出失败</b>
            <br />
            请检查用户数据目录是否可写。
          </p>
        </div>
      )}

      <div className="card toolbar">
        <div className="chips">
          {(['all', 'info', 'warn', 'error'] as const).map((k) => (
            <button
              key={k}
              className={`chip${filter === k ? ' active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {LEVEL_LABELS[k]}
            </button>
          ))}
        </div>
        <span className="sep" />
        <div className="chips">
          <button
            className={`chip${category === 'all' ? ' active' : ''}`}
            onClick={() => setCategory('all')}
          >
            全部类别 <i>{logs.length}</i>
          </button>
          {(Object.keys(CATEGORY_LABELS) as LogCategory[]).map((k) => (
            <button
              key={k}
              className={`chip${category === k ? ' active' : ''}`}
              onClick={() => setCategory(k)}
            >
              {CATEGORY_LABELS[k].label} <i>{counts[k] ?? 0}</i>
            </button>
          ))}
        </div>
      </div>

      <div className="card table-card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '88px' }}>时间</th>
              <th style={{ width: '66px' }}>级别</th>
              <th style={{ width: '86px' }}>类别</th>
              <th style={{ width: '26%' }}>文件</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="dim" style={{ textAlign: 'center', padding: '28px 12px' }}>
                  {logs.length === 0 ? '暂无日志' : '当前筛选条件下没有日志'}
                </td>
              </tr>
            )}
            {shown.map((l, i) => (
              <tr key={`${l.ts}-${i}`}>
                <td className="mono dim nw" style={{ width: '88px' }}>
                  {new Date(l.ts).toLocaleTimeString('zh-CN')}
                </td>
                <td style={{ width: '66px' }}>
                  <span className={`pill ${LEVEL_TONES[l.level]}`}>{l.level.toUpperCase()}</span>
                </td>
                <td style={{ width: '86px' }}>
                  <span className={`pill ${CATEGORY_LABELS[l.category].tone}`}>
                    {CATEGORY_LABELS[l.category].label}
                  </span>
                </td>
                <td style={{ width: '26%' }}>
                  {l.filePath ? (
                    <div className="cell-file">
                      <Icon name="files" className="ic file" />
                      <span title={l.filePath}>{l.filePath}</span>
                    </div>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const LEVEL_LABELS = { all: '全部', info: '信息', warn: '警告', error: '错误' } as const
const LEVEL_TONES = { info: 'green', warn: 'amber', error: 'red' } as const

/**
 * 日志类别。
 *
 * 配色沿用界面里已有的语义色：
 * 上传=绿（成功）、下载=蓝、跳过=灰（没发生什么）、对账=琥珀、系统=紫。
 */
const CATEGORY_LABELS: Record<LogCategory, { label: string; tone: string }> = {
  upload: { label: '上传', tone: 'green' },
  download: { label: '下载', tone: 'blue' },
  skip: { label: '跳过', tone: 'gray' },
  reconcile: { label: '对账', tone: 'amber' },
  system: { label: '系统', tone: 'purple' }
}
