import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { ROW_HEIGHT, VirtualTable } from '../components/VirtualTable'
import { DetailRow, ExpandToggle, RowDetail, detailHeight, splitPath } from '../components/RowParts'
import { useAppStore } from '../store'
import type { LogCategory, LogEntry } from '@shared/types'

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
 *
 * 布局：**说明是主角**。
 * 以前说明排在最后一列、只剩几十像素宽，长句子被截成「内存…」，
 * 等于这条日志完全没法读。现在说明独占主列（第一行），
 * 涉及的文件路径退到第二行，要全文和精确时间就展开。
 */
export function Logs(): React.JSX.Element {
  const logs = useAppStore((s) => s.logs)
  const exportDiagnostics = useAppStore((s) => s.exportDiagnostics)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [category, setCategory] = useState<'all' | LogCategory>('all')
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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

  /*
   * 日志没有稳定主键（ts 可能重复），用「时间 + 序号」拼一个。
   * 与渲染 key 用的是同一套，展开状态才不会在刷新后跳到别的行上。
   */
  const rowIds = useMemo(() => shown.map((l, i) => `${l.ts}-${i}`), [shown])

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandedHeights = useMemo(() => {
    const m = new Map<string, number>()
    if (expanded.size === 0) return m
    for (let i = 0; i < shown.length; i++) {
      const id = rowIds[i]
      if (expanded.has(id)) m.set(id, ROW_HEIGHT + detailHeight(logDetail(shown[i])))
    }
    return m
  }, [expanded, shown, rowIds])

  const rowHeight = useCallback(
    (i: number) => expandedHeights.get(rowIds[i]) ?? ROW_HEIGHT,
    [expandedHeights, rowIds]
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
        <VirtualTable
          head={
            <tr>
              <th style={{ width: 30 }} />
              <th style={{ width: 92 }}>时间</th>
              {/*
                * 徽章列要留够 pill 的全宽 + 单元格左右 padding（12×2）。
                * 72px 时可用宽度只剩 48px，`ERROR` 徽章宽约 52px，
                * 差几个像素就会被 td 的 text-overflow 判成溢出，
                * 在徽章右边渲染出一串「…」——和勾选框列那个坑同源。
                */}
              <th style={{ width: 86 }}>级别</th>
              <th style={{ width: 84 }}>类别</th>
              <th>说明</th>
            </tr>
          }
          rowCount={shown.length}
          rowHeight={rowHeight}
          renderRow={(index) => {
            const l = shown[index]
            if (!l) return null
            const rid = rowIds[index]
            const open = expanded.has(rid)
            const file = l.filePath ? splitPath(l.filePath) : null
            return (
              <React.Fragment key={rid}>
                <tr className={`row-main${open ? ' expanded' : ''}`}>
                  <td>
                    <ExpandToggle open={open} onToggle={() => toggleExpand(rid)} />
                  </td>
                  <td className="mono dim nw">{timeOf(l.ts)}</td>
                  <td>
                    <span className={`pill ${LEVEL_TONES[l.level]}`}>{l.level.toUpperCase()}</span>
                  </td>
                  <td>
                    <span className={`pill ${CATEGORY_LABELS[l.category].tone}`}>
                      {CATEGORY_LABELS[l.category].label}
                    </span>
                  </td>
                  {/*
                    * 说明是这一页真正要读的东西，所以给它第一行和全部剩余宽度；
                    * 文件路径降到第二行（它只在「这条日志关于哪个文件」时才重要）。
                    */}
                  <td>
                    <div className="cell2">
                      <div className="cell2-l1">
                        <span className="cell2-name" title={l.message}>
                          {l.message}
                        </span>
                      </div>
                      {file ? (
                        <div className="cell2-l2">
                          {file.dir ? `${file.dir}/` : ''}
                          {file.name}
                        </div>
                      ) : l.remotePath ? (
                        <div className="cell2-l2">{l.remotePath}</div>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {open && <RowDetail rows={logDetail(l)} colSpan={5} />}
              </React.Fragment>
            )
          }}
          maxHeight={560}
          empty={logs.length === 0 ? '暂无日志' : '当前筛选条件下没有日志'}
        />
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

/** 只取时分秒：日志是按分钟看的，日期在标题区已经交代过 */
function timeOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 完整时间（含日期），展开时用 */
function fullTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 展开详情。
 *
 * 长说明（比如内存自检那一行）在主行里放不下，这里给 3 行空间；
 * 再长就看 title 或导出日志。
 */
function logDetail(l: LogEntry): DetailRow[] {
  const rows: DetailRow[] = [
    {
      items: [{ k: '说明', v: l.message, title: l.message }],
      // 短消息一行足够；超过两行的才占高行，避免每次展开都空一大块
      tall: l.message.length > 60
    }
  ]
  if (l.filePath || l.remotePath) {
    rows.push({
      items: [
        { k: '本地文件', v: l.filePath ?? '—', mono: true, title: l.filePath ?? undefined },
        { k: '远端位置', v: l.remotePath ?? '—', mono: true, title: l.remotePath ?? undefined }
      ]
    })
  }
  rows.push({
    items: [
      { k: '时间', v: fullTime(l.ts), mono: true },
      { k: '级别', v: l.level.toUpperCase(), mono: true }
    ]
  })
  return rows
}
