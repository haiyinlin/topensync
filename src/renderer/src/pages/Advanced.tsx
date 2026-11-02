import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'
import { formatSize } from '../format'

/**
 * 高级：本地清单、存储与路径信息。
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
  const getStorageInfo = useAppStore((s) => s.getStorageInfo)
  const clearCache = useAppStore((s) => s.clearCache)
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const [storage, setStorage] = useState<import('@shared/types').StorageInfo | null>(null)
  const [cacheState, setCacheState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const [cacheResult, setCacheResult] = useState<string | null>(null)

  const totalFiles = stats?.totalFiles ?? 0
  const syncedFiles = stats?.synced ?? 0
  const failedFiles = stats?.failed ?? 0
  const lastVerify = files.reduce((max, f) => Math.max(max, f.lastVerifyAt ?? 0), 0)

  // 进入页面读一次存储占用
  useEffect(() => {
    void getStorageInfo().then((info) => info && setStorage(info))
  }, [getStorageInfo])

  const doExport = async (): Promise<void> => {
    if (exportState === 'busy') return
    setExportState('busy')
    const path = await exportDiagnostics()
    setExportState(path ? 'ok' : 'fail')
    if (path) setTimeout(() => setExportState('idle'), 6000)
  }

  const doClearCache = async (): Promise<void> => {
    if (cacheState === 'busy') return
    setCacheState('busy')
    setCacheResult(null)
    const res = await clearCache()
    if (res) {
      setCacheResult(
        res.failedDirs.length > 0
          ? `已释放 ${formatSize(res.freedBytes)}（${res.failedDirs.length} 个目录被占用未清理）`
          : `已释放 ${formatSize(res.freedBytes)}`
      )
      setCacheState('ok')
    } else {
      setCacheState('fail')
    }
    // 清完刷新占用数字
    const info = await getStorageInfo()
    if (info) setStorage(info)
    if (res && res.failedDirs.length === 0) setTimeout(() => setCacheState('idle'), 6000)
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>高级</h1>
          <p className="sub">本地清单、存储占用、路径与诊断包导出。</p>
        </div>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>本地清单</h2>
        </div>
        <div className="kv">
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
          <h2>存储与缓存</h2>
        </div>
        <div className="kv">
          <div className="kv-row">
            <span>数据库</span>
            <b className="mono">{storage ? formatSize(storage.databaseBytes) : '…'}</b>
          </div>
          {storage?.databaseFiles.map((f) => (
            <div className="kv-row" key={f.name}>
              <span className="indent">{f.name}</span>
              <b className="mono dim">{formatSize(f.bytes)}</b>
            </div>
          ))}
          <div className="kv-row">
            <span>缓存</span>
            <b className="mono">{storage ? formatSize(storage.cacheBytes) : '…'}</b>
          </div>
          {storage?.cacheDirs.map((d) => (
            <div className="kv-row" key={d.name}>
              <span className="indent">{d.name}</span>
              <b className="mono dim">
                {formatSize(d.bytes)}
                {d.fileCount > 0 && <span className="dim"> · {d.fileCount} 项</span>}
              </b>
            </div>
          ))}
          <div className="kv-row">
            <span>诊断包</span>
            <b className="mono">{storage ? formatSize(storage.diagnosticsBytes) : '…'}</b>
          </div>
        </div>
        <div className="quick">
          <button
            className="quick-item"
            onClick={() => void doClearCache()}
            disabled={cacheState === 'busy' || !storage || storage.cacheBytes === 0}
          >
            <Icon name="trash" />
            <span>
              {cacheState === 'busy'
                ? '正在清除…'
                : cacheState === 'ok'
                  ? cacheResult ?? '缓存已清除'
                  : cacheState === 'fail'
                    ? '清除失败'
                    : '清除缓存'}
            </span>
            <Icon name="chevron" className="ic chev" />
          </button>
        </div>
        {cacheResult && cacheState === 'ok' && (
          <p className="warn-note ok-note">
            <Icon name="check" />
            {cacheResult}
          </p>
        )}
        <p className="warn-note">
          <Icon name="alert" />
          缓存是运行时提速用的临时数据，清除安全（下次启动自动重建）；数据库是同步清单，
          清除后需重新全盘扫描，故不提供删除。
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
          <div className="kv-row">
            <span>数据目录</span>
            <b className="mono break">{storage?.dataDir || '…'}</b>
          </div>
        </div>
      </div>
    </section>
  )
}
