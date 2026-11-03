import * as React from 'react'
import { useEffect, useState } from 'react'
import { Rail } from './components/Rail'
import { TopBar, ScanProgressBar } from './components/TopBar'
import { Overview } from './pages/Overview'
import { Queue } from './pages/Queue'
import { ManifestPage } from './pages/Manifest'
import { Reconcile } from './pages/Reconcile'
import { Logs } from './pages/Logs'
import { History } from './pages/History'
import { Connection } from './pages/Connection'
import { TransferRules } from './pages/TransferRules'
import { ReconcileRules } from './pages/ReconcileRules'
import { Advanced } from './pages/Advanced'
import { Help } from './pages/Help'
import { useAppStore } from './store'

/**
 * 渲染进程根组件。
 *
 * 页面结构与视觉规范：
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
  | 'history'
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
  'history',
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
  const init = useAppStore((s) => s.init)

  /*
   * 首屏拉一次全量快照，并建立与主进程的事件订阅。
   *
   * init 现在会返回清理函数（退订 + 停轮询定时器），卸载时必须调用它——
   * 否则订阅会一直留在 ipcRenderer 上，日志会被追加两遍。
   *
   * 注意清理函数是异步拿到的：StrictMode 的第一次卸载发生在 init 还没
   * resolve 之前，那时还拿不到它，什么也没释放；真正兜底的是 init 内部的
   * 重复初始化保护（第二次调用会复用同一份订阅）。
   */
  useEffect(() => {
    let dispose: (() => void) | undefined
    void init()
      .then((d) => {
        dispose = d
      })
      .catch(() => {
        // init 内部已经把失败记进 lastError；这里只是防止 unhandled rejection
      })
    return () => dispose?.()
  }, [init])

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
        {/* 扫描进度：全局可见，用户在任意页面都能看到程序在忙什么 */}
        <ScanProgressBar />
        <div className="scroll">
          {page === 'overview' && <Overview onNavigate={navigate} />}
          {page === 'queue' && <Queue />}
          {page === 'manifest' && <ManifestPage onNavigate={navigate} />}
          {page === 'reconcile' && <Reconcile />}
          {page === 'history' && <History />}
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
