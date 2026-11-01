import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import type { TransferTask } from '@shared/types'

/** 传输队列：进行中 / 等待 / 失败任务，分片进度与逐项重试。 */
export function Queue(): React.JSX.Element {
  const [tasks, setTasks] = useState<TransferTask[]>([])
  const [filter, setFilter] = useState<'all' | 'uploading' | 'queued' | 'failed'>('all')

  useEffect(() => {
    const off = window.quarksync?.onTransferUpdate((t) =>
      setTasks((prev) => [...prev.filter((x) => x.id !== t.id), t])
    )
    return () => off?.()
  }, [])

  const counts = {
    all: tasks.length,
    uploading: tasks.filter((t) => t.state === 'uploading').length,
    queued: tasks.filter((t) => t.state === 'queued').length,
    failed: tasks.filter((t) => t.state === 'failed').length
  }

  const shown = tasks.filter((t) => filter === 'all' || t.state === filter)

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>传输队列</h1>
          <p className="sub">上传任务、分片进度与失败重试。</p>
        </div>
      </div>

      <div className="card toolbar">
        <div className="chips">
          {(['all', 'uploading', 'queued', 'failed'] as const).map((k) => (
            <button
              key={k}
              className={`chip${filter === k ? ' active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {LABELS[k]} <i>{counts[k]}</i>
            </button>
          ))}
        </div>
      </div>

      <div className="card table-card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>文件</th>
              <th style={{ width: '10%' }}>大小</th>
              <th style={{ width: '18%' }}>进度</th>
              <th style={{ width: '16%' }}>哈希</th>
              <th style={{ width: '12%' }}>状态</th>
              <th style={{ width: '14%' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="dim" style={{ textAlign: 'center', padding: '28px 12px' }}>
                  队列为空
                </td>
              </tr>
            )}
            {shown.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="cell-file">
                    <Icon name="files" className="ic file" />
                    <span title={t.localPath}>{t.localPath}</span>
                  </div>
                </td>
                <td className="mono dim">{formatSize(t.size)}</td>
                <td>
                  <div className="bar" style={{ width: '100%' }}>
                    <i style={{ width: `${Math.round(t.progress * 100)}%` }} />
                  </div>
                  <span className="tiny mono">
                    {t.mode === 'multipart'
                      ? `分片 ${t.chunksDone}/${t.chunksTotal}`
                      : `${Math.round(t.progress * 100)}%`}
                  </span>
                </td>
                <td className="mono dim">
                  {t.md5Prefix}…
                  <br />
                  <span className="tiny">{t.sha1Prefix}…</span>
                </td>
                <td>
                  <span className={`pill ${stateTone(t.state)}`}>{stateLabel(t.state)}</span>
                </td>
                <td>
                  <div className="act-row">
                    {t.state === 'failed' && (
                      <button
                        className="btn tiny primary"
                        onClick={() => window.quarksync?.retryTransfer(t.id)}
                      >
                        重试
                      </button>
                    )}
                    {t.state !== 'done' && (
                      <button
                        className="btn tiny ghost"
                        onClick={() => window.quarksync?.cancelTransfer(t.id)}
                      >
                        取消
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const LABELS = { all: '全部', uploading: '上传中', queued: '等待', failed: '失败' } as const

function stateTone(state: TransferTask['state']): string {
  switch (state) {
    case 'uploading':
    case 'hashing':
      return 'accent'
    case 'queued':
      return 'blue'
    case 'done':
      return 'green'
    case 'failed':
      return 'red'
    default:
      return 'gray'
  }
}

function stateLabel(state: TransferTask['state']): string {
  switch (state) {
    case 'uploading':
      return '上传中'
    case 'hashing':
      return '计算哈希'
    case 'queued':
      return '等待'
    case 'verifying':
      return '校验中'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    case 'canceled':
      return '已取消'
    default:
      return state
  }
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
