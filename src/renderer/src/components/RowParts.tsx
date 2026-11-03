import * as React from 'react'
import { Icon } from './Icon'

/**
 * 列表行的公共零件。
 *
 * 为什么要把行做成「两行 + 可展开」：
 *
 * 旧版每一行只有 40px、信息全挤在一行里。列一多，每一列都窄得放不下
 * 内容——文件名只看得见开头十几个字，哈希只看得见前 8 位，远端路径
 * 只剩「/qh/qh/备份/…」，等于什么都没说。
 *
 * 现在分三层：
 *   1. 第一行：**主信息**（文件名、日志说明）——用户最想看到的，优先占宽；
 *   2. 第二行：**次信息**（父目录、大小时间等）——暗色小字，扫一眼即可；
 *   3. 展开区：**全部细节**（完整路径、完整哈希、错误信息）——按需展开。
 *
 * 这样既不会因为某一列太窄而丢信息，也不必把每一行都撑得很高。
 */

/* ── 两行单元格 ─────────────────────────────────────────── */

/**
 * 文件单元格：图标 + 文件名（第一行），父目录（第二行）。
 *
 * 为什么第一行只放**文件名**而不是完整路径：
 * 路径一长，排在后面的文件名就被挤没了——恰恰是最该看见的部分。
 * 目录信息退到第二行，两行都不够时还有展开区和 title。
 */
export function FileCell({
  icon = 'files',
  name,
  meta,
  title,
  badge
}: {
  icon?: string
  name: string
  meta?: React.ReactNode
  title?: string
  badge?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="cell2">
      <div className="cell2-l1">
        <Icon name={icon} className="ic file" />
        <span className="cell2-name" title={title ?? name}>
          {name}
        </span>
        {badge}
      </div>
      {meta ? <div className="cell2-l2 cell2-indent">{meta}</div> : null}
    </div>
  )
}

/** 通用两行文本：第一行主内容，第二行次内容 */
export function Cell2({
  line1,
  line2,
  title
}: {
  line1: React.ReactNode
  line2?: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div className="cell2" title={title}>
      <div className="cell2-l1">{line1}</div>
      {line2 ? <div className="cell2-l2">{line2}</div> : null}
    </div>
  )
}

/**
 * 把相对路径拆成「文件名」+「父目录」。
 *
 * 列表里第一行显示文件名、第二行显示父目录，靠的就是它。
 * 没有目录时第二行留空，不要显示一个孤零零的斜杠。
 */
export function splitPath(p: string): { name: string; dir: string } {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  if (idx < 0) return { name: norm, dir: '' }
  return { name: norm.slice(idx + 1) || norm, dir: norm.slice(0, idx) }
}

/* ── 展开按钮 ───────────────────────────────────────────── */

export function ExpandToggle({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`exp-btn${open ? ' open' : ''}`}
      title={open ? '收起详情' : '展开全部信息（完整路径、哈希等）'}
      aria-expanded={open}
      onClick={(e) => {
        // 行本身没有点击行为，但别让冒泡触发外层可能的选中逻辑
        e.stopPropagation()
        onToggle()
      }}
    >
      <Icon name="chevron" />
    </button>
  )
}

/* ── 展开详情 ───────────────────────────────────────────── */

export interface DetailItem {
  /** 字段名 */
  k: string
  /** 字段值 */
  v: React.ReactNode
  /** 等宽字体（路径、哈希） */
  mono?: boolean
  /** 悬停显示完整内容 */
  title?: string
}

export interface DetailRow {
  items: DetailItem[]
  /** 高行：值允许换行（最多 3 行），用于长文本（错误信息、日志说明） */
  tall?: boolean
}

/** 详情区每行的高度与间距，必须与 app.css 里 .row-detail-* 严格一致 */
const ROW_H = 22
const TALL_H = 66
const GAP = 4
const PAD = 16

/**
 * 按行数算出详情区的总高度。
 *
 * 虚拟滚动要求「每行高度可知」——展开行的真实高度必须算准，
 * 否则滚动位置会漂移、下方会露白。
 */
export function detailHeight(rows: DetailRow[]): number {
  if (rows.length === 0) return 0
  let h = PAD
  for (let i = 0; i < rows.length; i++) {
    h += rows[i].tall ? TALL_H : ROW_H
    if (i > 0) h += GAP
  }
  return h
}

/**
 * 展开后的详情行（一个跨全部列的 `<tr>`）。
 *
 * 放进 `renderRow` 的 Fragment 里，紧跟主行之后。
 */
export function RowDetail({
  rows,
  colSpan
}: {
  rows: DetailRow[]
  colSpan: number
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <tr className="row-detail" style={{ height: detailHeight(rows) }}>
      <td colSpan={colSpan}>
        <div className="row-detail-inner">
          {rows.map((row, i) => (
            <div className={`row-detail-row${row.tall ? ' tall' : ''}`} key={i}>
              {row.items.map((item, j) => (
                <div className="dl-item" key={j}>
                  <span className="dl-k">{item.k}</span>
                  <span
                    className={`dl-v${item.mono ? ' mono' : ''}`}
                    title={item.title}
                  >
                    {item.v}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}
