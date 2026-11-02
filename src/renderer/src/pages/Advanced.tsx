import * as React from 'react'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'

/**
 * 高级：本地清单与路径信息。
 *
 * 清单相关的数字全部取自真实状态——写死的数字会让人误以为
 * 备份是好的，而那恰恰是最危险的误导。
 *
 * 这里只放「读得到真相」的东西：曾经有一组诊断开关（详细日志、
 * 跟随符号链接……）没有绑定任何配置项，拨了跟没拨一样，
 * 只会让人以为软件坏了，所以整块拿掉了。
 */
export function Advanced(): React.JSX.Element {
  const stats = useAppStore((s) => s.stats)
  const files = useAppStore((s) => s.files)
  const config = useAppStore((s) => s.config)
  const exportDiagnostics = useAppStore((s) => s.exportDiagnostics)
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')

  const totalFiles = stats?.totalFiles ?? 0
  const syncedFiles = stats?.synced ?? 0
  const failedFiles = stats?.failed ?? 0
  const lastVerify = files.reduce((max, f) => Math.max(max, f.lastVerifyAt ?? 0), 0)

  const doExport = async (): Promise<void> => {
    if (exportState === 'busy') return
    setExportState('busy')
    const path = await exportDiagnostics()
    setExportState(path ? 'ok' : 'fail')
    if (path) setTimeout(() => setExportState('idle'), 6000)
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>高级</h1>
          <p className="sub">本地清单、路径与诊断包导出。</p>
        </div>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>本地清单</h2>
        </div>
        <div className="kv">
          <div className="kv-row">
            <span>数据库</span>
            <b className="mono">node:sqlite (WAL)</b>
          </div>
          <div className="kv-row">
            <span>清单条目</span>
            <b className="mono">{totalFiles}</b>
          </div>
          <div className="kv-row">
            <span>已同步</span>
            <b className="mono">{syncedFiles}</b>
          </div>
          <div className="kv-row">
            <span>失败</span>
            <b className="mono">{failedFiles}</b>
          </div>
          <div className="kv-row">
            <span>上次校验</span>
            <b className="mono">
              {lastVerify ? new Date(lastVerify).toLocaleString('zh-CN') : '—'}
            </b>
          </div>
        </div>
        <div className="quick">
          <button className="quick-item" onClick={() => void doExport()} disabled={exportState === 'busy'}>
            <Icon name="db" />
            <span>
              {exportState === 'busy'
                ? '正在打包…'
                : exportState === 'ok'
                  ? '诊断包已导出'
                  : exportState === 'fail'
                    ? '导出失败'
                    : '导出诊断包'}
            </span>
            <Icon name="chevron" className="ic chev" />
          </button>
        </div>
        <p className="warn-note">
          <Icon name="alert" />
          诊断包包含配置（密码已脱敏）、日志与清单统计，可直接发给他人排查问题。
        </p>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>路径</h2>
        </div>
        <div className="kv">
          <div className="kv-row">
            <span>同步目录</span>
            <b className="mono break">{config?.syncRoot || '(未配置)'}</b>
          </div>
          <div className="kv-row">
            <span>远端根目录</span>
            <b className="mono">{config?.remoteRoot || '—'}</b>
          </div>
          <div className="kv-row">
            <span>OpenList 地址</span>
            <b className="mono break">{config?.openlist.baseUrl || '—'}</b>
          </div>
        </div>
      </div>
    </section>
  )
}
