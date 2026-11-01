import * as React from 'react'
import { useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import type { PageKey } from '../App'
import type { DiffKind, FileEntry } from '@shared/types'
import { formatSize } from './Queue'

/**
 * 文件清单。
 *
 * 两个维度必须分开呈现：
 * - 「同步状态」：这个本地文件传得怎么样
 * - 「对账差异」：两侧是否一致
 * 一个文件可以同时是「已同步」和「远端缺失」——绿色不能掩盖琥珀色。
 */
type StatusFilter = 'all' | 'synced' | 'pending' | 'deleted'
type DiffFilter = DiffKind | 'all' | 'none'

export function ManifestPage({ onNavigate }: { onNavigate: (k: PageKey) => void }): React.JSX.Element {
  const [files] = useState<FileEntry[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [diffFilter, setDiffFilter] = useState<DiffFilter>('all')

  const shown = useMemo(
    () =>
      files.filter((f) => {
        if (statusFilter !== 'all' && f.state !== statusFilter) return false
        return true
      }),
    [files, statusFilter]
  )

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>文件清单</h1>
          <p className="sub">本地文件的同步状态与远端归属，与 SQLite 清单一一对应。</p>
        </div>
      </div>

      <div className="card toolbar">
        <div className="rail-search inline">
          <Icon name="search" />
          <input placeholder="按路径、文件名或哈希搜索" />
        </div>
        <div className="chips">
          {(['all', 'synced', 'pending', 'deleted'] as StatusFilter[]).map((k) => (
            <button
              key={k}
              className={`chip${statusFilter === k ? ' active' : ''}`}
              onClick={() => setStatusFilter(k)}
            >
              {STATUS_LABELS[k]} <i>{files.filter((f) => k === 'all' || f.state === k).length}</i>
            </button>
          ))}
        </div>
      </div>

      {/* 差异维度：与同步状态分开的第二套筛选 */}
      <div className="card toolbar sub-toolbar">
        <div className="tb-label">
          <Icon name="diff" />
          远端对账差异
        </div>
        <div className="chips">
          <button
            className={`chip${diffFilter === 'all' ? ' active' : ''}`}
            onClick={() => setDiffFilter('all')}
          >
            不限
          </button>
          {DIFF_LABELS.map(([kind, label]) => (
            <button
              key={kind}
              className={`chip${diffFilter === kind ? ' active' : ''}`}
              onClick={() => setDiffFilter(kind)}
            >
              {label} <i>0</i>
            </button>
          ))}
        </div>
        <span className="lnk tb-link" onClick={() => onNavigate('reconcile')}>
          前往对账页 →
        </span>
      </div>

      <div className="card table-card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>本地路径</th>
              <th style={{ width: '9%' }}>大小</th>
              <th style={{ width: '12%' }}>修改时间</th>
              <th style={{ width: '20%' }}>远端路径</th>
              <th style={{ width: '11%' }}>哈希 (md5:sha1)</th>
              <th style={{ width: '10%' }}>同步状态</th>
              <th style={{ width: '10%' }}>对账差异</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="dim" style={{ textAlign: 'center', padding: '28px 12px' }}>
                  清单为空。启动本地扫描后这里会列出所有受管文件。
                </td>
              </tr>
            )}
            {shown.map((f) => (
              <tr key={f.id}>
                <td>
                  <div className="cell-file">
                    <Icon name="files" className="ic file" />
                    <span title={f.localPath}>{f.localPath}</span>
                  </div>
                </td>
                <td className="mono dim">{formatSize(f.localSize)}</td>
                <td className="mono dim nw">{formatTime(f.mtimeMs)}</td>
                <td className="mono dim">{f.remotePath ?? '—'}</td>
                <td className="mono dim">
                  {f.md5 ? `${f.md5.slice(0, 8)}:${f.sha1?.slice(0, 4) ?? ''}…` : '—'}
                </td>
                <td>
                  <span className={`pill ${stateTone(f.state)}`}>{STATE_LABELS[f.state] ?? f.state}</span>
                </td>
                <td>
                  <span className="pill gray">—</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: '全部',
  synced: '已同步',
  pending: '待处理',
  deleted: '已删除'
}

const DIFF_LABELS: [DiffKind, string][] = [
  ['missing_remote', '远端缺失'],
  ['remote_only', '仅远端存在'],
  ['size_mismatch', '内容不符'],
  ['mtime_mismatch', '时间差异']
]

const STATE_LABELS: Record<string, string> = {
  pending: '等待',
  hashing: '计算哈希',
  hashed: '待上传',
  uploading: '上传中',
  synced: '已同步',
  error: '失败',
  stale: '需重算',
  deleted: '已删除',
  local_only: '仅本地',
  remote_only: '仅远端',
  conflict: '冲突'
}

function stateTone(state: string): string {
  switch (state) {
    case 'synced':
      return 'green'
    case 'uploading':
    case 'hashing':
      return 'accent'
    case 'pending':
    case 'hashed':
      return 'blue'
    case 'error':
      return 'red'
    case 'deleted':
      return 'amber'
    case 'stale':
    case 'conflict':
      return 'orange'
    default:
      return 'gray'
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
