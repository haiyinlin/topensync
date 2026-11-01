import * as React from 'react'
import { useState } from 'react'
import { Icon } from './Icon'

/**
 * 顶栏。
 *
 * 两条扫描通道各有独立触发按钮 —— 用户必须能一眼分辨
 * 「扫描本地」和「对账远端」不是同一件事。
 */
export function TopBar(): React.JSX.Element {
  const [running, setRunning] = useState(true)
  const [reconciling, setReconciling] = useState(false)

  const triggerReconcile = (): void => {
    if (reconciling) return
    setReconciling(true)
    window.quarksync?.triggerScan('remote')
    setTimeout(() => setReconciling(false), 2600)
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="conn-pill">
          <span
            className="dot"
            style={
              running
                ? { background: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-bg)' }
                : { background: 'var(--tx3)', boxShadow: 'none' }
            }
          />
          <span>
            {running ? '已连接' : '已暂停'} · OpenList 192.168.1.20:5244
          </span>
        </div>
        <span className="sep" />
        <span className="muted">/quark-backup</span>
      </div>

      <div className="topbar-right">
        <button
          className="btn ghost"
          title="重新扫描本地同步目录（Ctrl+R）"
          onClick={() => window.quarksync?.triggerScan('local')}
        >
          <Icon name="monitor" />
          扫描本地
        </button>
        <button
          className={`btn ghost${reconciling ? ' busy' : ''}`}
          title="立即对账远端（列出远端树并比对差异）"
          onClick={triggerReconcile}
          disabled={reconciling}
        >
          <Icon name="diff" />
          {reconciling ? '对账中…' : '对账远端'}
        </button>
        <button
          className={`btn${running ? ' primary' : ''}`}
          onClick={() => setRunning(!running)}
        >
          <Icon name={running ? 'pause' : 'play'} />
          {running ? '暂停同步' : '继续同步'}
        </button>
      </div>
    </header>
  )
}
