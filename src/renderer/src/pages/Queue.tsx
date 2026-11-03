import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { BatchBar } from '../components/BatchBar'
import { ROW_HEIGHT, VirtualTable } from '../components/VirtualTable'
import {
  DetailRow,
  ExpandToggle,
  FileCell,
  RowDetail,
  detailHeight,
  splitPath
} from '../components/RowParts'
import type { SkipReason, TransferCategory, TransferTask } from '@shared/types'
import { explainError } from '@shared/errors'
import { useAppStore } from '../store'
import { formatSize, formatSpeed } from '../format'

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
 *
 * 表格布局：每行两行信息。
 * 第一行是**文件名**（用户最先要找的东西），第二行是所在目录；
 * 哈希、完整路径、错误信息放进「展开」里。
 * 以前全部挤在一行，列一窄文件名就只剩开头几个字，
 * 哈希也只剩前 8 位——等于最该看的两样都看不到。
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

/**
 * 大小列的文字。
 *
 * 还没探测到大小的时候（刚排队、正在算哈希）`size` 是 0，
 * 直接格式化会显示「0 B」——用户看到一整列 0 B 会以为
 * 这些文件都是空的、或者程序读不到大小。所以显式说明「待探测」。
 */
function sizeLabel(task: TransferTask): string {
  if (task.size > 0) return formatSize(task.size)
  if (task.state === 'queued' || task.state === 'hashing') return '待探测'
  return formatSize(task.size)
}

/** 展开区要显示的内容 */
function buildDetail(t: TransferTask): DetailRow[] {
  const rows: DetailRow[] = [
    {
      items: [
        { k: '本地路径', v: t.localPath || '—', mono: true, title: t.localPath },
        { k: '远端路径', v: t.remotePath || '—', mono: true, title: t.remotePath }
      ]
    },
    {
      items: [
        {
          k: 'MD5',
          v: t.md5 ?? (t.md5Prefix ? `${t.md5Prefix}…` : '—'),
          mono: true,
          title: t.md5 ?? undefined
        },
        {
          k: 'SHA1',
          v: t.sha1 ?? (t.sha1Prefix ? `${t.sha1Prefix}…` : '—'),
          mono: true,
          title: t.sha1 ?? undefined
        }
      ]
    }
  ]
  // 失败原因是最该被完整看到的内容，允许换行
  if (t.errorMsg) {
    const hint = explainError(t.errorMsg)
    rows.push({ items: [{ k: '失败原因', v: hint.brief }] })
    rows.push({ items: [{ k: '怎么处理', v: hint.advice }], tall: true })
    rows.push({ items: [{ k: '原始报错', v: t.errorMsg, mono: true, title: t.errorMsg }], tall: true })
  }
  return rows
}

export function Queue(): React.JSX.Element {
  const tasks = useAppStore((s) => s.tasks)
  const truncated = useAppStore((s) => s.stats?.tasksTruncated ?? false)
  const removeTasks = useAppStore((s) => s.removeTasks)
  const [filter, setFilter] = useState<StateFilter>('all')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  /*
   * 计数一次遍历算完。
   *
   * 以前是 11 次 `tasks.filter(...).length`（状态 7 次 + 类别 4 次）。
   * 六万条任务时，**每次渲染**都要扫 66 万次——实测 25ms，
   * 而这个页面每收到一批任务推送就会重渲染一次，
   * 于是「滚动时一顿一顿」「点筛选要等一下」全是它。
   *
   * 遍历一次的代价与筛选条件无关，只跟任务数有关。
   */
  const { stateCounts, categoryCounts, failGroups } = useMemo(() => {
    const sc = {
      all: tasks.length,
      uploading: 0,
      queued: 0,
      done: 0,
      failed: 0,
      canceled: 0,
      skipped: 0
    }
    const cc = { all: tasks.length, upload: 0, download: 0, skip: 0 }
    /*
     * 失败原因聚合。
     *
     * 「163 个失败」这个数字本身没有信息量——用户要知道的是
     * **它们是不是同一个原因**。同一病因归到一组，一眼就能看出
     * 「全是服务端拒绝连接」，也就知道该去修服务端而不是逐个重试。
     * 顺便在这里算掉，省一次全表遍历。
     */
    const fg = new Map<string, { count: number; advice: string }>()
    for (const t of tasks) {
      if (isActiveState(t.state)) sc.uploading++
      else if (t.state === 'queued') sc.queued++
      else if (t.state === 'done') sc.done++
      else if (t.state === 'failed') {
        sc.failed++
        const hint = explainError(t.errorMsg)
        const cur = fg.get(hint.brief)
        if (cur) cur.count++
        else fg.set(hint.brief, { count: 1, advice: hint.advice })
      } else if (t.state === 'canceled') sc.canceled++
      else if (t.state === 'skipped') sc.skipped++

      if (t.category === 'upload') cc.upload++
      else if (t.category === 'download') cc.download++
      else if (t.category === 'skip') cc.skip++
    }
    const groups = [...fg.entries()]
      .map(([brief, v]) => ({ brief, count: v.count, advice: v.advice }))
      .sort((a, b) => b.count - a.count)
    return { stateCounts: sc, categoryCounts: cc, failGroups: groups }
  }, [tasks])

  /*
   * 筛选结果先记忆化，再基于它派生 ID 列表：
   * 之前 shown 每次渲染都新建，useMemo 的依赖每次都变，
   * 缓存永远不命中，全选也就永远选不全。
   *
   * 排序（「全部」与「进行中」两个视图）：
   * 正在传输的排最上面，其中有速度的又排在没有速度的前面，
   * 其余（已完成/失败/等待等）保持倒序（最新在前）。
   *
   * 为什么要置顶「有速率」的：用户在几千条队列里最关心的是
   * 「现在正在传什么、传多快」——把它们沉在列表底部，
   * 每次都得往下翻几百条才看得到，等于让最有用的信息最难找。
   * 其它筛选（已完成/失败/等待）没有「进行中」这回事，保持纯倒序。
   */
  const shown = useMemo(() => {
    const filtered = tasks.filter(
      (t) =>
        (filter === 'all' || matchesState(t.state, filter)) &&
        (category === 'all' || t.category === category)
    )
    // 只有「全部」和「进行中」需要把在传的顶上去
    const prioritizeActive = filter === 'all' || filter === 'uploading'
    const list = filtered.reverse()
    if (!prioritizeActive) return list

    /*
     * 稳定排序：在传的（speed>0 优先，其次 active）排前面，
     * 其余保持原来的倒序相对顺序。
     */
    const rank = (t: TransferTask): number => {
      if (t.speed > 0) return 0 // 有速度的正在传——最顶
      if (isActiveState(t.state)) return 1 // 在传但还没测出速度（刚起步/哈希）
      return 2 // 其它
    }
    return list.sort((a, b) => rank(a) - rank(b))
  }, [tasks, filter, category])

  const shownIds = useMemo(() => shown.map((t) => t.id), [shown])

  /*
   * 展开行的额外高度。
   *
   * 只对**展开中的那几行**求值（通常 0~3 条），
   * 然后在 rowHeight 里 O(1) 查表——如果每行都现场算一遍，
   * 三千多条任务每次推送都要重建几千个详情对象，白白制造 GC 压力。
   */
  const byId = useMemo(() => {
    const map = new Map<string, TransferTask>()
    for (const t of shown) map.set(t.id, t)
    return map
  }, [shown])

  const expandedHeights = useMemo(() => {
    const map = new Map<string, number>()
    for (const id of expanded) {
      const t = byId.get(id)
      if (t) map.set(id, ROW_HEIGHT + detailHeight(buildDetail(t)))
    }
    return map
  }, [expanded, byId])

  const rowHeight = useCallback(
    (i: number) => expandedHeights.get(shown[i].id) ?? ROW_HEIGHT,
    [expandedHeights, shown]
  )

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

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderRow = (index: number): React.ReactNode => {
    const t = shown[index]
    if (!t) return null
    const skipped = isSkipped(t)
    const open = expanded.has(t.id)
    const { name, dir } = splitPath(t.localPath)
    const detail = open ? buildDetail(t) : null

    return (
      <React.Fragment key={t.id}>
        <tr className={`row-main${open ? ' expanded' : ''}`}>
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
            <ExpandToggle open={open} onToggle={() => toggleExpand(t.id)} />
          </td>
          <td>
            <FileCell
              icon={t.category === 'download' ? 'down' : 'files'}
              name={name}
              meta={dir || undefined}
              title={t.localPath}
            />
          </td>
          <td>
            <Cell2Pill
              tone={categoryTone(t.category)}
              label={CATEGORY_LABELS[t.category]}
            />
          </td>
          <td className="mono dim">{sizeLabel(t)}</td>
          <td>
            {skipped ? (
              <span className="tiny dim">
                {t.skipReason ? SKIP_LABELS[t.skipReason] : '已跳过'}
              </span>
            ) : t.state === 'failed' ? (
              /*
               * 失败行不画进度条，改显示原因。
               *
               * 失败的任务进度恒为 0%，画一条空条 + 「0%」只会让人以为
               * 「卡住没动」；而用户此刻唯一想知道的正是**为什么失败**。
               * 这一格正好把空出来的空间给它，整行扫一眼就能看出
               * 「163 个全是服务端拒绝连接」，不必逐条展开。
               */
              <span className="fail-brief" title={t.errorMsg ?? ''}>
                {explainError(t.errorMsg).brief}
              </span>
            ) : (
              <>
                <div className="bar" style={{ width: '100%' }}>
                  <i style={{ width: `${Math.round(t.progress * 100)}%` }} />
                </div>
                <span className="tiny mono">
                  {/*
                    * 只给百分比，不显示「分片 3/10」。
                    *
                    * 分片数是实现细节：用户关心的是「还要多久」，
                    * 而 3/10 和 30% 说的是同一件事，多一个数字只是噪声。
                    * 真正有用的附加信息是速度，所以留在后面。
                    */}
                  {Math.round(t.progress * 100)}%
                  {t.speed > 0 && <span className="dim"> · {formatSpeed(t.speed)}</span>}
                </span>
              </>
            )}
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
        {detail && <RowDetail rows={detail} colSpan={8} />}
      </React.Fragment>
    )
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>传输队列</h1>
          <p className="sub">
            上传、下载与跳过记录，逐项重试。本页只保留最近一批记录；更早的完整历史见「同步历史」页。
            {truncated && ' 记录过多，较早的已完成/已跳过条目已自动清理，完整明细见「同步历史」页。'}
          </p>
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

      {/*
       * 失败汇总条。
       *
       * 只在这一批里**有失败**时出现，不占常驻空间。
       * 顺序：病因 → 数量 → 处置。用户扫一眼就知道
       * 「这 163 条是同一件事造成的，该修的是服务端」，
       * 而不是把 163 条逐一点开看。
       */}
      {stateCounts.failed > 0 && (
        <div className="card fail-summary">
          <div className="fs-head">
            <Icon name="alert" />
            <b>{stateCounts.failed} 项失败</b>
            {failGroups.length > 1 && <span className="dim">共 {failGroups.length} 类原因</span>}
            <span className="fs-spacer" />
            <button
              className="btn tiny primary"
              onClick={() => {
                for (const t of tasks) {
                  if (t.state === 'failed') window.topensync?.retryTransfer(t.id)
                }
              }}
            >
              重试全部失败
            </button>
          </div>
          <ul className="fs-list">
            {failGroups.slice(0, 4).map((g) => (
              <li key={g.brief}>
                <span className="fs-count">{g.count}</span>
                <span className="fs-brief">{g.brief}</span>
                <span className="fs-advice">{g.advice}</span>
              </li>
            ))}
            {failGroups.length > 4 && (
              <li className="dim">还有 {failGroups.length - 4} 类原因，展开任意一行可看完整报错</li>
            )}
          </ul>
        </div>
      )}

      <div className="card table-card">
        <VirtualTable
          head={
            <tr>
              <th style={{ width: 38 }}>
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
              <th style={{ width: 30 }} />
              <th>文件</th>
              <th style={{ width: 78 }}>类别</th>
              <th style={{ width: 96 }}>大小</th>
              <th style={{ width: 160 }}>进度</th>
              <th style={{ width: 92 }}>状态</th>
              <th style={{ width: 120 }}>操作</th>
            </tr>
          }
          rowCount={shown.length}
          rowHeight={rowHeight}
          renderRow={renderRow}
          maxHeight={560}
          empty={tasks.length === 0 ? '队列为空' : '没有符合当前筛选条件的任务'}
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
            icon: 'trash',
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

/** 类别列：一行标签，超过宽度时自动省略 */
function Cell2Pill({ tone, label }: { tone: string; label: string }): React.JSX.Element {
  return (
    <div className="cell2">
      <div className="cell2-l1">
        <span className={`pill ${tone}`}>{label}</span>
      </div>
    </div>
  )
}

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: '全部',
  upload: '上传',
  download: '下载',
  skip: '跳过'
}

const SKIP_LABELS: Record<SkipReason, string> = {
  local_duplicate: '本地未变',
  remote_duplicate: '远端已有',
  remote_size_match: '远端同名同大小',
  file_gone: '本地文件已不存在'
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
