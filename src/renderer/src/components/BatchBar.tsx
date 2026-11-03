import * as React from 'react'
import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { describeError } from '../store'

/**
 * 批量操作条。
 *
 * 三个列表（文件清单 / 传输队列 / 远端对账）都要有「删除」和「批量删除」，
 * 但每处的删除语义不同：
 * - 文件清单：删**本地文件**，远端按删除策略跟进
 * - 传输队列：只清**任务记录**，不动文件
 * - 远端对账：删**远端文件**（走回收站），并关闭该差异
 *
 * 所以语义由调用方通过 props 传入，本组件只管勾选、计数、确认与触发。
 *
 * 为什么自己实现而不用 <input type="checkbox"> 的默认样式：
 * 默认勾选框在深色主题下几乎看不见，而「勾错了就删文件」的后果很重。
 */

export interface BatchAction {
  /** 按钮文案 */
  label: string
  /** 危险操作（删除类）用红色 */
  danger?: boolean
  /**
   * 主操作（如「重新上传 206 条」）用实心按钮。
   *
   * 批量条里的按钮以前全是 ghost 灰底 + 硬编码的垃圾桶图标，
   * 「重新上传」「下载」前面也顶着个垃圾桶——图标与动作对不上，
   * 用户得读文字才知道自己按的是什么。
   */
  primary?: boolean
  /** 图标名；不传则不画图标 */
  icon?: string
  /** 二次确认的标题；不传则不弹确认 */
  confirmTitle?: string
  /** 二次确认的正文 */
  confirmBody?: string
  /** 点击后执行 */
  onRun: (selected: string[]) => void | Promise<void>
}

export interface BatchBarProps {
  /** 所有可选条目的 id */
  allIds: string[]
  /** 当前已选中的 id */
  selected: Set<string>
  /** 选中变化 */
  onSelectionChange: (next: Set<string>) => void
  /** 操作按钮（第一个是主操作） */
  actions: BatchAction[]
  /** 左侧说明文案；不传则用默认的「已选 N 项」 */
  hint?: string
}

/** 危险操作的确认文案：默认按「N 项」生成 */
function defaultConfirmBody(label: string, count: number): string {
  return `即将${label} ${count} 项。此操作不可撤销，请确认。`
}

export function BatchBar({
  allIds,
  selected,
  onSelectionChange,
  actions,
  hint
}: BatchBarProps): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<BatchAction | null>(null)
  /** 批量操作失败的提示；失败必须当场让用户看见 */
  const [error, setError] = useState<string | null>(null)

  const count = selected.size
  const allSelected = allIds.length > 0 && count === allIds.length

  // 选中项换了就清掉上一轮的失败提示：那条提示是针对上一次选中的
  React.useEffect(() => {
    setError(null)
  }, [selected])

  const toggleAll = (): void => {
    onSelectionChange(allSelected ? new Set() : new Set(allIds))
  }

  const run = async (action: BatchAction): Promise<void> => {
    if (busy || count === 0) return
    setBusy(true)
    setError(null)
    try {
      await action.onRun([...selected])
      onSelectionChange(new Set())
    } catch (e) {
      /*
       * 批量操作失败必须说清楚。
       *
       * 以前这里只有 finally：异常直接冒出去（unhandled rejection），
       * 界面上按钮一按就没反应——用户以为程序卡死，转头去重复点击，
       * 于是「删了一半」这种局面比直接报错更糟。
       */
      setError(describeError(e))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const onClick = (action: BatchAction): void => {
    if (action.confirmTitle) {
      setPending(action)
      return
    }
    void run(action)
  }

  const confirmText = useMemo(() => {
    if (!pending) return ''
    return (
      pending.confirmBody ??
      defaultConfirmBody(pending.label.replace(/（.*?）/g, ''), selected.size)
    )
  }, [pending, selected.size])

  if (count === 0) return null

  return (
    <>
      <div className="batch-bar">
        <label className="batch-check" title="全选 / 全不选">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          <span>{hint ?? `已选 ${count} 项`}</span>
        </label>
        <div className="batch-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              className={`btn tiny ${a.danger ? 'danger' : a.primary ? 'primary' : 'ghost'}`}
              disabled={busy}
              onClick={() => onClick(a)}
            >
              {a.icon && <Icon name={a.icon} />}
              {a.label}
            </button>
          ))}
          <button
            className="btn tiny ghost"
            disabled={busy}
            onClick={() => onSelectionChange(new Set())}
          >
            取消选择
          </button>
        </div>
        {error && (
          /*
           * 错误提示放在批量条自己身上（不是页面别处）：
           * 用户点了按钮之后视线就在这一条上，别处的红字他看不见。
           * flex-basis:100% 让它换行独占一行，不挤按钮。
           */
          <p
            className="warn-note"
            style={{
              flexBasis: '100%',
              marginTop: 0,
              color: 'var(--red)',
              background: 'var(--red-bg)',
              borderColor: 'var(--red)'
            }}
          >
            <Icon name="alert" />
            {error}
          </p>
        )}
      </div>

      {pending && (
        <div className="modal-mask" onClick={() => setPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{pending.confirmTitle}</h3>
            <p className="dim">{confirmText}</p>
            <div className="act-row end">
              <button className="btn ghost" disabled={busy} onClick={() => setPending(null)}>
                取消
              </button>
              <button
                className={`btn ${pending.danger ? 'danger' : 'primary'}`}
                disabled={busy}
                onClick={() => void run(pending)}
              >
                {busy ? '处理中…' : `确认${pending.label.replace(/（.*?）/g, '')}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
