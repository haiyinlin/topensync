import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * 虚拟滚动表格。
 *
 * 为什么需要：本地目录六万个文件、远端几千个文件时，
 * 把每一行都塞进 DOM 会让渲染进程直接卡死——
 * 几万个 `<tr>` 光是布局就要几秒，滚动更是彻底没反应。
 *
 * 做法：表体只渲染**可视区域 + 一点缓冲**的那些行，
 * 上方/下方各放一个撑高度的占位行。
 * DOM 节点数恒定在几十个，与总行数无关。
 *
 * 为什么保留 `<table>` 而不是改成 div：
 * 表格语义、列宽、表头样式、批量操作的勾选框全都依赖现有的表格 CSS。
 * 换成 div 要重写一整套样式，收益为零、风险一堆。
 * 占位行用「只有高度、没有内容」的 `<tr>` 实现，
 * Chrome / Edge / Firefox 都支持得很好。
 *
 * 代价：Ctrl+F 之类的浏览器原生查找只能找到已渲染的行。
 * 这是这类工具的通用取舍——能滚动比能全文查找重要得多。
 */

/**
 * 基础行高（像素）：两行内容（主信息 + 次信息）。
 *
 * 旧版是 40px 单行，列一多就必然截断——文件名、哈希、远端路径
 * 全挤在一行里，只能看到开头几个字。改成两行之后
 * 「一行放不下就换第二行」，主信息（文件名）几乎总能读全。
 *
 * 必须与 CSS 里 `tr.row-main` 的高度**严格一致**——
 * 虚拟滚动的全部位置计算都建立在这套高度上，
 * 对不上就会出现「滚动一格跳两行」或者底部露白。
 */
const ROW_HEIGHT = 56
/** 可视区上下各多渲染几行，滚动时不会看到空白 */
const OVERSCAN = 6

export interface VirtualTableProps {
  /** 表头（一个 `<tr>`） */
  head: React.ReactNode
  /** 总行数 */
  rowCount: number
  /**
   * 取第 i 行；返回 null 表示该行不渲染（占位）。
   *
   * 展开的行可以在同一个 React 节点里返回**两个** `<tr>`：
   * 主行 + 详情行（用 `<React.Fragment key=…>` 包起来）。
   * 高度由 `rowHeight` 如实提供。
   */
  renderRow: (index: number) => React.ReactNode
  /**
   * 第 i 行的高度。不传则全部按 ROW_HEIGHT。
   *
   * **必须是稳定引用**（useCallback）——它进 useMemo 的依赖，
   * 每次渲染都新建一个函数会让 6 万行的高度表反复重算。
   */
  rowHeight?: (index: number) => number
  /** 无数据时的提示 */
  empty?: React.ReactNode
  /** 表体容器的最大高度；不传则撑满父容器 */
  maxHeight?: number
}

export function VirtualTable({
  head,
  rowCount,
  renderRow,
  rowHeight,
  empty,
  maxHeight
}: VirtualTableProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)

  /*
   * 监听滚动位置。
   *
   * 用 requestAnimationFrame 节流：滚动事件在一帧内能触发几十次，
   * 每次都 setState 会让 React 在一帧里重渲染几十遍——
   * 这正是「滚动起来卡」的典型原因。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  /*
   * 观测容器高度。
   *
   * 窗口缩放、面板折叠都会改变可视高度，
   * 不知道可视区多大就只能按固定值算可见行数——
   * 窗口小的时候渲染一堆看不见的行，窗口大的时候又不够，
   * 底部会出现空白。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h && h > 0) setViewportHeight(h)
    })
    ro.observe(el)
    setViewportHeight(el.clientHeight || 480)
    return () => ro.disconnect()
  }, [])

  /*
   * 行高表 + 前缀和。
   *
   * 固定行高时定位是「scrollTop / ROW_HEIGHT」一句话的事；
   * 有了展开行之后每行高度不同，必须先有前缀和才能反查
   * 「scrollTop 落在第几行」。
   *
   * 只在行数或行高函数变化时重算（滚动不参与），
   * 六万行大约 1~2ms，用户感受不到。
   */
  const offsets = useMemo(() => {
    // Float64Array：六万行用普通数组会产生一堆装箱的 number
    const arr = new Float64Array(rowCount + 1)
    let acc = 0
    for (let i = 0; i < rowCount; i++) {
      arr[i] = acc
      acc += rowHeight ? rowHeight(i) : ROW_HEIGHT
    }
    arr[rowCount] = acc
    return arr
  }, [rowCount, rowHeight])

  /**
   * 二分查找：偏移量 → 行号。
   *
   * 展开行让行高不再均等，「除一下」的算法会把位置算歪；
   * 二分是对数级，六万行只要 16 步。
   */
  const indexAt = (offset: number): number => {
    let lo = 0
    let hi = rowCount
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const start = Math.max(0, indexAt(scrollTop) - OVERSCAN)
  const end = Math.min(rowCount, indexAt(scrollTop + viewportHeight) + 1 + OVERSCAN)

  const topPad = offsets[start]
  const bottomPad = offsets[rowCount] - offsets[end]

  const rows: React.ReactNode[] = []
  for (let i = start; i < end; i++) {
    const node = renderRow(i)
    if (node) rows.push(node)
  }

  return (
    <div
      className="vtable"
      ref={scrollRef}
      style={maxHeight ? { maxHeight, height: maxHeight } : { height: '100%' }}
    >
      <table className="tbl vtable-tbl">
        <thead className="vtable-head">{head}</thead>
        <tbody>
          {rowCount === 0 && (
            <tr>
              <td colSpan={100} className="vtable-empty-cell">
                {empty ?? '没有数据'}
              </td>
            </tr>
          )}
          {topPad > 0 && (
            <tr className="vtable-pad" style={{ height: topPad }}>
              <td colSpan={100} />
            </tr>
          )}
          {rows}
          {bottomPad > 0 && (
            <tr className="vtable-pad" style={{ height: bottomPad }}>
              <td colSpan={100} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export { ROW_HEIGHT }
