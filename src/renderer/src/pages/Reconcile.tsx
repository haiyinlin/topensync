import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { BatchBar } from '../components/BatchBar'
import type { BatchAction } from '../components/BatchBar'
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

/**
 * 每类差异的「一键全处理」动作。
 *
 * 用户的原话：206 条远端缺失，难道要一条一条点过去。
 * 每类差异的正确处置方向其实只有一种，所以按类型给一个批量入口——
 * 不需要先勾选，直接对**当前筛选出的全部**生效。
 *
 * remote_only 不给「批量删除」：它删的是别人设备刚传上去的文件，
 * 且与本地无关，误点一次就是不可逆的数据丢失。这类仍走勾选 + 确认。
 */
const BULK_META: Record<
  DiffKind,
  { label: string; resolution: DiffResolution; icon: string; desc: string } | null
> = {
  missing_remote: {
    label: '全部重新上传',
    resolution: 'uploaded',
    icon: 'upload',
    desc: '把当前列出的本地文件重新上传到远端，补回被删掉的那一份'
  },
  local_only: {
    label: '全部上传',
    resolution: 'uploaded',
    icon: 'upload',
    desc: '把当前列出的本地文件上传到远端'
  },
  size_mismatch: {
    label: '全部覆盖远端',
    resolution: 'overwritten',
    icon: 'overwrite',
    desc: '用本地版本覆盖远端那份大小不一致的文件'
  },
  remote_only: {
    label: '全部下载',
    resolution: 'pulled',
    icon: 'down',
    desc: '把远端多出的文件下载到本地同步目录'
  }
}

export function Reconcile(): React.JSX.Element {
  const diffs = useAppStore((s) => s.diffs)
  const refreshDiffs = useAppStore((s) => s.refreshDiffs)
  const deleteRemoteFiles = useAppStore((s) => s.deleteRemoteFiles)
  const resolveDiffs = useAppStore((s) => s.resolveDiffs)
  const scan = useAppStore((s) => s.stats?.remoteScan ?? null)
  const progress = useAppStore((s) => s.progress)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  /* ── 批量处置 ────────────────────────────────────────── */
  const [bulkBusy, setBulkBusy] = useState(false)
  /** 等待确认的批量动作（条数多时先问一句） */
  const [bulkPending, setBulkPending] = useState<{
    label: string
    desc: string
    ids: number[]
    resolution: DiffResolution
  } | null>(null)
  /** 批量执行后的结果摘要：跳过多少、为什么，必须当场说清楚 */
  const [bulkDone, setBulkDone] = useState<{
    label: string
    handled: number
    skipped: number
    failed: number
    reasons: { reason: string; count: number }[]
  } | null>(null)

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

  /**
   * 「远端缺了什么」—— 分两类，因为处置方式不同。
   *
   * - `missing` + `mismatch`：曾经传过、远端现在没有或大小不对。
   *   这是「丢失」，要在这里点上传补回去。
   * - `unsent`（local_only）：本地有、还没传上去。它本来就排在同步队列里，
   *   开始同步就会传；这里只把它**列出来**，让「远端缺什么」的数字对得上
   *   （以前对账只统计 synced 的记录，用户看到 60 条、一开同步冒出 100 多，
   *   两个数字当然对不上）。
   */
  const remoteGap = useMemo(() => {
    const missing = diffs.filter((d) => d.kind === 'missing_remote')
    const mismatch = diffs.filter((d) => d.kind === 'size_mismatch')
    const unsent = diffs.filter((d) => d.kind === 'local_only')
    const bytesOf = (arr: typeof diffs): number => arr.reduce((a, d) => a + (d.localSize ?? 0), 0)
    return {
      missingCount: missing.length,
      mismatchCount: mismatch.length,
      unsentCount: unsent.length,
      repairCount: missing.length + mismatch.length,
      repairBytes: bytesOf(missing) + bytesOf(mismatch),
      totalBytes: bytesOf(missing) + bytesOf(mismatch) + bytesOf(unsent),
      /** 远端根本没有 → 重新上传 */
      newIds: missing.map((d) => d.id),
      /** 远端有但大小不对 → 覆盖 */
      mismatchIds: mismatch.map((d) => d.id)
    }
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

  /**
   * 当前列表能一键处理什么。
   *
   * - 选中某一类筛选 → 就是那一类
   * - 「全部差异」→ 只有当前列出的**全是同一类**时才给按钮；
   *   混着好几类时不能用一个按钮，否则「全部重新上传 206」会
   *   悄悄跳过另外 4 条仅在远端的，用户以为 210 条都处理了
   */
  const bulkTarget = useMemo(() => {
    if (shown.length === 0) return null
    let kind: DiffKind
    if (filter !== 'all') {
      kind = filter
    } else {
      const kinds = new Set(shown.map((d) => d.kind))
      if (kinds.size !== 1) return null
      kind = shown[0].kind
    }
    const meta = BULK_META[kind]
    if (!meta) return null
    return { kind, meta, ids: shown.map((d) => d.id), count: shown.length }
  }, [filter, shown])

  const byId = useMemo(() => new Map(diffs.map((d) => [String(d.id), d])), [diffs])

  /**
   * 一次处置多类差异。
   *
   * 「补传远端缺失」这个动作天然跨两类：远端没有的走 uploaded，
   * 远端有但大小不对的走 overwritten。分两次调 resolveDiffs 没问题，
   * 但结果摘要必须**合并成一条**——否则用户点一次会看到两行结果，
   * 还得自己把两个数字加起来。
   */
  const runGroups = useCallback(
    async (
      groups: Array<{ ids: number[]; resolution: DiffResolution }>,
      label: string
    ): Promise<void> => {
      const active = groups.filter((g) => g.ids.length > 0)
      if (active.length === 0 || bulkBusy) return
      setBulkBusy(true)
      setBulkPending(null)
      setBulkDone(null)

      let handled = 0
      let skipped = 0
      let failed = 0
      const reasons = new Map<string, number>()
      for (const g of active) {
        const res = await resolveDiffs(g.ids, g.resolution)
        if (!res) continue
        handled += res.handled
        skipped += res.skipped
        failed += res.failed
        for (const r of res.reasons) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count)
      }

      setBulkBusy(false)
      setBulkDone({
        label,
        handled,
        skipped,
        failed,
        reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
      })
      setSelected(new Set())
    },
    [bulkBusy, resolveDiffs]
  )

  const runBulk = useCallback(
    async (ids: number[], resolution: DiffResolution, label: string): Promise<void> => {
      if (ids.length === 0 || bulkBusy) return
      setBulkBusy(true)
      setBulkPending(null)
      setBulkDone(null)
      const res = await resolveDiffs(ids, resolution)
      setBulkBusy(false)
      if (res) {
        setBulkDone({
          label,
          handled: res.handled,
          skipped: res.skipped,
          failed: res.failed,
          reasons: res.reasons
        })
      }
      setSelected(new Set())
    },
    [bulkBusy, resolveDiffs]
  )

  /** 条数多就问一句，只有一条就直接做 */
  const askBulk = (ids: number[], resolution: DiffResolution, meta: { label: string; desc: string }): void => {
    if (ids.length === 0 || bulkBusy) return
    if (ids.length === 1) {
      void runBulk(ids, resolution, meta.label.replace('全部', ''))
      return
    }
    setBulkPending({ label: meta.label, desc: meta.desc, ids, resolution })
  }

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

  /**
   * 只读扫描：列举远端 + 比对 + 记差异，但**不自动上传**。
   *
   * 与上面的「立即对账」区别就在这一点：
   * 那条路沿用配置里的冲突策略，local-wins 时会自己重传最多 autoFixLimit 个。
   * 补传流程要的是「先给我看清单，我确认了再传」，所以这里显式关掉自动处置。
   */
  const scanOnly = (): void => {
    if (reconciling) return
    setBusy(true)
    window.topensync?.triggerScan('remote', { autoFix: false })
    setTimeout(() => void refreshDiffs(), 2600)
  }

  /**
   * 勾选后的批量动作：按**选中项里真的存在哪些类型**来给按钮。
   *
   * 以前这里无论选什么都只有「删除远端文件」和「忽略」两个，
   * 而最常见的需求恰恰是「这 200 条远端缺失，全部重新上传」——
   * 用户只能一条条点行尾的按钮。现在选中的类型有什么，
   * 就出什么批量动作，并且带条数。
   */
  const batchActions = useMemo<BatchAction[]>(() => {
    const sel = [...selected]
      .map((id) => byId.get(id))
      .filter((d): d is DiffEntry => d !== undefined)
    if (sel.length === 0) return []

    const idsOf = (kinds: DiffKind[]): number[] =>
      sel.filter((d) => kinds.includes(d.kind)).map((d) => d.id)

    const actions: BatchAction[] = []

    const uploadIds = idsOf(['missing_remote', 'local_only'])
    if (uploadIds.length > 0) {
      actions.push({
        label: `重新上传 ${uploadIds.length} 条`,
        icon: 'upload',
        primary: true,
        // 与工具栏的批量按钮同一条规矩：两条以上先确认一次
        confirmTitle: uploadIds.length > 1 ? '重新上传这些文件' : undefined,
        confirmBody:
          uploadIds.length > 1
            ? `将把选中的 ${uploadIds.length} 个本地文件重新上传到远端。上传会占用带宽，期间可在「传输队列」查看进度或取消。`
            : undefined,
        onRun: () => runBulk(uploadIds, 'uploaded', '重新上传')
      })
    }

    const overIds = idsOf(['size_mismatch'])
    if (overIds.length > 0) {
      actions.push({
        label: `覆盖远端 ${overIds.length} 条`,
        icon: 'overwrite',
        primary: true,
        confirmTitle: overIds.length > 1 ? '覆盖远端文件' : undefined,
        confirmBody:
          overIds.length > 1
            ? `将用本地版本覆盖选中的 ${overIds.length} 个远端文件，远端原文件不可恢复。`
            : undefined,
        onRun: () => runBulk(overIds, 'overwritten', '覆盖远端')
      })
    }

    const pullIds = idsOf(['remote_only'])
    if (pullIds.length > 0) {
      actions.push({
        label: `下载 ${pullIds.length} 条`,
        icon: 'down',
        primary: true,
        onRun: () => runBulk(pullIds, 'pulled', '下载')
      })
    }

    /*
     * 删除只针对「远端确实有这份文件」的差异。
     * 远端缺失的行本来就没有远端文件，把它们塞进删除队列，
     * 每条都会以 object not found 失败，日志里白刷一片红。
     */
    const deletable = sel.filter((d) => d.kind !== 'missing_remote' && d.kind !== 'local_only')
    if (deletable.length > 0) {
      actions.push({
        label: '删除远端文件',
        danger: true,
        icon: 'trash',
        confirmTitle: '删除远端文件',
        confirmBody: `将把选中的 ${deletable.length} 个远端文件移入远端回收站，并关闭对应差异。本地文件不受影响。`,
        onRun: async () => {
          await deleteRemoteFiles(
            deletable.map((d) => ({ remotePath: d.remotePath, diffId: d.id }))
          )
        }
      })
    }

    actions.push({
      label: '忽略',
      icon: 'eye-off',
      onRun: () => runBulk(sel.map((d) => d.id), 'ignored', '忽略')
    })

    return actions
  }, [selected, byId, bulkBusy, deleteRemoteFiles, runBulk])

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

      {/*
        * 「补传远端缺失」的显式入口。
        *
        * 功能上它就是远端对账的一个子集（missing_remote + size_mismatch），
        * 但用户不该为了补几个文件先去理解「对账」这个词。
        * 这张卡把三步摆在一起：扫描远端 → 看清单 → 我确认后上传。
        *
        * 与右上角「立即对账」的区别只有一条：这里走只读模式
        * （autoFix:false），扫描不会顺手自动重传。
        */}
      <div className="card rescan">
        <div className="rescan-main">
          <div className="rescan-title">
            <Icon name="cloud-check" />
            补传远端缺失
          </div>
          <p className="rescan-sub">
            按「相对路径 + 大小」比对本地清单与远端。扫描只读、不改动任何文件。
            「尚未上传」那批本来就排在同步队列里，开始同步会自动传，这里列出来是为了让数字对得上。
          </p>
        </div>

        <div className="rescan-facts">
          {/* 数字可直接点：点哪个就筛到哪一类，省得再去下面找 chip */}
          <button
            className="rf-item"
            onClick={() => setFilter('missing_remote')}
            title="只看远端缺失"
          >
            <span className="rf-k">远端缺失</span>
            <b className="mono rf-v">{remoteGap.missingCount}</b>
          </button>
          <button
            className="rf-item"
            onClick={() => setFilter('size_mismatch')}
            title="只看大小不符"
          >
            <span className="rf-k">大小不符</span>
            <b className="mono rf-v">{remoteGap.mismatchCount}</b>
          </button>
          <button className="rf-item" onClick={() => setFilter('local_only')} title="只看尚未上传">
            <span className="rf-k">尚未上传</span>
            <b className="mono rf-v">{remoteGap.unsentCount}</b>
          </button>
          <div className="rf-item">
            <span className="rf-k">合计大小</span>
            <b className="mono rf-v">
              {remoteGap.totalBytes > 0 ? formatSize(remoteGap.totalBytes) : '—'}
            </b>
          </div>
        </div>

        <div className="rescan-actions">
          <button
            className={`btn ghost${reconciling ? ' busy' : ''}`}
            onClick={scanOnly}
            disabled={reconciling}
            title="列举远端整棵树并与本地清单比对；只读，不会上传或删除任何文件"
          >
            <Icon name="diff" />
            {reconciling ? '扫描中…' : remoteGap.repairCount > 0 ? '重新扫描远端' : '扫描远端并比对'}
          </button>
          {remoteGap.repairCount > 0 && (
            <button
              className="btn primary"
              disabled={bulkBusy || reconciling}
              title="把「远端缺失」和「大小不符」的文件按本地版本补传到远端；尚未上传的那批会在开始同步后自动传"
              onClick={() =>
                void runGroups(
                  [
                    { ids: remoteGap.newIds, resolution: 'uploaded' },
                    { ids: remoteGap.mismatchIds, resolution: 'overwritten' }
                  ],
                  '补传远端缺失'
                )
              }
            >
              <Icon name="upload" />
              {bulkBusy ? '上传中…' : `补传这 ${remoteGap.repairCount} 个文件`}
            </button>
          )}
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
        {(
          ['missing_remote', 'local_only', 'size_mismatch', 'remote_only'] as DiffKind[]
        ).map((kind) => (
          <div className={`card dstat ${KIND_CARD_CLASS[kind]}`} key={kind}>
            <div className="dstat-head">
              <Icon
                name={
                  kind === 'missing_remote'
                    ? 'alert'
                    : kind === 'remote_only'
                      ? 'cloud-check'
                      : kind === 'local_only'
                        ? 'upload'
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
        {/*
          * 一键处理当前筛选出来的全部差异。
          *
          * 放在筛选条右侧、紧挨着刚点过的筛选，视线不用来回跑；
          * 按钮文案带条数，点之前就知道会影响多少行。
          */}
        <div className="tb-actions">
          {bulkTarget && (
            <>
              <button
                className="btn tiny primary"
                disabled={bulkBusy}
                title={bulkTarget.meta.desc}
                onClick={() => askBulk(bulkTarget.ids, bulkTarget.meta.resolution, bulkTarget.meta)}
              >
                <Icon name={bulkTarget.meta.icon} />
                {bulkBusy ? '处理中…' : `${bulkTarget.meta.label} ${bulkTarget.count} 条`}
              </button>
              {bulkTarget.kind === 'remote_only' && (
                <button
                  className="btn tiny ghost"
                  disabled={bulkBusy}
                  title="只标记为已知，不下载也不删除"
                  onClick={() =>
                    askBulk(bulkTarget.ids, 'ignored', {
                      label: '全部忽略',
                      desc: '仅把差异标记为已忽略，不改动任何文件'
                    })
                  }
                >
                  全部忽略
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {bulkDone && (
        <p className={`warn-note${bulkDone.skipped + bulkDone.failed === 0 ? ' ok-note' : ''}`}>
          <Icon name={bulkDone.skipped + bulkDone.failed === 0 ? 'check' : 'alert'} />
          {bulkDone.label}：成功 {bulkDone.handled} 条
          {bulkDone.skipped + bulkDone.failed > 0 && (
            <>
              ，跳过 {bulkDone.skipped + bulkDone.failed} 条
              {bulkDone.reasons.length > 0 && (
                <>
                  （
                  {bulkDone.reasons
                    .slice(0, 3)
                    .map((r) => `${r.reason} ×${r.count}`)
                    .join('；')}
                  {bulkDone.reasons.length > 3 ? ' 等' : ''}）
                </>
              )}
            </>
          )}
          。{bulkDone.handled > 0 ? '已排入传输队列，进度见「传输队列」。' : ''}
        </p>
      )}

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
                      {(d.kind === 'missing_remote' || d.kind === 'local_only') && (
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
        actions={batchActions}
      />

      <p className="warn-note">
        <Icon name="shield" />
        默认策略为「本地为准」：远端缺失与内容不符会自动重传；仅远端存在的文件只记录不处理，避免误删其他设备刚上传的内容。单次自动修复上限 20 个文件，超出则仅记录并在此列出。
      </p>

      {/*
        * 批量动作的二次确认。
        *
        * 只对「条数 ≥ 2」弹：一条的时候多点一次弹窗纯属烦人，
        * 而几百条一起重传/覆盖已经是不可逆的大动作，必须让用户看清数量再按。
        */}
      {bulkPending && (
        <div className="modal-mask" onClick={() => setBulkPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{bulkPending.label}</h3>
            <p className="dim">
              即将对当前列出的 <b>{bulkPending.ids.length}</b> 条差异执行：{bulkPending.desc}。
              {bulkPending.label.includes('上传') &&
                '上传会占用带宽，期间可在「传输队列」查看进度或取消。'}
              {bulkPending.label.includes('覆盖') &&
                '远端那份大小不一致的文件会被本地版本覆盖，原文件不可恢复。'}
            </p>
            <div className="act-row end">
              <button className="btn ghost" onClick={() => setBulkPending(null)}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={bulkBusy}
                onClick={() => {
                  const target = bulkPending
                  if (!target) return
                  void runBulk(target.ids, target.resolution, target.label)
                }}
              >
                {bulkBusy ? '处理中…' : `确认${bulkPending.label}`}
              </button>
            </div>
          </div>
        </div>
      )}
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
