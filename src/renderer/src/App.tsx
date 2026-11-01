import * as React from 'react'
import { useEffect, useState } from 'react'
import { Rail } from './components/Rail'
import { TopBar } from './components/TopBar'
import { Overview } from './pages/Overview'
import { Queue } from './pages/Queue'
import { ManifestPage } from './pages/Manifest'
import { Reconcile } from './pages/Reconcile'
import { Logs } from './pages/Logs'
import { Connection } from './pages/Connection'
import { TransferRules } from './pages/TransferRules'
import { ReconcileRules } from './pages/ReconcileRules'
import { Advanced } from './pages/Advanced'
import { Help } from './pages/Help'

/**
 * 渲染进程根组件。
 *
 * 页面结构与视觉规范见《计划.md》§11；
 * 静态视觉基准见仓库根目录 ui-prototype/（浏览器可直接打开对照）。
 *
 * 导航分组：
 *   同步 → 概览 / 传输队列 / 文件清单 / 远端对账
 *   诊断 → 运行日志
 *   设置 → 连接与路径 / 传输规则 / 对账规则 / 高级
 *   底部 → 帮助
 */
export type PageKey =
  | 'overview'
  | 'queue'
  | 'manifest'
  | 'reconcile'
  | 'logs'
  | 'connection'
  | 'transfer'
  | 'reconrule'
  | 'advanced'
  | 'help'

const PAGES: PageKey[] = [
  'overview',
  'queue',
  'manifest',
  'reconcile',
  'logs',
  'connection',
  'transfer',
  'reconrule',
  'advanced',
  'help'
]

function readHash(): PageKey {
  const raw = location.hash.replace('#', '') as PageKey
  return PAGES.includes(raw) ? raw : 'overview'
}

export function App(): React.JSX.Element {
  const [page, setPage] = useState<PageKey>(readHash)

  useEffect(() => {
    const onHash = (): void => setPage(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = (key: PageKey): void => {
    location.hash = key
    setPage(key)
  }

  return (
    <div className="app">
      <Rail current={page} onNavigate={navigate} />
      <main className="main">
        <TopBar />
        <div className="scroll">
          {page === 'overview' && <Overview onNavigate={navigate} />}
          {page === 'queue' && <Queue />}
          {page === 'manifest' && <ManifestPage onNavigate={navigate} />}
          {page === 'reconcile' && <Reconcile />}
          {page === 'logs' && <Logs />}
          {page === 'connection' && <Connection />}
          {page === 'transfer' && <TransferRules />}
          {page === 'reconrule' && <ReconcileRules />}
          {page === 'advanced' && <Advanced />}
          {page === 'help' && <Help />}
        </div>
      </main>
    </div>
  )
}
