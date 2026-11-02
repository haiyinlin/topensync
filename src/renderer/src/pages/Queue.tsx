import * as React from 'react'
import { useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { BatchBar } from '../components/BatchBar'
import { VirtualTable } from '../components/VirtualTable'
import type { TransferCategory, TransferTask } from '@shared/types'
import { useAppStore } from '../store'
import { formatSpeed } from './Overview'

/**
 * 传输队列：进行中 / 等待 / 失败任务，分片进度与逐项重试。
 *
 * 每个任务都带一个**类别**：上传 / 下载 / 跳过。
 * 「跳过」单列成一类是因为它是最需要解释的一类——
 * 文件没传上去，用户得立刻知道是「本地没变」还是「远端已有」。
 *
 * 删除语义：**只清队列里的记录，不动文件**。
 * 队列是历史快照，「删除」指的是「这条记录我不要看了」；
 * 真要删文件请去文件清单页——两者混在一起会误删数据。
 */
type StateFilter = 'all' | 'uploading' | 'queued' | 'done' | 'failed' | 'canceled' | 'skipped'
type CategoryFilter = 'all' | TransferCategory

/**
 * 「进行中」的口径：上传、哈希、下载都算。
 *
 * 概览页、侧栏徽章都按这个口径统计——以前这里把 downloading 算进去、
 * 概览页没算，两边数字对不上，用户看哪边都像软件坏了。
 */
function isActiveState(state: TransferTask['state']): boolean {
  return state === 'uploading' || state === 'hashing' || state === 'downloading'
}

/**
 * 跳过态不该显示进度条。
 *
 * 跳过的文件**根本没有进度可言**——它没传，一个空的进度条加「0%」
 * 看着像「卡在 0% 没动」。用户会反复点它、或者以为程序坏了。
 */
function isSkipped(task: TransferTask): boolean {
  return task.category === 'skip' || task.state === 'skipped'
}

export function Queue(): React.JSX.Element {
  const tasks = useAppStore((s) => s.tasks)
  const removeTasks = useAppStore((s) => s.removeTasks)
  const [filter, setFilter] = useState<StateFilter>('all')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const stateCounts = {
    all: tasks.length,
    uploading: tasks.filter((t) => isActiveState(t.state)).length,
    queued: tasks.filter((t) => t.state === 'queued').length,
    done: tasks.filter((t) => t.state === 'done').length,
    failed: tasks.filter((t) => t.state === 'failed').length,
    canceled: tasks.filter((t) => t.state === 'canceled').length,
    skipped: tasks.filter((t) => t.state === 'skipped').length
  }

  const categoryCounts = {
    all: tasks.length,
    upload: tasks.filter((t) => t.category === 'upload').length,
    download: tasks.filter((t) => t.category === 'download').length,
    skip: tasks.filter((t) => t.category === 'skip').length
  }

  /*
   * 筛选结果先记忆化，再基于它派生 ID 列表：
   * 之前 shown 每次渲染都新建，useMemo 的依赖每次都变，
   * 缓存永远不命中，全选也就永远选不全。
   *
   * **倒序**（最新的排前面）：任务 id 是 UUID，没有时间字段，
   * 而 Map 的插入序就是创建序——反转即可得到「最新在前」。
   * 用户找刚出问题的任务时，不用从几千条里往上翻。
   */
  const shown = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            (filter === 'all' || matchesState(t.state, filter)) &&
            (category === 'all' || t.category === category)
        )
        .reverse(),
    [tasks, filter, category]
  )

  const shownIds = useMemo(() => shown.map((t) => t.id), [shown])

  /*
   * 全选。
   *
   * 以前全选框藏在 BatchBar 里，而 BatchBar 在「没选中任何项」时
   * 整个不渲染——于是用户**永远看不到全选框**，
   * 必须先手动勾一个才能「全选」。逻辑倒置。
   *
   * 现在表头有一列常驻的全选框，勾上即选中当前筛选出的全部。
   */
  const allSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id))
  const someSelected = shownIds.some((id) => selected.has(id))
  const toggleSelectAll = (): void => {
    if (allSelected) {
      // 取消全选：只摘掉当前可见的，保留其它筛选下的已选项
      const next = new Set(selected)
      for (const id of shownIds) next.delete(id)
      setSelected(next)
      return
    }
    setSelected(new Set([...selected, ...shownIds]))
  }

  const renderRow = (index: number): React.ReactNode => {
    const t = shown[index]
    if (!t) return null
    const skipped = isSkipped(t)
    return (
      <tr key={t.id}>
        <td>
          <label className="batch-check">
            <input
              type="checkbox"
              checked={selected.has(t.id)}
              onChange={() => {
                const next = new Set(selected)
                if (next.has(t.id)) next.delete(t.id)
                else next.add(t.id)
                setSelected(next)
              }}
            />
          </label>
        </td>
        <td>
          <div className="cell-file">
            <Icon name={t.category === 'download' ? 'down' : 'files'} className="ic file" />
            <span title={t.localPath}>{t.localPath}</span>
          </div>
        </td>
        <td>
          <span className={`pill ${categoryTone(t.category)}`}>
            {CATEGORY_LABELS[t.category]}
          </span>
          {t.skipReason && (
            <div className="tiny dim">{SKIP_LABELS[t.skipReason]}</div>
          )}
        </td>
        <td className="mono dim">{formatSize(t.size)}</td>
        <td>
          {/*
           * 跳过的文件不画进度条。
           *
           * 跳过没有「进度」这回事——它没传。画一条空的进度条加「0%」，
           * 用户看到的是「卡在 0% 不动」，会反复点、或者以为程序坏了。
           * 这一列改成显示跳过原因。
           */}
          {skipped ? (
            <span className="tiny dim">{t.skipReason ? SKIP_LABELS[t.skipReason] : '已跳过'}</span>
          ) : (
            <>
              <div className="bar" style={{ width: '100%' }}>
                <i style={{ width: `${Math.round(t.progress * 100)}%` }} />
              </div>
              <span className="tiny mono">
                {t.mode === 'multipart'
                  ? `分片 ${t.chunksDone}/${t.chunksTotal}`
                  : `${Math.round(t.progress * 100)}%`}
                {t.speed > 0 && <span className="dim"> · {formatSpeed(t.speed)}</span>}
              </span>
            </>
          )}
        </td>
        <td
          className="mono dim"
          title={t.md5Prefix && t.sha1Prefix ? `${t.md5Prefix}…\n${t.sha1Prefix}…` : undefined}
        >
          {t.md5Prefix ? `${t.md5Prefix}…` : '—'}
        </td>
        <td>
          <span className={`pill ${stateTone(t.state)}`}>{stateLabel(t.state)}</span>
        </td>
        <td>
          <div className="act-row">
            {/*
             * 失败和已取消都能重试。
             * 只在 failed 时显示「重试」的话，用户取消完就再也拉不回来了。
             */}
            {(t.state === 'failed' || t.state === 'canceled') && (
              <button
                className="btn tiny primary"
                onClick={() => window.topensync?.retryTransfer(t.id)}
              >
                重试
              </button>
            )}
            {t.state !== 'done' && t.state !== 'canceled' && t.state !== 'skipped' && (
              <button
                className="btn tiny ghost"
                onClick={() => window.topensync?.cancelTransfer(t.id)}
              >
                取消
              </button>
            )}
            <button
              className="btn tiny ghost"
              title="从队列移除这条记录"
              onClick={() => {
                const next = new Set(selected)
                next.add(t.id)
                setSelected(next)
              }}
            >
              <Icon name="trash" />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>传输队列</h1>
          <p className="sub">上传、下载与跳过记录，逐项重试。</p>
        </div>
      </div>

      {/* 类别筛选：上传 / 下载 / 跳过——先分清「在干什么」，再看状态 */}
      <div className="card toolbar">
        <div className="tb-label">
          <Icon name="diff" />
          传输类别
        </div>
        <div className="chips">
          {(['all', 'upload', 'download', 'skip'] as CategoryFilter[]).map((k) => (
            <button
              key={k}
              className={`chip${category === k ? ' active' : ''}`}
              onClick={() => setCategory(k)}
            >
              {CATEGORY_LABELS[k]} <i>{categoryCounts[k]}</i>
            </button>
          ))}
        </div>
      </div>

      <div className="card toolbar sub-toolbar">
        <div className="tb-label">
          <Icon name="clock" />
          任务状态
        </div>
        <div className="chips">
          {(
            ['all', 'uploading', 'queued', 'done', 'failed', 'canceled', 'skipped'] as StateFilter[]
          ).map((k) => (
            <button
              key={k}
              className={`chip${filter === k ? ' active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {STATE_LABELS[k]} <i>{stateCounts[k]}</i>
            </button>
          ))}
        </div>
        {/*
         * 清除筛选。
         *
         * 类别与状态是**叠加**的：选了「上传」再选「已完成」，
         * 结果是「已完成的那些上传」。想看全量得逐个点回去，
         * 这里给一个一键复位。
         */}
        {(filter !== 'all' || category !== 'all') && (
          <span
            className="lnk tb-link"
            onClick={() => {
              setFilter('all')
              setCategory('all')
            }}
          >
            清除筛选
          </span>
        )}
      </div>

      <div className="card table-card">
        <VirtualTable
          head={
            <tr>
              <th style={{ width: '4%' }}>
                {/*
                 * 全选框常驻表头。
                 *
                 * 以前它藏在 BatchBar 里，而 BatchBar 在「没选中任何项」时
                 * 整个不渲染——用户永远看不到全选框。
                 */}
                <label className="batch-check" title="全选 / 全不选当前筛选出的任务">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      // 半选状态（部分选中）用 indeterminate 表达
                      if (el) el.indeterminate = !allSelected && someSelected
                    }}
                    onChange={toggleSelectAll}
                  />
                </label>
              </th>
              <th style={{ width: '24%' }}>文件</th>
              <th style={{ width: '11%' }}>类别</th>
              <th style={{ width: '8%' }}>大小</th>
              <th style={{ width: '15%' }}>进度</th>
              <th style={{ width: '14%' }}>哈希</th>
              <th style={{ width: '9%' }}>状态</th>
              <th style={{ width: '15%' }}>操作</th>
            </tr>
          }
          rowCount={shown.length}
          renderRow={renderRow}
          maxHeight={520}
          empty={
            tasks.length === 0 ? '队列为空' : '没有符合当前筛选条件的任务'
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
            label: '移除记录',
            danger: true,
            confirmTitle: '从队列移除记录',
            confirmBody: '只移除队列中的任务记录，不会删除任何文件。',
            onRun: async (ids) => {
              await removeTasks(ids)
            }
          }
        ]}
      />
    </section>
  )
}

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: '全部',
  upload: '上传',
  download: '下载',
  skip: '跳过'
}

const SKIP_LABELS: Record<'local_duplicate' | 'remote_duplicate' | 'remote_size_match', string> = {
  local_duplicate: '本地未变',
  remote_duplicate: '远端已有',
  remote_size_match: '远端同名同大小'
}

const STATE_LABELS: Record<StateFilter, string> = {
  all: '全部',
  uploading: '进行中',
  queued: '等待',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过'
}

function matchesState(state: TransferTask['state'], filter: StateFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'uploading') return isActiveState(state)
  return state === filter
}

function categoryTone(category: TransferCategory): string {
  switch (category) {
    case 'upload':
      return 'accent'
    case 'download':
      return 'blue'
    case 'skip':
      return 'gray'
    default:
      return 'gray'
  }
}

function stateTone(state: TransferTask['state']): string {
  switch (state) {
    case 'uploading':
    case 'downloading':
    case 'hashing':
      return 'accent'
    case 'queued':
      return 'blue'
    case 'done':
      return 'green'
    case 'failed':
      return 'red'
    case 'skipped':
      return 'gray'
    default:
      return 'gray'
  }
}

function stateLabel(state: TransferTask['state']): string {
  switch (state) {
    case 'uploading':
      return '上传中'
    case 'downloading':
      return '下载中'
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
    case 'skipped':
      return '已跳过'
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
