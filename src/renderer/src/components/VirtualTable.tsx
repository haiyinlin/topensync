import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

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
 * 单行高度（像素）。
 *
 * 必须与 CSS 里 `.vtable-tbl tr` 的高度**严格一致**——
 * 虚拟滚动的全部位置计算都建立在这个值上，
 * 对不上就会出现「滚动一格跳两行」或者底部露白。
 */
const ROW_HEIGHT = 40
/** 可视区上下各多渲染几行，滚动时不会看到空白 */
const OVERSCAN = 6

export interface VirtualTableProps {
  /** 表头（一个 `<tr>`） */
  head: React.ReactNode
  /** 总行数 */
  rowCount: number
  /** 取第 i 行；返回 null 表示该行不渲染（占位） */
  renderRow: (index: number) => React.ReactNode
  /** 无数据时的提示 */
  empty?: React.ReactNode
  /** 表体容器的最大高度；不传则撑满父容器 */
  maxHeight?: number
}

export function VirtualTable({
  head,
  rowCount,
  renderRow,
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

  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT)
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(rowCount, start + visibleCount + OVERSCAN * 2)

  const topPad = start * ROW_HEIGHT
  const bottomPad = (rowCount - end) * ROW_HEIGHT

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
