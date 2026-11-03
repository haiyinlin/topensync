import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { ROW_HEIGHT, VirtualTable } from '../components/VirtualTable'
import {
  Cell2,
  DetailRow,
  ExpandToggle,
  FileCell,
  RowDetail,
  detailHeight,
  splitPath
} from '../components/RowParts'
import type { SyncHistoryEntry, SyncHistoryKind, SkipReason } from '@shared/types'
import { formatSize } from '../format'

/**
 * 同步历史：上传 / 下载 / 跳过的**持久化**追溯。
 *
 * 为什么需要单独一页：
 * - 传输队列是内存快照，程序一关就没了；
 * - 运行日志有条数上限（清理到 10 万条、渲染层只留 500），刷多了就看不到；
 * - 文件清单只标「状态」不标「方向」，查不到「这个文件上次是上传还是下载」。
 *
 * 这张表永久落库（manifest.db 的 sync_history 表），分页加载，
 * 是「某个文件到底传没传、往哪边传、什么时候传的」的唯一权威出口。
 *
 * 「本地未变」这类每轮扫描都命中的常态**不记**——否则表会无限膨胀。
 */
const PAGE_SIZE = 500

type KindFilter = 'all' | SyncHistoryKind

export function History(): React.JSX.Element {
  const [kind, setKind] = useState<KindFilter>('all')
  const [rows, setRows] = useState<SyncHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)

  /*
   * 拉一页（从头）。
   *
   * 每次进页面、切方向筛选都重新拉第一页。分页用 offset 追加，
   * 不重复拉已经拿过的数据。
   */
  const loadFirst = useCallback(async (k: KindFilter): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.topensync?.listHistory({
        kind: k === 'all' ? undefined : k,
        limit: PAGE_SIZE,
        offset: 0
      })
      const items = list ?? []
      setRows(items)
      setReachedEnd(items.length < PAGE_SIZE)
    } catch {
      setRows([])
      setReachedEnd(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFirst(kind)
  }, [kind, loadFirst])

  const loadMore = async (): Promise<void> => {
    if (loading || reachedEnd) return
    setLoading(true)
    try {
      const more = await window.topensync?.listHistory({
        kind: kind === 'all' ? undefined : kind,
        limit: PAGE_SIZE,
        offset: rows.length
      })
      const items = more ?? []
      if (items.length === 0) {
        setReachedEnd(true)
      } else {
        setRows((prev) => prev.concat(items))
        setReachedEnd(items.length < PAGE_SIZE)
      }
    } finally {
      setLoading(false)
    }
  }

  const shown = rows

  /* ── 展开详情 ────────────────────────────────────────── */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rowIds = useMemo(() => shown.map((r) => String(r.id)), [shown])

  const expandedHeights = useMemo(() => {
    const m = new Map<string, number>()
    if (expanded.size === 0) return m
    for (const r of shown) {
      const id = String(r.id)
      if (expanded.has(id)) m.set(id, ROW_HEIGHT + detailHeight(historyDetail(r)))
    }
    return m
  }, [expanded, shown])

  const rowHeight = useCallback(
    (i: number) => expandedHeights.get(rowIds[i]) ?? ROW_HEIGHT,
    [expandedHeights, rowIds]
  )

  const counts = useMemo(() => {
    // 只统计已加载的这页，作为筛选按钮的参考数字（非全库精确值）
    const c: Record<string, number> = { all: rows.length, upload: 0, download: 0, skip: 0 }
    for (const r of rows) c[r.kind] = (c[r.kind] ?? 0) + 1
    return c
  }, [rows])

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>同步历史</h1>
          <p className="sub">
            每次上传、下载与跳过的永久记录，按时间倒序，可长期翻页追溯。
          </p>
        </div>
      </div>

      <div className="card toolbar">
        <div className="tb-label">
          <Icon name="clock" />
          方向
        </div>
        <div className="chips">
          {(['all', 'upload', 'download', 'skip'] as KindFilter[]).map((k) => (
            <button
              key={k}
              className={`chip${kind === k ? ' active' : ''}`}
              onClick={() => setKind(k)}
            >
              {KIND_LABELS[k]} <i>{counts[k] ?? 0}</i>
            </button>
          ))}
        </div>
        <span className="tb-hint">
          只记真正发生的上传 / 下载与有原因的跳过；「本地未变」不记，避免列表无限膨胀
        </span>
      </div>

      <div className="card table-card">
        <VirtualTable
          head={
            <tr>
              <th style={{ width: 30 }} />
              <th style={{ width: 106 }}>时间</th>
              <th style={{ width: 76 }}>方向</th>
              <th>本地文件</th>
              <th style={{ width: 96 }}>大小</th>
              <th style={{ width: 210 }}>说明</th>
            </tr>
          }
          rowCount={shown.length}
          rowHeight={rowHeight}
          renderRow={(index) => {
            const r = shown[index]
            if (!r) return null
            const rid = String(r.id)
            const open = expanded.has(rid)
            const { name, dir } = splitPath(r.localPath)
            const note =
              r.kind === 'skip' && r.skipReason ? SKIP_REASON_LABELS[r.skipReason] : ''
            return (
              <React.Fragment key={r.id}>
                <tr className={`row-main${open ? ' expanded' : ''}`}>
                  <td>
                    <ExpandToggle open={open} onToggle={() => toggleExpand(rid)} />
                  </td>
                  {/*
                    * 时间拆两行：上行日期、下行时分秒。
                    * 挤在一行要 19 个字符，列宽不够就被截成「2026-11-03 22:26:1…」，
                    * 秒都不完整；拆开之后两行都短，永远不会被截。
                    */}
                  <td>
                    <Cell2
                      line1={dateOf(r.at)}
                      line2={<span className="mono">{timeOf(r.at)}</span>}
                    />
                  </td>
                  <td>
                    <span className={`pill ${KIND_TONES[r.kind]}`}>{KIND_LABELS[r.kind]}</span>
                  </td>
                  <td>
                    <FileCell
                      name={name}
                      meta={dir || undefined}
                      title={r.localPath}
                    />
                  </td>
                  <td className="mono dim">{formatSize(r.size)}</td>
                  <td className="dim" title={note || undefined}>
                    {note}
                  </td>
                </tr>
                {open && <RowDetail rows={historyDetail(r)} colSpan={6} />}
              </React.Fragment>
            )
          }}
          maxHeight={560}
          empty={loading ? '正在加载…' : '暂无同步历史。开始同步后，上传、下载与跳过的记录会出现在这里。'}
        />
      </div>

      {!reachedEnd && (
        <div className="card toolbar" style={{ justifyContent: 'center' }}>
          <button className="btn ghost" onClick={() => void loadMore()} disabled={loading}>
            {loading ? '加载中…' : `加载更多（已显示 ${shown.length} 条）`}
          </button>
        </div>
      )}
    </section>
  )
}

const KIND_LABELS: Record<KindFilter, string> = {
  all: '全部',
  upload: '上传',
  download: '下载',
  skip: '跳过'
}

const KIND_TONES: Record<SyncHistoryKind, string> = {
  upload: 'green',
  download: 'blue',
  skip: 'gray'
}

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  local_duplicate: '本地未变（不记历史）',
  remote_duplicate: '远端已有相同内容（哈希判定）',
  remote_size_match: '远端已有同名同大小文件（未校验内容）',
  file_gone: '本地文件已不存在'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 只取日期部分（列表第一行） */
function dateOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 只取时分秒（列表第二行） */
function timeOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 展开区的详情：完整路径与精确时间 */
function historyDetail(r: SyncHistoryEntry): DetailRow[] {
  const rows: DetailRow[] = [
    {
      items: [
        { k: '本地路径', v: r.localPath || '—', mono: true, title: r.localPath },
        {
          k: '远端路径',
          v: r.remotePath ?? '—',
          mono: true,
          title: r.remotePath ?? undefined
        }
      ]
    },
    {
      items: [
        { k: '发生时间', v: formatTime(r.at), mono: true },
        { k: '大小', v: formatSize(r.size), mono: true }
      ]
    }
  ]
  if (r.kind === 'skip' && r.skipReason) {
    rows.push({ items: [{ k: '跳过原因', v: SKIP_REASON_LABELS[r.skipReason] }] })
  }
  return rows
}
