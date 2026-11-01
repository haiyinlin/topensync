import * as React from 'react'
import { useEffect, useState } from 'react'

interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/** 运行日志：时间线，按 info / warn / error 过滤。 */
export function Logs(): React.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')

  useEffect(() => {
    const off = window.topensync?.onLogAppend((entry) =>
      setLogs((prev) => [entry, ...prev].slice(0, 500))
    )
    return () => off?.()
  }, [])

  const shown = logs.filter((l) => filter === 'all' || l.level === filter)

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>运行日志</h1>
          <p className="sub">同步过程、错误与诊断信息。</p>
        </div>
        <div className="head-actions">
          <button className="btn ghost">导出诊断包</button>
        </div>
      </div>

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
      </div>

      <div className="card table-card">
        <table className="tbl">
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td className="dim" style={{ textAlign: 'center', padding: '28px 12px' }}>
                  暂无日志
                </td>
              </tr>
            )}
            {shown.map((l, i) => (
              <tr key={`${l.ts}-${i}`}>
                <td className="mono dim nw" style={{ width: '90px' }}>
                  {new Date(l.ts).toLocaleTimeString('zh-CN')}
                </td>
                <td style={{ width: '70px' }}>
                  <span className={`pill ${LEVEL_TONES[l.level]}`}>{l.level.toUpperCase()}</span>
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
