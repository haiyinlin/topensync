import * as React from 'react'
import { useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { BatchBar } from '../components/BatchBar'
import type { PageKey } from '../App'
import type { DeepVerifyResult, DiffKind, DiffResolution } from '@shared/types'
import { formatSize } from './Queue'
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
type StatusFilter = 'all' | 'synced' | 'pending' | 'deleted'
type DiffFilter = DiffKind | 'all' | 'none'
type VerifyFilter = 'all' | 'hash' | 'size' | 'unknown'

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

/** 远端路径单元格：灰色根前缀 + 亮色相对路径，title 给完整绝对路径 */
function RemotePath({
  remoteRoot,
  remotePath
}: {
  remoteRoot: string
  remotePath: string
}): React.JSX.Element {
  const { root, rel } = splitRemote(remoteRoot, remotePath)
  return (
    <span className="path-split" title={remotePath}>
      {root && <span className="path-root">{root}</span>}
      <span className="path-rel">{rel}</span>
    </span>
  )
}

export function ManifestPage({ onNavigate }: { onNavigate: (k: PageKey) => void }): React.JSX.Element {
  const files = useAppStore((s) => s.files)
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
      ['size', 0],
      ['unknown', 0]
    ])
    for (const f of files) {
      if (f.verifyLevel === 'hash') map.set('hash', (map.get('hash') ?? 0) + 1)
      else if (f.verifyLevel === 'size') map.set('size', (map.get('size') ?? 0) + 1)
      else map.set('unknown', (map.get('unknown') ?? 0) + 1)
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
        if (verifyFilter === 'hash' && f.verifyLevel !== 'hash') return false
        if (verifyFilter === 'size' && f.verifyLevel !== 'size') return false
        if (verifyFilter === 'unknown' && f.verifyLevel !== null) return false
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
  const selectedPaths = useMemo(
    () =>
      [...selected]
        .filter((id) => id.startsWith(LOCAL_ID_PREFIX))
        .map((id) => id.slice(LOCAL_ID_PREFIX.length))
        .filter((p) => files.some((f) => f.localPath === p)),
    [selected, files]
  )

  /** 远端根目录：用来把远端绝对路径拆成「根 + 相对路径」 */
  const remoteRoot = config?.remoteRoot || '/'

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
          {(['all', 'hash', 'size', 'unknown'] as VerifyFilter[]).map((k) => (
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
          「仅大小」只比了文件名与大小，内容未校验——这些文件本地那份可能没备份
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
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '4%' }} />
                <th style={{ width: '46%' }}>远端文件（相对远端根）</th>
                <th style={{ width: '12%' }}>大小</th>
                <th style={{ width: '14%' }}>发现时间</th>
                <th style={{ width: '24%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {remoteOnly.map((d) => (
                <tr key={d.id}>
                  <td>
                    <label className="batch-check">
                      <input
                        type="checkbox"
                        checked={selected.has(d.remotePath)}
                        onChange={() => {
                          const next = new Set(selected)
                          const id = `${REMOTE_ID_PREFIX}${d.remotePath}`
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          setSelected(next)
                        }}
                      />
                    </label>
                  </td>
                  <td>
                    <div className="cell-file">
                      <Icon name="cloud-check" className="ic file" />
                      <RemotePath remoteRoot={remoteRoot} remotePath={d.remotePath} />
                    </div>
                  </td>
                  <td className="mono dim">
                    {d.remoteSize !== null ? formatSize(d.remoteSize) : '—'}
                  </td>
                  <td className="mono dim nw">{formatTime(d.detectedAt)}</td>
                  <td>
                    <div className="act-row">
                      <button
                        className="btn tiny primary"
                        onClick={() => resolveRemoteDiff(d.id, 'pulled')}
                      >
                        <Icon name="down" />
                        下载到本地
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
              ))}
            </tbody>
          </table>
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
            同步目录内受管的文件，共 {shown.length} 个 —— 路径均相对本地同步目录
          </span>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '4%' }} />
              <th style={{ width: '22%' }}>本地文件</th>
              <th style={{ width: '8%' }}>大小</th>
              <th style={{ width: '11%' }}>修改时间</th>
              <th style={{ width: '19%' }} title="相对远端根目录的路径；与本地路径不同时会高亮">
                远端位置
              </th>
              <th style={{ width: '10%' }}>哈希 (md5:sha1)</th>
              <th style={{ width: '9%' }}>同步状态</th>
              <th style={{ width: '8%' }}>可信度</th>
              <th style={{ width: '9%' }}>对账差异</th>
              <th style={{ width: '4%' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  className="dim"
                  style={{ textAlign: 'center', padding: '28px 12px' }}
                >
                  {files.length === 0
                    ? '清单为空。启动本地扫描后这里会列出所有受管文件。'
                    : `当前筛选条件下没有文件（共 ${files.length} 个）。放宽筛选条件试试。`}
                </td>
              </tr>
            )}
            {shown.map((f) => (
              <tr key={f.id}>
                <td>
                  <label className="batch-check">
                    <input
                      type="checkbox"
                      checked={selected.has(f.localPath)}
                      onChange={() => {
                        const next = new Set(selected)
                        const id = `${LOCAL_ID_PREFIX}${f.localPath}`
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        setSelected(next)
                      }}
                    />
                  </label>
                </td>
                <td>
                  <div className="cell-file">
                    <Icon name="files" className="ic file" />
                    <span title={f.localPath}>{f.localPath}</span>
                  </div>
                </td>
                <td className="mono dim">{formatSize(f.localSize)}</td>
                <td className="mono dim nw">{formatTime(f.mtimeMs)}</td>
                <td className="mono">
                  {f.remotePath ? (
                    <div className="cell-file">
                      <Icon name="cloud-check" className="ic file" />
                      {(() => {
                        const rel = splitRemote(remoteRoot, f.remotePath).rel
                        // 远端位置与本地路径一致时压暗：
                        // 这一列真正要回答的是「远端放的位置跟本地一样吗」，
                        // 几百行都一样的路径刷成亮色只会变成冗余列。
                        const same = rel.replace(/^\//, '') === f.localPath
                        return (
                          <span className="path-split" title={f.remotePath}>
                            <span className="path-root">{splitRemote(remoteRoot, f.remotePath).root}</span>
                            <span className={same ? 'path-rel same' : 'path-rel'}>{rel}</span>
                          </span>
                        )
                      })()}
                    </div>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td className="mono dim">
                  {f.md5 ? `${f.md5.slice(0, 8)}:${f.sha1?.slice(0, 4) ?? ''}…` : '—'}
                </td>
                <td>
                  <span className={`pill ${stateTone(f.state)}`}>{STATE_LABELS[f.state] ?? f.state}</span>
                </td>
                <td>
                  {f.verifyLevel ? (
                    <span
                      className={`pill ${verifyTone(f.verifyLevel)}`}
                      title={
                        f.verifyLevel === 'size'
                          ? '仅凭「文件名 + 大小」认定远端已有，内容未校验。可用深度校验确认。'
                          : '内容已通过哈希比对确认。'
                      }
                    >
                      {VERIFY_LABELS[f.verifyLevel]}
                    </span>
                  ) : (
                    <span className="pill gray">—</span>
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
                <td>
                  <button
                    className="btn tiny ghost"
                    title="删除本地文件"
                    onClick={() => {
                      const next = new Set(selected)
                      next.add(`${LOCAL_ID_PREFIX}${f.localPath}`)
                      setSelected(next)
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BatchBar
        allIds={[
          // 候选全集 = 当前筛选后可见的本地文件 + 全部远端独有文件。
          // 以前这里传的是「已选的本地路径 + 全部远端项」——
          // 也就是说点「全选」时本地文件一个都没被选中，
          // 因为 selectedPaths 是从已选集合反推出来的。
          ...shown.map((f) => `${LOCAL_ID_PREFIX}${f.localPath}`),
          ...remoteOnly.map((d) => `${REMOTE_ID_PREFIX}${d.remotePath}`)
        ]}
        selected={selected}
        onSelectionChange={setSelected}
        hint={`已选 ${selected.size} 项`}
        actions={[
          {
            label: '删除本地文件',
            danger: true,
            confirmTitle: '删除本地文件',
            confirmBody: selectedPaths.length
              ? `将删除 ${selectedPaths.length} 个本地文件，远端副本按删除策略处理（通常是移入回收站）。`
              : '未选中本地文件。',
            onRun: async (ids) => {
              const paths = ids
                .filter((id) => id.startsWith(LOCAL_ID_PREFIX))
                .map((id) => id.slice(LOCAL_ID_PREFIX.length))
                .filter((p) => files.some((f) => f.localPath === p))
              if (paths.length === 0) return
              await deleteLocalFiles(paths)
            }
          },
          {
            label: '删除远端文件',
            danger: true,
            confirmTitle: '删除远端文件',
            confirmBody: '将把选中的远端文件移入远端回收站，并关闭对应差异。',
            onRun: async (ids) => {
              // 用传进来的 ids（本次实际选中的）而不是 selectedRemotePaths，
              // 这样用户在确认弹窗期间改了勾选也不会删错。
              const targets = remoteOnly
                .filter((d) => ids.includes(`${REMOTE_ID_PREFIX}${d.remotePath}`))
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
            confirmTitle: '深度校验',
            confirmBody:
              '把选中的远端文件下载回来重算哈希，与本地比对。' +
              '一致则升级为「哈希确认」；不一致则按「本地为准」重新上传。' +
              '会消耗与文件大小成正等的下行流量，超过体积上限的文件会被跳过。',
            onRun: async (ids) => {
              const paths = ids
                .filter((id) => id.startsWith(LOCAL_ID_PREFIX))
                .map((id) => id.slice(LOCAL_ID_PREFIX.length))
                .filter((p) => files.some((f) => f.localPath === p))
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
  deleted: '已删除'
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
  size: '仅大小',
  unknown: '未标记'
}

const VERIFY_FILTER_HINTS: Record<VerifyFilter, string> = {
  all: '不按可信度筛选',
  hash: '内容经过哈希比对确认，可靠',
  size: '仅凭「文件名 + 大小」弱认定，内容未校验',
  unknown: '尚未走完同步流程，没有可信度标记'
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
const VERIFY_LABELS: Record<'hash' | 'size', string> = {
  hash: '哈希确认',
  size: '仅大小'
}
function verifyTone(level: 'hash' | 'size' | null): string {
  if (level === 'hash') return 'green'
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
