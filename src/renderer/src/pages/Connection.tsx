import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'

/**
 * 连接与路径：端点、凭据、路径映射，以及远端权限自检。
 *
 * 权限自检三项对应主进程真实探测的结果：
 * - 读取远端目录：POST /api/fs/list 能列出来
 * - 写入远端目录：能否创建目录
 * - 穿透目录缓存：refresh:true 能否成功（它要求目标目录写权限）
 */
export function Connection(): React.JSX.Element {
  const config = useAppStore((s) => s.config)
  const connection = useAppStore((s) => s.connection)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const recheckConnection = useAppStore((s) => s.recheckConnection)

  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:5244')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [syncRoot, setSyncRoot] = useState('')
  const [remoteRoot, setRemoteRoot] = useState('/quark-backup')
  const [trashRoot, setTrashRoot] = useState('_trash')
  const [excludeText, setExcludeText] = useState('')
  const [saved, setSaved] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!config) return
    setBaseUrl(config.openlist.baseUrl)
    setUsername(config.openlist.username)
    setPassword(config.openlist.password)
    setSyncRoot(config.syncRoot)
    setRemoteRoot(config.remoteRoot)
    setTrashRoot(config.trashRoot)
    setExcludeText(config.exclude.join('\n'))
  }, [config])

  const save = async (): Promise<void> => {
    await saveConfig({
      syncRoot,
      remoteRoot,
      trashRoot,
      exclude: excludeText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      openlist: { baseUrl, username, password }
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    await recheckConnection()
    setChecking(false)
  }

  /*
   * 四态，而不是三态。
   * connection 为 null 表示「主进程还没探测完」——这跟「探测完了，结论是未配置」
   * 是两回事，混为一谈就会出现用户说的「进来默认显示未配置」。
   */
  const connState: 'checking' | 'ok' | 'bad' | 'unset' =
    connection === null
      ? 'checking'
      : connection.reachable
        ? 'ok'
        : connection.configured
          ? 'bad'
          : 'unset'
  const connLabel =
    connState === 'checking'
      ? '检测中…'
      : connState === 'ok'
        ? '已连接'
        : connState === 'bad'
          ? '连接失败'
          : '未配置'

  const checkedAtText = connection?.checkedAt
    ? new Date(connection.checkedAt).toLocaleString('zh-CN', { hour12: false })
    : null

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>连接与路径</h1>
          <p className="sub">OpenList 端点、凭据与同步路径映射。凭据经系统密钥加密存储。</p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => void check()} disabled={checking}>
            {checking ? '检测中…' : '重新检测'}
          </button>
          <button className="btn primary" onClick={() => void save()}>
            {saved ? '已保存' : '保存'}
          </button>
        </div>
      </div>

      <div className="grid two">
        <div className="card form">
          <div className="card-head">
            <h2>OpenList</h2>
            <span
              className={`pill ${
                connState === 'ok' ? 'green' : connState === 'bad' ? 'red' : 'gray'
              }`}
            >
              {connLabel}
            </span>
          </div>
          <label className="field">
            <span>服务器地址</span>
            <div className="input">
              <Icon name="plug" />
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://192.168.1.20:5244"
              />
            </div>
            <em>内网 HTTP 直连，无需 TLS</em>
          </label>
          <label className="field">
            <span>用户名</span>
            <div className="input">
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
          </label>
          <label className="field">
            <span>密码</span>
            <div className="input">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="未设置"
              />
            </div>
            <em>使用 Electron safeStorage 加密后落盘</em>
          </label>
          <label className="field">
            <span>存储驱动</span>
            <div className="input">
              <input value="QuarkOpen (SVIP)" disabled />
            </div>
            <em>单文件上限 20 GB</em>
          </label>

          <div className="hr" />
          <div className="card-head" style={{ marginBottom: '8px' }}>
            <h2>远端权限自检</h2>
            <span
              className={`pill ${
                connState === 'unset'
                  ? 'gray'
                  : connection?.canRead && connection?.canWrite
                    ? 'green'
                    : 'amber'
              }`}
            >
              {connState === 'unset'
                ? '未检测'
                : connection?.canRead && connection?.canWrite
                  ? '全部通过'
                  : '存在缺口'}
            </span>
          </div>
          <div className="kv">
            <div className="kv-row">
              <span>读取远端目录</span>
              <b className={connection?.canRead ? 'ok' : 'bad'}>
                {connState === 'unset' ? '—' : connection?.canRead ? '通过' : '未通过'}
              </b>
            </div>
            <div className="kv-row">
              <span>写入远端目录</span>
              <b className={connection?.canWrite ? 'ok' : 'bad'}>
                {connState === 'unset' ? '—' : connection?.canWrite ? '通过' : '未通过'}
              </b>
            </div>
            <div className="kv-row">
              <span>穿透目录缓存</span>
              <b className={connection?.canWrite ? 'ok' : 'bad'}>
                {connState === 'unset' ? (
                  '—'
                ) : connection?.canWrite ? (
                  <>
                    通过 <em className="tiny">refresh:true 可用</em>
                  </>
                ) : (
                  '不可用'
                )}
              </b>
            </div>
            <div className="kv-row">
              <span>上次检测</span>
              <b>{checkedAtText ?? '尚未检测'}</b>
            </div>
          </div>
          {connection?.error && (
            <p className="warn-note">
              <Icon name="alert" />
              {connection.error}
            </p>
          )}
          <p className="tiny" style={{ marginTop: '9px' }}>
            对账需要「穿透目录缓存」权限（refresh:true），否则无法发现远端被外部删除。权限不足时对账会自动降级为只读扫描并在页面提示。
          </p>
        </div>

        <div className="card form">
          <div className="card-head">
            <h2>路径</h2>
          </div>
          <label className="field">
            <span>本地同步目录</span>
            <div className="input">
              <Icon name="folder" />
              <input
                value={syncRoot}
                onChange={(e) => setSyncRoot(e.target.value)}
                placeholder="C:\Users\...\Documents\SyncFolder"
              />
            </div>
            <em>留空则不启动本地监控</em>
          </label>
          <label className="field">
            <span>远端根目录</span>
            <div className="input">
              <Icon name="folder" />
              <input value={remoteRoot} onChange={(e) => setRemoteRoot(e.target.value)} />
            </div>
            <em>保留原有目录层级，OpenList 中可直接浏览</em>
          </label>
          <label className="field">
            <span>回收站目录</span>
            <div className="input">
              <Icon name="trash" />
              <input value={trashRoot} onChange={(e) => setTrashRoot(e.target.value)} />
            </div>
            <em>远程删除先移入此处，默认保留 7 天</em>
          </label>
          <label className="field">
            <span>排除规则</span>
            <textarea
              className="textarea mono"
              rows={4}
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              placeholder={'**/node_modules/**\n**/.git/**\n**/*.tmp\n~$*'}
            />
            <em>glob 语法，每行一条；Watcher 与 Planner 两层同时生效</em>
          </label>
        </div>
      </div>
    </section>
  )
}
