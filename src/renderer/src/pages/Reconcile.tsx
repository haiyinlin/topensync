import * as React from 'react'
import { useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import type { DiffKind, DiffResolution } from '@shared/types'
import { useAppStore } from '../store'

/**
 * 远端对账页。
 *
 * 差异是「需要人判断」的东西，与「机器正在传」是两种事，
 * 所以差异有专属页面，不塞进概览或队列。
 */
const KIND_META: Record<DiffKind, { label: string; tone: string; desc: string }> = {
  missing_remote: { label: '远端缺失', tone: 'amber', desc: '本地文件在远端不存在，将重新上传' },
  remote_only: { label: '仅远端存在', tone: 'purple', desc: '远端有本地无，默认只记录不处理' },
  size_mismatch: { label: '内容不符', tone: 'orange', desc: '两侧大小不同，将以本地为准覆盖' },
  mtime_mismatch: { label: '时间差异', tone: 'gray', desc: '仅修改时间不同，大小一致' },
  local_only: { label: '仅本地存在', tone: 'gray', desc: '尚未上传到远端' }
}

type Filter = DiffKind | 'all'

export function Reconcile(): React.JSX.Element {
  const diffs = useAppStore((s) => s.diffs)
  const refreshDiffs = useAppStore((s) => s.refreshDiffs)
  const scan = useAppStore((s) => s.stats?.remoteScan ?? null)
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const d of diffs) c[d.kind] = (c[d.kind] ?? 0) + 1
    return c
  }, [diffs])

  const shown = diffs.filter((d) => filter === 'all' || d.kind === filter)

  const resolve = (id: number, resolution: DiffResolution): void => {
    window.topensync?.resolveDiff(id, resolution)
    // 处置结果由主进程落库，这里重新拉一次未处置差异
    setTimeout(() => void refreshDiffs(), 400)
  }

  const trigger = (): void => {
    setBusy(true)
    window.topensync?.triggerScan('remote')
    setTimeout(() => setBusy(false), 2600)
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>远端对账</h1>
          <p className="sub">列举远端文件树并与本地清单比对，找出两侧不一致之处。</p>
        </div>
        <div className="head-actions">
          <button className={`btn ghost${busy ? ' busy' : ''}`} onClick={trigger} disabled={busy}>
            <Icon name="diff" />
            {busy ? '对账中…' : '立即对账'}
          </button>
        </div>
      </div>

      <div className="card recon-bar">
        <div className="rb-item">
          <span className="rb-k">上次对账</span>
          <b className="mono">
            {scan?.lastScanAt ? new Date(scan.lastScanAt).toLocaleString('zh-CN') : '尚未运行'}
          </b>
        </div>
        <div className="rb-item">
          <span className="rb-k">耗时</span>
          <b className="mono">{scan?.running ? '进行中' : '—'}</b>
        </div>
        <div className="rb-item">
          <span className="rb-k">扫描文件</span>
          <b className="mono">{scan?.scannedCount ?? 0}</b>
        </div>
        <div className="rb-item">
          <span className="rb-k">发现差异</span>
          <b className="mono">{scan?.diffCount ?? 0}</b>
        </div>
        <div className="rb-item rb-status">
          <span className="rb-k">状态</span>
          <b className={scan?.lastScanStatus === 'done' ? 'ok' : undefined}>
            {scan?.lastScanStatus === 'done'
              ? '已完成'
              : scan?.lastScanStatus === 'running'
                ? '进行中'
                : scan?.lastScanStatus === 'failed'
                  ? '失败'
                  : scan?.lastScanStatus === 'cancelled'
                    ? '超时中止'
                    : '—'}
          </b>
        </div>
      </div>

      <div className="grid diff-grid">
        {(['missing_remote', 'remote_only', 'size_mismatch', 'mtime_mismatch'] as DiffKind[]).map(
          (kind) => (
            <div className={`card dstat d-${kind.split('_')[0]}`} key={kind}>
              <div className="dstat-head">
                <Icon name={kind === 'missing_remote' ? 'alert' : kind === 'remote_only' ? 'cloud-check' : kind === 'size_mismatch' ? 'overwrite' : 'clock'} />
                {KIND_META[kind].label}
              </div>
              <div className="dstat-val mono">{counts[kind] ?? 0}</div>
              <div className="dstat-foot">{KIND_META[kind].desc}</div>
            </div>
          )
        )}
      </div>

      <div className="card toolbar">
        <div className="rail-search inline">
          <Icon name="search" />
          <input placeholder="按路径搜索差异项" />
        </div>
        <div className="chips">
          <button
            className={`chip${filter === 'all' ? ' active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部差异 <i>{diffs.length}</i>
          </button>
          {(Object.keys(KIND_META) as DiffKind[]).map((kind) => (
            <button
              key={kind}
              className={`chip${filter === kind ? ' active' : ''}`}
              onClick={() => setFilter(kind)}
            >
              {KIND_META[kind].label} <i>{counts[kind] ?? 0}</i>
            </button>
          ))}
        </div>
      </div>

      <div className="card table-card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '12%' }}>类型</th>
              <th style={{ width: '28%' }}>路径</th>
              <th style={{ width: '14%' }}>本地</th>
              <th style={{ width: '14%' }}>远端</th>
              <th style={{ width: '12%' }}>发现时间</th>
              <th style={{ width: '20%' }}>处理</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="dim" style={{ textAlign: 'center', padding: '28px 12px' }}>
                  暂无差异。运行一次对账以核对远端文件树。
                </td>
              </tr>
            )}
            {shown.map((d) => (
              <tr key={d.id}>
                <td>
                  <span className={`pill ${KIND_META[d.kind].tone}`}>{KIND_META[d.kind].label}</span>
                </td>
                <td>
                  <div className="cell-file">
                    <Icon name="files" className="ic file" />
                    <span title={d.remotePath}>{d.remotePath}</span>
                  </div>
                </td>
                <td className="mono dim">
                  {d.localSize !== null ? `${formatSize(d.localSize)}` : '—'}
                  <br />
                  <span className="tiny">{d.localMtime ? formatTime(d.localMtime) : ''}</span>
                </td>
                <td className="mono dim">
                  {d.remoteSize !== null ? formatSize(d.remoteSize) : '—'}
                  <br />
                  <span className="tiny">
                    {d.kind === 'missing_remote' ? '已被外部删除' : d.remoteMtime ? formatTime(d.remoteMtime) : ''}
                  </span>
                </td>
                <td className="mono dim nw">{formatTime(d.detectedAt)}</td>
                <td>
                  <div className="act-row">
                    {d.kind === 'missing_remote' && (
                      <button className="btn tiny primary" onClick={() => resolve(d.id, 'uploaded')}>
                        重新上传
                      </button>
                    )}
                    {d.kind === 'size_mismatch' && (
                      <button className="btn tiny primary" onClick={() => resolve(d.id, 'overwritten')}>
                        覆盖远端
                      </button>
                    )}
                    {d.kind === 'remote_only' && (
                      <>
                        <button className="btn tiny ghost" onClick={() => resolve(d.id, 'pulled')}>
                          <Icon name="down" />
                          下载到本地
                        </button>
                        <button className="btn tiny ghost" onClick={() => resolve(d.id, 'deleted_remote')}>
                          <Icon name="trash" />
                          移入回收站
                        </button>
                      </>
                    )}
                    <button className="btn tiny ghost" onClick={() => resolve(d.id, 'ignored')}>
                      忽略
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="warn-note">
        <Icon name="shield" />
        默认策略为「本地为准」：远端缺失与内容不符会自动重传；仅远端存在的文件只记录不处理，避免误删其他设备刚上传的内容。单次自动修复上限 20 个文件，超出则仅记录并在此列出。
      </p>
    </section>
  )
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
