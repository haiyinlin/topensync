import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { BatchBar } from '../components/BatchBar'
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
import type { DiffEntry, DiffKind, DiffResolution } from '@shared/types'
import { useAppStore } from '../store'

/**
 * 远端对账页。
 *
 * 差异是「需要人判断」的东西，与「机器正在传」是两种事，
 * 所以差异有专属页面，不塞进概览或队列。
 *
 * 删除语义：**删远端文件**（移入回收站），并关闭该差异。
 * 本地文件不动——远端有本地无的差异删掉的是远端那份，
 * 本地有远端无的差异要删得去文件清单页。
 *
 * 差异只回答「这个文件在不在」：
 * 「仅修改时间不同」不算差异（复制、解压、跨设备同步都会改 mtime，
 * 而内容可能一模一样），列出来只是噪声。
 */
const KIND_META: Record<DiffKind, { label: string; tone: string; desc: string }> = {
  missing_remote: { label: '远端缺失', tone: 'amber', desc: '本地文件在远端不存在，将重新上传' },
  remote_only: { label: '仅在远端', tone: 'purple', desc: '远端有本地无，默认只记录不处理' },
  size_mismatch: { label: '内容不符', tone: 'orange', desc: '两侧大小不同，将以本地为准覆盖' },
  local_only: { label: '仅本地', tone: 'gray', desc: '尚未上传到远端' }
}

/**
 * 差异类型 → 统计卡配色类。
 *
 * 早先用 `kind.split('_')[0]` 拼类名，结果 size_mismatch 拼出 `d-size`、
 * local_only 拼出 `d-local`——这两个类样式表里根本没有，
 * 卡片就没了颜色，跟「有控件但不生效」一样是骗人的。
 * 这里改成显式映射，类名与样式表一一对应。
 */
const KIND_CARD_CLASS: Record<DiffKind, string> = {
  missing_remote: 'd-missing',
  remote_only: 'd-remote',
  size_mismatch: 'd-conflict',
  // 仅本地＝远端也缺这个文件，语义上与「远端缺失」同源
  local_only: 'd-missing'
}

type Filter = DiffKind | 'all'

export function Reconcile(): React.JSX.Element {
  const diffs = useAppStore((s) => s.diffs)
  const refreshDiffs = useAppStore((s) => s.refreshDiffs)
  const deleteRemoteFiles = useAppStore((s) => s.deleteRemoteFiles)
  const scan = useAppStore((s) => s.stats?.remoteScan ?? null)
  const progress = useAppStore((s) => s.progress)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  /*
   * 对账进行中：本地标记 + 主进程推来的真实进度。
   *
   * 以前用 setTimeout(2600) 猜「对账大概要这么久」——
   * 远端文件多的时候对账要好几分钟，按钮早就恢复了常态，
   * 用户会以为没生效。现在由真实进度驱动。
   *
   * 只看**对账那条通道**的进度：本地扫描在跑不该让这个按钮转圈。
   */
  const reconciling = busy || progress.remote?.running === true

  // 进度结束就清掉本地标记，否则按钮永远停在禁用态
  React.useEffect(() => {
    if (!progress.remote?.running) setBusy(false)
  }, [progress.remote?.running])

  // 进页面刷一次差异：对账是后台跑的，差异可能在你不看这个页面时产生或消失
  React.useEffect(() => {
    void refreshDiffs()
  }, [refreshDiffs])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const d of diffs) c[d.kind] = (c[d.kind] ?? 0) + 1
    return c
  }, [diffs])

  /*
   * 筛选结果必须先记忆化再派生 ID 列表：
   * 之前 shown 是每次渲染现场 filter 出来的新数组，
   * useMemo 的依赖每次都变，缓存永远不命中，全选也就永远选不全。
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return diffs.filter(
      (d) =>
        (filter === 'all' || d.kind === filter) &&
        (q === '' || d.remotePath.toLowerCase().includes(q))
    )
  }, [diffs, filter, query])
  const shownIds = useMemo(() => shown.map((d) => String(d.id)), [shown])

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

  /** 只对展开中的行算高度，rowHeight 里 O(1) 查表 */
  const expandedHeights = useMemo(() => {
    const m = new Map<string, number>()
    for (const id of expanded) {
      const d = shown.find((x) => String(x.id) === id)
      if (d) m.set(id, ROW_HEIGHT + detailHeight(diffDetail(d)))
    }
    return m
  }, [expanded, shown])

  const rowHeight = useCallback(
    (i: number) => expandedHeights.get(shownIds[i]) ?? ROW_HEIGHT,
    [expandedHeights, shownIds]
  )

  /*
   * 全选（表头常驻）。
   *
   * 以前全选框藏在 BatchBar 里，而 BatchBar 在「没选中任何项」时
   * 整个不渲染——用户永远看不到全选框，
   * 必须先手动勾一个才能「全选」。逻辑倒置。
   */
  const allSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id))
  const someSelected = shownIds.some((id) => selected.has(id))
  const toggleSelectAll = (): void => {
    if (allSelected) {
      const next = new Set(selected)
      for (const id of shownIds) next.delete(id)
      setSelected(next)
      return
    }
    setSelected(new Set([...selected, ...shownIds]))
  }

  const resolve = (id: number, resolution: DiffResolution): void => {
    /*
     * 等主进程真的处理完再刷新列表。
     *
     * 以前是 `send` + `setTimeout(400)` 猜时间：
     * 「移入回收站」要走网络请求，400ms 常常不够，
     * 差异行就留在表里，用户以为操作没生效，反复点。
     * 现在改成 invoke，await 完再刷新，时序是确定的。
     */
    void window.topensync
      ?.resolveDiff(id, resolution)
      .then(() => refreshDiffs())
      .catch(() => refreshDiffs())
  }

  const trigger = (): void => {
    if (reconciling) return
    setBusy(true)
    window.topensync?.triggerScan('remote')
    // 对账结束后主进程会推 scan:update，store 届时刷新差异列表。
    // 这里再兜一次：慢速服务端上对账可能超过 3 秒。
    setTimeout(() => void refreshDiffs(), 2600)
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>远端对账</h1>
          <p className="sub">列举远端文件树并与本地清单比对，找出两侧不一致之处。</p>
        </div>
        <div className="head-actions">
          <button className={`btn ghost${reconciling ? ' busy' : ''}`} onClick={trigger} disabled={reconciling}>
            <Icon name="diff" />
            {reconciling ? '对账中…' : '立即对账'}
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
        {(['missing_remote', 'remote_only', 'size_mismatch'] as DiffKind[]).map((kind) => (
          <div className={`card dstat ${KIND_CARD_CLASS[kind]}`} key={kind}>
            <div className="dstat-head">
              <Icon
                name={
                  kind === 'missing_remote'
                    ? 'alert'
                    : kind === 'remote_only'
                      ? 'cloud-check'
                      : 'overwrite'
                }
              />
              {KIND_META[kind].label}
            </div>
            <div className="dstat-val mono">{counts[kind] ?? 0}</div>
            <div className="dstat-foot">{KIND_META[kind].desc}</div>
          </div>
        ))}
      </div>

      <div className="card toolbar">
        <div className="rail-search inline">
          <Icon name="search" />
          <input
            placeholder="按路径搜索差异项"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
        <VirtualTable
          head={
            <tr>
              <th style={{ width: 38 }}>
                <label className="batch-check" title="全选 / 全不选当前筛选出的差异项">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && someSelected
                    }}
                    onChange={toggleSelectAll}
                  />
                </label>
              </th>
              <th style={{ width: 30 }} />
              <th style={{ width: 92 }}>类型</th>
              <th>路径</th>
              <th style={{ width: 132 }}>本地</th>
              <th style={{ width: 132 }}>远端</th>
              <th style={{ width: 100 }}>发现时间</th>
              <th style={{ width: 196 }}>处理</th>
            </tr>
          }
          rowCount={shown.length}
          rowHeight={rowHeight}
          renderRow={(index) => {
            const d = shown[index]
            if (!d) return null
            const rid = String(d.id)
            const open = expanded.has(rid)
            const { name, dir } = splitPath(d.remotePath)
            return (
              <React.Fragment key={d.id}>
                <tr className={`row-main${open ? ' expanded' : ''}`}>
                  <td>
                    <label className="batch-check">
                      <input
                        type="checkbox"
                        checked={selected.has(rid)}
                        onChange={() => {
                          const next = new Set(selected)
                          if (next.has(rid)) next.delete(rid)
                          else next.add(rid)
                          setSelected(next)
                        }}
                      />
                    </label>
                  </td>
                  <td>
                    <ExpandToggle open={open} onToggle={() => toggleExpand(rid)} />
                  </td>
                  <td>
                    <span className={`pill ${KIND_META[d.kind].tone}`}>
                      {KIND_META[d.kind].label}
                    </span>
                  </td>
                  <td>
                    <FileCell
                      name={name}
                      meta={dir || undefined}
                      title={d.remotePath}
                    />
                  </td>
                  {/*
                    * 本地/远端各占一列、两行显示：第一行大小、第二行时间。
                    * 以前挤成一行「7.9 GB · 2022-11-03 19:31」，
                    * 列一窄就从时间中间被切断，连年份都看不全。
                    */}
                  <td>
                    <Cell2
                      line1={d.localSize !== null ? formatSize(d.localSize) : '—'}
                      line2={d.localMtime ? formatTime(d.localMtime) : undefined}
                    />
                  </td>
                  <td>
                    <Cell2
                      line1={d.remoteSize !== null ? formatSize(d.remoteSize) : '—'}
                      line2={
                        d.kind === 'missing_remote'
                          ? '已被外部删除'
                          : d.remoteMtime
                            ? formatTime(d.remoteMtime)
                            : undefined
                      }
                    />
                  </td>
                  <td>
                    <Cell2
                      line1={dateOnly(d.detectedAt)}
                      line2={<span className="mono">{timeOnly(d.detectedAt)}</span>}
                    />
                  </td>
                  <td>
                    {/*
                      * 所有操作压成一行。
                      *
                      * 以前「下载到本地 / 移入回收站 / 忽略」三个文字按钮
                      * 在窄列里换行成两排，把行高撑成别人的两倍，
                      * 整张表的节奏全乱。次要操作改成图标 + 悬停提示。
                      */}
                    <div className="act-row">
                      {d.kind === 'missing_remote' && (
                        <button
                          className="btn tiny primary"
                          onClick={() => resolve(d.id, 'uploaded')}
                        >
                          重新上传
                        </button>
                      )}
                      {d.kind === 'size_mismatch' && (
                        <button
                          className="btn tiny primary"
                          onClick={() => resolve(d.id, 'overwritten')}
                        >
                          覆盖远端
                        </button>
                      )}
                      {d.kind === 'remote_only' && (
                        <>
                          <button
                            className="btn tiny primary"
                            onClick={() => resolve(d.id, 'pulled')}
                          >
                            <Icon name="down" />
                            下载
                          </button>
                          <button
                            className="btn tiny ghost"
                            title="移入远端回收站"
                            onClick={() => resolve(d.id, 'deleted_remote')}
                          >
                            <Icon name="trash" />
                          </button>
                        </>
                      )}
                      <button
                        className="btn tiny ghost"
                        onClick={() => resolve(d.id, 'ignored')}
                      >
                        忽略
                      </button>
                    </div>
                  </td>
                </tr>
                {open && <RowDetail rows={diffDetail(d)} colSpan={8} />}
              </React.Fragment>
            )
          }}
          maxHeight={560}
          empty={
            diffs.length === 0
              ? '暂无差异。运行一次对账以核对远端文件树。'
              : '没有符合当前筛选条件的差异项。'
          }
        />
      </div>

      <BatchBar
        allIds={shownIds}
        selected={selected}
        onSelectionChange={setSelected}
        hint={`已选 ${selected.size} 项`}
        actions={[
          {
            label: '删除远端文件',
            danger: true,
            confirmTitle: '删除远端文件',
            confirmBody: '将把选中的远端文件移入远端回收站，并关闭对应差异。本地文件不受影响。',
            onRun: async (ids) => {
              const targets = diffs
                .filter((d) => ids.includes(String(d.id)))
                .map((d) => ({ remotePath: d.remotePath, diffId: d.id }))
              if (targets.length === 0) return
              await deleteRemoteFiles(targets)
            }
          },
          {
            label: '忽略',
            danger: false,
            confirmTitle: '忽略这些差异',
            confirmBody: '仅标记为已忽略，不改动任何文件。',
            onRun: async (ids) => {
              for (const id of ids) {
                const diffId = Number(id)
                if (Number.isFinite(diffId)) {
                  window.topensync?.resolveDiff(diffId, 'ignored')
                }
              }
              setTimeout(() => void refreshDiffs(), 400)
            }
          }
        ]}
      />

      <p className="warn-note">
        <Icon name="shield" />
        默认策略为「本地为准」：远端缺失与内容不符会自动重传；仅远端存在的文件只记录不处理，避免误删其他设备刚上传的内容。单次自动修复上限 20 个文件，超出则仅记录并在此列出。
      </p>
    </section>
  )
}

/**
 * 差异行的展开详情。
 *
 * 列表里只看得到「文件名 + 大小」，真要动手处理前
 * 往往得确认一下两侧的完整路径和时间——尤其是远端那份到底在哪。
 */
function diffDetail(d: DiffEntry): DetailRow[] {
  return [
    {
      items: [
        { k: '远端路径', v: d.remotePath, mono: true, title: d.remotePath },
        { k: '本地路径', v: d.localPath ?? '—（本地没有这个文件）', mono: true, title: d.localPath ?? undefined }
      ]
    },
    {
      items: [
        { k: '本地大小', v: d.localSize !== null ? formatSize(d.localSize) : '—', mono: true },
        { k: '远端大小', v: d.remoteSize !== null ? formatSize(d.remoteSize) : '—', mono: true }
      ]
    },
    {
      items: [
        { k: '本地时间', v: d.localMtime ? formatTime(d.localMtime) : '—', mono: true },
        { k: '远端时间', v: d.remoteMtime ? formatTime(d.remoteMtime) : '—', mono: true }
      ]
    }
  ]
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

/** 列表第一行：只有日期 */
function dateOnly(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 列表第二行：时分 */
function timeOnly(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
