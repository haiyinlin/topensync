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
import type { PageKey } from '../App'
import type { DeepVerifyResult, DiffEntry, DiffKind, DiffResolution, FileEntry } from '@shared/types'
import { formatSize } from '../format'
import { useAppStore } from '../store'

/**
 * 文件清单。
 *
 * 两个维度必须分开呈现：
 * - 「同步状态」：这个本地文件传得怎么样
 * - 「对账差异」：两侧是否一致
 * 一个文件可以同时是「已同步」和「远端缺失」——绿色不能掩盖琥珀色。
 *
 * 第三维是「可信度」：这条「已同步」的结论有多可靠。
 * 认领（同名同大小）只比了名称与大小、没读内容，
 * 那是**弱认定**——必须能被单独筛出来，用户才知道哪些文件本地那份可能没备份。
 *
 * 删除语义：**删本地文件**，远端按删除策略跟进（回收站 / 直接删 / 不动）。
 * 这跟「在资源管理器里删文件」是同一条路径——所以下一轮扫描不会把它当新文件重传。
 */
type StatusFilter = 'all' | 'synced' | 'pending' | 'error'
type DiffFilter = DiffKind | 'all' | 'none'
type VerifyFilter = 'all' | 'hash' | 'reconciled' | 'size' | 'unknown'

/**
 * 把远端绝对路径拆成「根前缀 + 相对路径」。
 *
 * 为什么要在界面上拆开：
 *
 * 这一页同时出现两个「路径」——本地路径（相对同步目录）和远端路径。
 * 远端路径原本显示成 `/qh/topensync-demo/团建--20220805/DSCF7226.JPG`：
 * ①绝对路径太长，在窄列里换行成两行；
 * ②跟页面上方「远端独有文件」那张表的路径**长得一模一样**，
 *   两张表又有各自的同名表头，于是用户根本分不清哪一列是本地的、哪一列是远端的。
 *
 * 拆开之后：根前缀画成灰色（它是"基准"，一眼知道相对谁），
 * 相对路径画成亮色（是"内容"）。两列都变成相对路径，就能横向对照了。
 *
 * 不在远端根之下时（跨根、异常）就原样显示，不硬凑前缀。
 */
function splitRemote(remoteRoot: string, remotePath: string): { root: string; rel: string } {
  const norm = remotePath.startsWith('/') ? remotePath : `/${remotePath}`
  const root = remoteRoot.replace(/\/+$/, '')
  if (!root || root === '/') return { root: '', rel: norm }
  if (norm === root) return { root, rel: '/' }
  if (norm.startsWith(`${root}/`)) return { root, rel: norm.slice(root.length) }
  return { root: '', rel: norm }
}

/**
 * 本地文件行的展开详情。
 *
 * 表格里只放「扫一眼就要判断」的列；这里放需要**核对**的东西：
 * 完整路径（含远端实际落点）与完整双哈希。
 * 以前哈希列只截到 8 位，想比对得自己去数据库里翻——那等于没有。
 */
function localDetail(f: FileEntry, remoteRoot: string): DetailRow[] {
  const rows: DetailRow[] = [
    {
      items: [
        { k: '本地路径', v: f.localPath || '—', mono: true, title: f.localPath },
        {
          k: '远端路径',
          v: f.remotePath ?? '—',
          mono: true,
          title: f.remotePath ?? undefined
        }
      ]
    },
    {
      items: [
        { k: 'MD5', v: f.md5 ?? '—', mono: true, title: f.md5 ?? undefined },
        { k: 'SHA1', v: f.sha1 ?? '—', mono: true, title: f.sha1 ?? undefined }
      ]
    },
    {
      items: [
        { k: '修改时间', v: formatTime(f.mtimeMs), mono: true },
        {
          k: '远端大小',
          v: f.remoteSize !== null ? formatSize(f.remoteSize) : '—',
          mono: true
        }
      ]
    }
  ]
  if (f.remotePath) {
    const { root, rel } = splitRemote(remoteRoot, f.remotePath)
    if (rel.replace(/^\//, '') !== f.localPath) {
      rows.push({
        items: [
          { k: '远端根', v: root || '/', mono: true },
          { k: '远端相对路径', v: rel, mono: true, title: rel }
        ]
      })
    }
  }
  /*
   * 「已同步 + 未校验」这个组合最容易让人困惑，展开区必须直说清楚：
   * 状态是**本地**的判断（文件没动过），不是「已核对过远端」。
   *
   * 这里**不能标 tall**：tall 行按「最多三行」预留 66px，而这行文字
   * 通常一行就完了，底下会空出四十多像素——用户看到的就是
   * 「展开后底部一大块空白」。要写长就换行写清楚，别用预留高度去凑。
   */
  rows.push({
    items: [
      {
        k: '可信度',
        v: verifyText(f.verifyLevel),
        title: verifyText(f.verifyLevel)
      }
    ]
  })
  return rows
}

/** 远端独有文件行的展开详情 */
function remoteDetail(d: DiffEntry): DetailRow[] {
  return [
    {
      items: [
        { k: '远端路径', v: d.remotePath, mono: true, title: d.remotePath },
        { k: '本地路径', v: d.localPath ?? '—（本地没有这个文件）', mono: true }
      ]
    },
    {
      items: [
        { k: '远端大小', v: d.remoteSize !== null ? formatSize(d.remoteSize) : '—', mono: true },
        { k: '本地大小', v: d.localSize !== null ? formatSize(d.localSize) : '—', mono: true }
      ]
    }
  ]
}

export function ManifestPage({ onNavigate }: { onNavigate: (k: PageKey) => void }): React.JSX.Element {
  const files = useAppStore((s) => s.files)
  const filesLimit = useAppStore((s) => s.filesLimit)
  /** 还有没加载出来的行（分页未到底） */
  const truncated = filesLimit > 0 && files.length >= filesLimit
  const loadMoreFiles = useAppStore((s) => s.loadMoreFiles)
  const diffs = useAppStore((s) => s.diffs)
  const config = useAppStore((s) => s.config)
  const deleteLocalFiles = useAppStore((s) => s.deleteLocalFiles)
  const deleteRemoteFiles = useAppStore((s) => s.deleteRemoteFiles)
  const verifyRemoteFiles = useAppStore((s) => s.verifyRemoteFiles)
  const refreshFiles = useAppStore((s) => s.refreshFiles)
  const refreshDiffs = useAppStore((s) => s.refreshDiffs)

  /*
   * 每次进入清单页都重新拉一次。
   *
   * 清单状态是由主进程推进的（上传完成、文件被删、对账改写远端路径），
   * 渲染进程只靠事件推送来同步——漏掉任何一次推送，
   * 页面就会一直停在旧数据上，用户看着像「程序没反应」。
   * 进页面刷一次是最省事的兜底。
   */
  React.useEffect(() => {
    void refreshFiles()
  }, [refreshFiles])

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [diffFilter, setDiffFilter] = useState<DiffFilter>('all')
  const [verifyFilter, setVerifyFilter] = useState<VerifyFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [verifyResult, setVerifyResult] = useState<DeepVerifyResult | null>(null)

  /*
   * 换筛选条件就清空勾选。
   *
   * 不清的话会出这种事故：在「仅大小」下筛出 3 个文件 → 全选 →
   * 切到「已同步」（几千行）→ 点表头全选 → 删除。
   * 此时勾选集合里同时有那 3 个弱认定文件与几千个已同步文件，
   * 而**屏幕上只看得到后者**——一删就把看不见的文件也删了。
   *
   * 清单页是数据删除的入口，宁可让用户重新勾一次，
   * 也不能让「我看得见的这些」与「实际会被删的那些」不一致。
   */
  const firstFilterRun = React.useRef(true)
  React.useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false
      return
    }
    setSelected(new Set())
  }, [statusFilter, diffFilter, verifyFilter])

  // 本地路径 → 对账差异类型。一个文件可能同时「已同步」且「远端缺失」，
  // 两个维度必须分开呈现，绿色不能掩盖琥珀色。
  const diffByPath = useMemo(() => {
    const map = new Map<string, DiffKind>()
    for (const d of diffs) {
      if (d.localPath) map.set(d.localPath, d.kind)
    }
    return map
  }, [diffs])

  /**
   * 「远端有、本地无」的条目。
   *
   * 这类文件在本地根本不存在，files 表里没有它们——
   * 只按 files 表渲染的话，用户在对账里看到一堆「仅远端存在」，
   * 翻到清单页却一条都找不到，两边对不上。
   *
   * 所以清单页把它们**单独列一段**：路径、大小、发现时间，
   * 以及一个「下载到本地」的按钮。
   */
  const remoteOnly = useMemo(
    () => diffs.filter((d) => d.kind === 'remote_only'),
    [diffs]
  )

  const diffCounts = useMemo(() => {
    const map = new Map<DiffKind, number>()
    for (const d of diffs) map.set(d.kind, (map.get(d.kind) ?? 0) + 1)
    return map
  }, [diffs])

  /** 各可信度的文件数；让筛选按钮上的数字能说明「那边有多少东西」 */
  const verifyCounts = useMemo(() => {
    const map = new Map<VerifyFilter, number>([
      ['all', files.length],
      ['hash', 0],
      ['reconciled', 0],
      ['size', 0],
      ['unknown', 0]
    ])
    for (const f of files) {
      const k: VerifyFilter = f.verifyLevel ?? 'unknown'
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    return map
  }, [files])

  const shown = useMemo(
    () =>
      files.filter((f) => {
        if (statusFilter !== 'all' && f.state !== statusFilter) return false
        const kind = diffByPath.get(f.localPath)
        if (diffFilter === 'none') {
          if (kind) return false
        } else if (diffFilter !== 'all' && kind !== diffFilter) {
          return false
        }
        // 可信度筛选：只看弱认定的文件时，这是唯一能找出备份缺口的办法
        if (verifyFilter === 'unknown') {
          if (f.verifyLevel !== null) return false
        } else if (verifyFilter !== 'all' && f.verifyLevel !== verifyFilter) {
          return false
        }
        return true
      }),
    [files, statusFilter, diffFilter, verifyFilter, diffByPath]
  )

  /**
   * 勾选集合里的路径（本地文件删除用）。
   *
   * 勾选集合里存的是**带前缀的 ID**（`local:…` / `remote:…`），
   * 不是裸路径。为什么：本地相对路径（`docs/a.txt`）与远端绝对路径
   * （`/quark-backup/docs/a.txt`）是两种命名空间，混在一个 Set 里，
   * 一旦某个远端路径恰好与本地路径同形，勾选状态就会串台——
   * 本地表的行会被远端表的勾选误勾上，然后被「删除本地文件」批量删掉。
   * 加前缀后两种 ID 永不相撞。
   */
  /**
   * 当前**可见**（筛选后）行的本地路径集合。
   *
   * 用它来收窄勾选集合与删除目标，而不是 `files`（全部已加载行）。
   * 差别就是「删我看到的这些」还是「删我曾经勾过的那些」——
   * 后者在切换筛选后会把屏幕上看不见的文件一起删掉。
   *
   * 同时它替代了原来的 `files.some(...)` 写法：后者是
   * 「对每个已选项扫一遍整个清单」，选中一万个文件时是平方级。
   */
  const localPathSet = useMemo(() => new Set(shown.map((f) => f.localPath)), [shown])

  const selectedPaths = useMemo(
    () =>
      [...selected]
        .filter((id) => id.startsWith(LOCAL_ID_PREFIX))
        .map((id) => id.slice(LOCAL_ID_PREFIX.length))
        .filter((p) => localPathSet.has(p)),
    [selected, localPathSet]
  )

  /** 远端根目录：用来把远端绝对路径拆成「根 + 相对路径」 */
  const remoteRoot = config?.remoteRoot || '/'

  /*
   * 全选（表头常驻）。
   *
   * 两张表各管各的命名空间：本地文件用 `local:` 前缀，
   * 远端独有文件用 `remote:` 前缀——两者绝不能混，
   * 否则「全选远端」会把本地文件也勾上，一删就是一整批本地文件。
   */
  const localIds = useMemo(
    () => shown.map((f) => `${LOCAL_ID_PREFIX}${f.localPath}`),
    [shown]
  )
  const remoteIds = useMemo(
    () => remoteOnly.map((d) => `${REMOTE_ID_PREFIX}${d.remotePath}`),
    [remoteOnly]
  )

  /** 当前可见的全部候选 id（本地 + 远端独有） */
  const visibleIds = useMemo(() => [...localIds, ...remoteIds], [localIds, remoteIds])

  /**
   * 收窄到「可见」的勾选集合。
   *
   * 勾选集合里可能残留已不在当前筛选里的 id（后台刷新让某行换了状态、
   * 或刚被删掉）。批量操作的按钮文案与实际目标必须一致，
   * 所以这里先求交再交给批量条。
   */
  const visibleSelected = useMemo(() => {
    const allowed = new Set(visibleIds)
    const out = new Set<string>()
    for (const id of selected) if (allowed.has(id)) out.add(id)
    return out
  }, [selected, visibleIds])

  /* ── 展开详情 ──────────────────────────────────────────
   *
   * 表格里只留最关键的几列（文件名、大小、状态、差异），
   * 完整路径、双哈希这些「要核对时才看」的信息放进展开区。
   * 否则哈希列永远只有 8 位、远端路径永远只剩开头——想问什么都要悬停。
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* id → 行数据的索引：展开高度要按 id 反查（行号会随筛选变化） */
  const localById = useMemo(() => {
    const m = new Map<string, FileEntry>()
    for (const f of shown) m.set(`${LOCAL_ID_PREFIX}${f.localPath}`, f)
    return m
  }, [shown])

  const remoteById = useMemo(() => {
    const m = new Map<string, DiffEntry>()
    for (const d of remoteOnly) m.set(`${REMOTE_ID_PREFIX}${d.remotePath}`, d)
    return m
  }, [remoteOnly])

  /* 只对展开中的那几行算高度，rowHeight 里 O(1) 查表 */
  const expandedHeights = useMemo(() => {
    const m = new Map<string, number>()
    for (const id of expanded) {
      const lf = localById.get(id)
      if (lf) {
        m.set(id, ROW_HEIGHT + detailHeight(localDetail(lf, remoteRoot)))
        continue
      }
      const rd = remoteById.get(id)
      if (rd) m.set(id, ROW_HEIGHT + detailHeight(remoteDetail(rd)))
    }
    return m
  }, [expanded, localById, remoteById, remoteRoot])

  const localRowHeight = useCallback(
    (i: number) => expandedHeights.get(`${LOCAL_ID_PREFIX}${shown[i].localPath}`) ?? ROW_HEIGHT,
    [expandedHeights, shown]
  )

  const remoteRowHeight = useCallback(
    (i: number) => expandedHeights.get(`${REMOTE_ID_PREFIX}${remoteOnly[i].remotePath}`) ?? ROW_HEIGHT,
    [expandedHeights, remoteOnly]
  )

  /*
   * 全选/半选状态。
   *
   * 必须记忆化：六万条时 `every` + `some` 各扫一遍，
   * 每次渲染（含滚动、悬停、任何 setState）都要重算两遍，白白卡帧。
   */
  const { allLocalSelected, someLocalSelected } = useMemo(() => {
    let all = localIds.length > 0
    let some = false
    for (const id of localIds) {
      if (selected.has(id)) some = true
      else all = false
      // 两个结论都定了就不用再扫
      if (some && !all) break
    }
    return { allLocalSelected: all, someLocalSelected: some }
  }, [localIds, selected])

  const { allRemoteSelected, someRemoteSelected } = useMemo(() => {
    let all = remoteIds.length > 0
    let some = false
    for (const id of remoteIds) {
      if (selected.has(id)) some = true
      else all = false
      if (some && !all) break
    }
    return { allRemoteSelected: all, someRemoteSelected: some }
  }, [remoteIds, selected])

  const toggleSelectAllLocal = (): void => {
    const next = new Set(selected)
    if (allLocalSelected) {
      for (const id of localIds) next.delete(id)
    } else {
      for (const id of localIds) next.add(id)
    }
    setSelected(next)
  }

  const toggleSelectAllRemote = (): void => {
    const next = new Set(selected)
    if (allRemoteSelected) {
      for (const id of remoteIds) next.delete(id)
    } else {
      for (const id of remoteIds) next.add(id)
    }
    setSelected(next)
  }

  /** 任一维度不是默认值 → 处于筛选状态 */
  const filtersActive =
    statusFilter !== 'all' || diffFilter !== 'all' || verifyFilter !== 'all'

  const resetFilters = (): void => {
    setStatusFilter('all')
    setDiffFilter('all')
    setVerifyFilter('all')
  }

  /**
   * 处置一条「只在远端的文件」差异。
   *
   * 等主进程真的处理完再刷新列表——否则那一行会留在表里，
   * 用户以为操作没生效，反复点。
   */
  const resolveRemoteDiff = (diffId: number, resolution: DiffResolution): void => {
    void window.topensync
      ?.resolveDiff(diffId, resolution)
      .then(() => refreshDiffs())
      .catch(() => refreshDiffs())
  }

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
          {(['all', 'synced', 'pending', 'error'] as StatusFilter[]).map((k) => (
            <button
              key={k}
              className={`chip${statusFilter === k ? ' active' : ''}`}
              onClick={() => setStatusFilter(k)}
            >
              {STATUS_LABELS[k]} <i>{files.filter((f) => k === 'all' || f.state === k).length}</i>
            </button>
          ))}
        </div>
        {/*
         * 清除筛选。
         *
         * 三个维度是**叠加**的：点了「仅大小」再点状态条的「全部」，
         * 结果仍然是那 1 条弱认定文件——用户想看全量，
         * 得先记住自己点过哪几个筛选项，再逐个点回去。
         * 这里给一个一键复位。
         */}
        {filtersActive && (
          <span className="lnk tb-link" onClick={resetFilters}>
            清除筛选
          </span>
        )}
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
              title={DIFF_DESCRIPTIONS[kind]}
            >
              {label} <i>{diffCounts.get(kind) ?? 0}</i>
            </button>
          ))}
        </div>
        <span className="lnk tb-link" onClick={() => onNavigate('reconcile')}>
          前往对账页 →
        </span>
      </div>

      {/* 可信度维度：把「弱认定」的文件单独拎出来 */}
      <div className="card toolbar sub-toolbar">
        <div className="tb-label">
          <Icon name="shield" />
          可信度
        </div>
        <div className="chips">
          {(['all', 'hash', 'reconciled', 'size', 'unknown'] as VerifyFilter[]).map((k) => (
            <button
              key={k}
              className={`chip${verifyFilter === k ? ' active' : ''}`}
              onClick={() => setVerifyFilter(k)}
              title={VERIFY_FILTER_HINTS[k]}
            >
              {VERIFY_FILTER_LABELS[k]} <i>{verifyCounts.get(k) ?? 0}</i>
            </button>
          ))}
        </div>
        <span className="tb-hint">
          「仅大小」能确认远端有这份文件、大小也对，但没读过内容；「未校验」连远端都没核对过（对账跑一趟即可升级）
        </span>
      </div>

      {/*
        * 远端有、本地无。
        *
        * 这块与下面的主表**必须一眼分得开**：
        * 两张表都带路径列，如果表头都叫「路径」、格式都是绝对路径，
        * 用户会把上表的行当成主表的行看（"这个文件怎么本地没有？"）。
        * 因此：①卡片有独立的边框色与标题；②列名不叫「路径」，
        * 叫「远端文件」；③路径拆成灰色根前缀 + 亮色相对路径。
        */}
      {remoteOnly.length > 0 && (
        <div className="card table-card card-remote">
          <div className="card-head">
            <h2>
              <Icon name="cloud-check" />
              远端独有文件
            </h2>
            <span className="muted">
              只存在于远端、本地还没有的文件，共 {remoteOnly.length} 个 —— 路径相对远端根目录，可下载到本地或忽略
            </span>
          </div>
          <VirtualTable
            head={
              <tr>
                <th style={{ width: 38 }}>
                  <label className="batch-check" title="全选 / 全不选远端独有文件">
                    <input
                      type="checkbox"
                      checked={allRemoteSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allRemoteSelected && someRemoteSelected
                      }}
                      onChange={toggleSelectAllRemote}
                    />
                  </label>
                </th>
                <th style={{ width: 30 }} />
                <th>远端文件（相对远端根）</th>
                <th style={{ width: 96 }}>大小</th>
                <th style={{ width: 100 }}>发现时间</th>
                <th style={{ width: 186 }}>操作</th>
              </tr>
            }
            rowCount={remoteOnly.length}
            rowHeight={remoteRowHeight}
            renderRow={(index) => {
              const d = remoteOnly[index]
              if (!d) return null
              const rid = `${REMOTE_ID_PREFIX}${d.remotePath}`
              const open = expanded.has(rid)
              const { name, dir } = splitPath(splitRemote(remoteRoot, d.remotePath).rel)
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
                      <FileCell
                        icon="cloud-check"
                        name={name}
                        meta={dir || undefined}
                        title={d.remotePath}
                      />
                    </td>
                    <td className="mono dim">
                      {d.remoteSize !== null ? formatSize(d.remoteSize) : '—'}
                    </td>
                    <td>
                      <Cell2
                        line1={dateOnly(d.detectedAt)}
                        line2={<span className="mono">{timeOnly(d.detectedAt)}</span>}
                      />
                    </td>
                    <td>
                      <div className="act-row">
                        <button
                          className="btn tiny primary"
                          onClick={() => resolveRemoteDiff(d.id, 'pulled')}
                        >
                          <Icon name="down" />
                          下载
                        </button>
                        <button
                          className="btn tiny ghost"
                          onClick={() => resolveRemoteDiff(d.id, 'ignored')}
                        >
                          忽略
                        </button>
                      </div>
                    </td>
                  </tr>
                  {open && <RowDetail rows={remoteDetail(d)} colSpan={6} />}
                </React.Fragment>
              )
            }}
            maxHeight={300}
          />
        </div>
      )}

      {/*
        * 主表：本地受管文件。
        *
        * 表头刻意**不叫「路径」**：
        * 这一页上方还有一张「远端独有文件」表，若这里也叫「路径」，
        * 用户会分不清哪一列属于哪一张表。
        * 「本地文件」对「远端位置」——名字本身就点明了各自相对谁。
        */}
      <div className="card table-card card-local">
        <div className="card-head">
          <h2>
            <Icon name="files" />
            本地文件
          </h2>
          <span className="muted">
            {/*
             * 分页加载时不能说「共 N 个」——那个数只是**已加载**的行数，
             * 用户会以为清单里就这么多文件。说清是「当前显示」，
             * 并指出还能继续加载。
             */}
            {truncated
              ? `当前显示 ${shown.length} 条（已加载 ${files.length} 条，还有更多）`
              : `同步目录内受管的文件，共 ${shown.length} 个`}
            {' —— '}路径均相对本地同步目录，已删除的文件不再列出
          </span>
        </div>
        <VirtualTable
          head={
            <tr>
              <th style={{ width: 38 }}>
                <label className="batch-check" title="全选 / 全不选当前筛选出的本地文件">
                    <input
                      type="checkbox"
                      checked={allLocalSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allLocalSelected && someLocalSelected
                      }}
                      onChange={toggleSelectAllLocal}
                    />
                  </label>
                </th>
                <th style={{ width: 30 }} />
                <th>本地文件</th>
                <th style={{ width: 96 }}>大小</th>
                <th style={{ width: 88 }}>同步状态</th>
                <th style={{ width: 88 }}>可信度</th>
                <th style={{ width: 96 }}>对账差异</th>
                <th style={{ width: 100 }}>修改时间</th>
                <th style={{ width: 64 }} />
              </tr>
            }
            rowCount={shown.length}
            rowHeight={localRowHeight}
            renderRow={(index) => {
              const f = shown[index]
              if (!f) return null
              const lid = `${LOCAL_ID_PREFIX}${f.localPath}`
              const open = expanded.has(lid)
              const { name, dir } = splitPath(f.localPath)
              /*
               * 远端保存位置与本地路径不一致时才提醒。
               *
               * 以前远端路径独占一列，几百行全都和本地一样——那列的
               * 唯一作用就是让人反复确认「哦，还是一样」。改成默认不占位，
               * 只在真的不一样时给一个琥珀色标记，完整路径去展开区看。
               */
              const remoteRel = f.remotePath ? splitRemote(remoteRoot, f.remotePath).rel : null
              const pathDiffers = remoteRel !== null && remoteRel.replace(/^\//, '') !== f.localPath
              return (
                <React.Fragment key={f.id}>
                  <tr className={`row-main${open ? ' expanded' : ''}`}>
                    <td>
                      <label className="batch-check">
                        <input
                          type="checkbox"
                          checked={selected.has(lid)}
                          onChange={() => {
                            const next = new Set(selected)
                            if (next.has(lid)) next.delete(lid)
                            else next.add(lid)
                            setSelected(next)
                          }}
                        />
                      </label>
                    </td>
                    <td>
                      <ExpandToggle open={open} onToggle={() => toggleExpand(lid)} />
                    </td>
                    <td>
                      <FileCell
                        name={name}
                        meta={dir || undefined}
                        title={f.localPath}
                        badge={
                          pathDiffers ? (
                            <span className="mini-flag" title={`远端位置不同：${f.remotePath}`}>
                              远端另存
                            </span>
                          ) : null
                        }
                      />
                    </td>
                    <td className="mono dim">
                      {f.localSize > 0 ? formatSize(f.localSize) : '待探测'}
                    </td>
                    <td>
                      <span className={`pill ${stateTone(f.state)}`}>{STATE_LABELS[f.state] ?? f.state}</span>
                    </td>
                    <td>
                      {f.verifyLevel ? (
                        <span
                          className={`pill ${verifyTone(f.verifyLevel)}`}
                          title={VERIFY_HINTS[f.verifyLevel]}
                        >
                          {VERIFY_LABELS[f.verifyLevel]}
                        </span>
                      ) : (
                        /*
                         * 没有可信度标记 ≠ 没同步。
                         *
                         * 绝大多数是「本地大小与修改时间和上次成功同步时一致」
                         * （L1 快筛）——本地根本没动过，就直接沿用了上次的结论，
                         * 全程没碰远端。所以它是「已同步」，但依据只是**本地没变**。
                         * 以前这里画一个「—」，用户看到「已同步 + —」只会更困惑。
                         */
                        <span
                          className="pill gray"
                          title={VERIFY_HINTS_UNKNOWN}
                        >
                          未校验
                        </span>
                      )}
                    </td>
                    <td>
                      {(() => {
                        const kind = diffByPath.get(f.localPath)
                        if (!kind) return <span className="pill gray">—</span>
                        return (
                          <span className={`pill ${diffTone(kind)}`}>
                            {DIFF_KIND_LABELS[kind]}
                          </span>
                        )
                      })()}
                    </td>
                    {/*
                      * 时间拆两行：上行日期、下行时分。
                      * 一行放 16 个字符需要 144px 宽，这一列只有 100px——
                      * 之前就是在这里被截成「2019-10-02 …」，连具体时刻都看不到。
                      */}
                    <td>
                      <Cell2
                        line1={dateOnly(f.mtimeMs)}
                        line2={<span className="mono">{timeOnly(f.mtimeMs)}</span>}
                      />
                    </td>
                    <td>
                      <button
                        className="btn tiny ghost"
                        title="删除本地文件"
                        onClick={() => {
                          const next = new Set(selected)
                          next.add(lid)
                          setSelected(next)
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                  {open && <RowDetail rows={localDetail(f, remoteRoot)} colSpan={9} />}
                </React.Fragment>
              )
            }}
            maxHeight={560}
            empty={
              files.length === 0
                ? '清单为空。开始同步后这里会列出所有受管文件。'
                : `当前筛选条件下没有文件（共 ${files.length} 个）。放宽筛选条件试试。`
            }
          />
      </div>

      {/*
       * 加载更多。
       *
       * 六万个文件一次性塞进 IPC 返回值，JSON 序列化要一两秒，
       * 渲染进程主线程直接卡住。所以分页加载：
       * 先给五千条，虚拟滚动让这五千条渲染毫无压力，
       * 用户需要更多时再点一次。
       *
       * 判断「还有更多」用「已加载数正好等于页大小」——
       * 清单里到底有多少条，概览页的统计才是准数（要 COUNT 全表，
       * 每次拉清单都 COUNT 一次反而更慢）。
       */}
      {filesLimit > 0 && files.length >= filesLimit && (
        <div className="card toolbar" style={{ justifyContent: 'center' }}>
          <button className="btn ghost" onClick={() => void loadMoreFiles()}>
            加载更多（已显示 {files.length} 条）
          </button>
        </div>
      )}

      {/*
       * 候选全集 = 当前筛选后可见的本地文件 + 全部远端独有文件。
       *
       * 勾选集合也按这个全集收窄后传下去：
       * 界面上的「已选 N 项」和实际会被操作的必须一致。
       * 否则会出现「只看得见 3 行，提示却说选了 5000 项」——
       * 用户点删除，删掉的是自己根本看不见的文件。
       */}
      <BatchBar
        allIds={visibleIds}
        selected={visibleSelected}
        onSelectionChange={setSelected}
        hint={`已选 ${visibleSelected.size} 项`}
        actions={[
          {
            label: '删除本地文件',
            danger: true,
            icon: 'trash',
            confirmTitle: '删除本地文件',
            confirmBody: selectedPaths.length
              ? `将删除 ${selectedPaths.length} 个本地文件，远端副本按删除策略处理（通常是移入回收站）。`
              : '未选中本地文件。',
            onRun: async (ids) => {
              const paths = ids
                .filter((id) => id.startsWith(LOCAL_ID_PREFIX))
                .map((id) => id.slice(LOCAL_ID_PREFIX.length))
                // 用 Set 而不是 files.some(...)：后者对每个选中项
                // 都要扫一遍整个清单，六万条时是平方级开销
                .filter((p) => localPathSet.has(p))
              if (paths.length === 0) return
              await deleteLocalFiles(paths)
            }
          },
          {
            label: '删除远端文件',
            danger: true,
            icon: 'trash',
            confirmTitle: '删除远端文件',
            confirmBody: '将把选中的远端文件移入远端回收站，并关闭对应差异。',
            onRun: async (ids) => {
              // 用传进来的 ids（本次实际选中的）而不是 selectedRemotePaths，
              // 这样用户在确认弹窗期间改了勾选也不会删错。
              //
              // ids 先转成 Set：原来用 `ids.includes(...)` 是「对每个远端项
              // 扫一遍选中数组」，选中几千个时就是平方级。
              const idSet = new Set(ids)
              const targets = remoteOnly
                .filter((d) => idSet.has(`${REMOTE_ID_PREFIX}${d.remotePath}`))
                .map((d) => ({ remotePath: d.remotePath, diffId: d.id }))
              if (targets.length === 0) return
              await deleteRemoteFiles(targets)
            }
          },
          {
            /*
             * 深度校验：给「仅大小」弱认定的记录补做内容确认。
             *
             * 这是认领那条路的**唯一补口**——认领只比名称与大小，
             * 「同名同大小、内容其实不同」会被当成已同步，本地那份等于没备份。
             */
            label: '深度校验',
            danger: false,
            icon: 'shield',
            confirmTitle: '深度校验',
            confirmBody:
              '把选中的远端文件下载回来重算哈希，与本地比对。' +
              '一致则升级为「哈希确认」；不一致则按「本地为准」重新上传。' +
              '会消耗与文件大小成正等的下行流量，超过体积上限的文件会被跳过。',
            onRun: async (ids) => {
              const paths = ids
                .filter((id) => id.startsWith(LOCAL_ID_PREFIX))
                .map((id) => id.slice(LOCAL_ID_PREFIX.length))
                // 用 Set 而不是 files.some(...)：后者对每个选中项
                // 都要扫一遍整个清单，六万条时是平方级开销
                .filter((p) => localPathSet.has(p))
              if (paths.length === 0) return
              setVerifyResult(await verifyRemoteFiles(paths))
            }
          }
        ]}
      />

      {verifyResult && (
        <p className="warn-note">
          <Icon name="shield" />
          深度校验完成：校验 {verifyResult.checked} 个，一致 {verifyResult.matched}，
          不一致 {verifyResult.mismatched}，跳过 {verifyResult.skipped}
          {verifyResult.failed > 0 ? `，失败 ${verifyResult.failed}` : ''}。
          {verifyResult.details
            .filter((d) => !d.ok)
            .slice(0, 3)
            .map((d) => `${d.localPath}（${d.detail}）`)
            .join('；')}
        </p>
      )}
    </section>
  )
}

/**
 * 勾选 ID 的命名空间前缀。
 *
 * 清单页同时有两张表：本地文件（相对路径）与只在远端的文件（绝对路径）。
 * 两种 ID 必须能区分开，否则同形的路径会串台。
 */
const LOCAL_ID_PREFIX = 'local:'
const REMOTE_ID_PREFIX = 'remote:'

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: '全部',
  synced: '已同步',
  pending: '待处理',
  error: '出错'
}

/**
 * 差异标签。
 *
 * 措辞原则：**说清「哪边有、哪边没有」**，而不是用行话。
 * 「仅远端存在」这类说法读者要自己反推一次才知道什么意思，
 * 改成「远端缺失」「仅在远端」就一眼可读。
 */
const DIFF_LABELS: [DiffKind, string][] = [
  ['missing_remote', '远端缺失'],
  ['remote_only', '仅在远端'],
  ['size_mismatch', '内容不符']
]

/** 每个差异类型的完整解释，挂在筛选按钮的 title 上 */
const DIFF_DESCRIPTIONS: Record<DiffKind, string> = {
  local_only: '本地有、远端还没有的文件',
  missing_remote: '清单里记着已同步，但远端已不存在（可能被外部删除），将重新上传',
  remote_only: '远端有、本地还没有的文件，默认只记录不处理',
  size_mismatch: '两边都有这个文件，但大小不同，将以本地为准覆盖'
}

const DIFF_KIND_LABELS: Record<DiffKind, string> = {
  local_only: '仅本地',
  missing_remote: '远端缺失',
  remote_only: '仅在远端',
  size_mismatch: '内容不符'
}

/** 可信度筛选项 */
const VERIFY_FILTER_LABELS: Record<VerifyFilter, string> = {
  all: '不限',
  hash: '哈希确认',
  reconciled: '已核对',
  size: '仅大小',
  unknown: '未校验'
}

const VERIFY_FILTER_HINTS: Record<VerifyFilter, string> = {
  all: '不按可信度筛选',
  hash: '把远端文件拉回来重算哈希比对过，结论可靠',
  reconciled: '对账时确认远端确有这份文件、大小一致，但没读内容',
  size: '按「名称 + 大小」认领远端已有——这份从没真正上传过，远端那个可能是别的文件',
  unknown: '还没跟远端核对过：本地没动过，直接沿用了上次同步的结论'
}

/** 差异标签另起一套配色，不与同步状态标签共用 */
function diffTone(kind: DiffKind): string {
  switch (kind) {
    case 'missing_remote':
      return 'amber'
    case 'remote_only':
      return 'purple'
    case 'size_mismatch':
      return 'orange'
    default:
      return 'gray'
  }
}

/**
 * 可信级别标签。
 *
 * 这一列是「同名同大小」认领的**唯一可视化出口**：
 * 认领只比了名称与大小、没读内容，所以必须让用户一眼看出
 * 哪些「已同步」的结论其实是弱认定——那些文件本地那份可能根本没备份。
 */
const VERIFY_LABELS: Record<'hash' | 'reconciled' | 'size', string> = {
  hash: '哈希确认',
  reconciled: '已核对',
  size: '仅大小'
}

/**
 * 可信度的展开版说明（徽章悬停 + 展开详情共用）。
 *
 * 三种取值回答的是「这个结论**凭什么**得出」，而不是「文件传完了没」：
 * - 哈希确认：内容比对过，最硬
 * - 仅大小：远端确有这份文件且大小一致——可能是对账核对出来的，
 *   也可能是按「名称 + 大小」认领来的；内容没读过
 * - 未校验：连远端都没核对过，只是本地没变、沿用上次的结论
 */
const VERIFY_HINTS: Record<'hash' | 'reconciled' | 'size', string> = {
  hash: '哈希确认：远端文件已拉回本地重算哈希并比对通过',
  reconciled: '已核对：对账时确认远端确有这份文件、大小一致，但内容没读过。要确认内容请用「深度校验」。',
  size: '仅大小：按「名称 + 大小」认领远端已有，这份从没真正上传过——远端那个同名同大小的可能是另一个文件。建议深度校验。'
}

const VERIFY_HINTS_UNKNOWN =
  '未校验：还没跟远端核对过——本地大小与修改时间没变，直接沿用了上次成功的结论。跑一次「立即对账」可升级为「仅大小」，要确认内容则用「深度校验」。'

function verifyText(level: 'hash' | 'reconciled' | 'size' | null): string {
  return level ? VERIFY_HINTS[level] : VERIFY_HINTS_UNKNOWN
}
/*
 * 配色表达的是**风险**，不是等级高低：
 * - 哈希确认：绿，内容对过
 * - 已核对：蓝，对账确认远端在、大小对，内容没读
 * - 仅大小：黄，认领来的，远端那份可能是别的文件
 * - 未校验：灰，还没跟远端核对过
 *
 * 「已核对」不能沿用黄色：对账跑一趟全变黄，会被当成满屏告警。
 */
function verifyTone(level: 'hash' | 'reconciled' | 'size' | null): string {
  if (level === 'hash') return 'green'
  if (level === 'reconciled') return 'blue'
  if (level === 'size') return 'amber'
  return 'gray'
}

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
