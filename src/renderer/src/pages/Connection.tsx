import * as React from 'react'
import { Icon } from '../components/Icon'

/** 连接与路径：端点、凭据、路径映射，以及远端权限自检。 */
export function Connection(): React.JSX.Element {
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>连接与路径</h1>
          <p className="sub">OpenList 端点、凭据与同步路径映射。凭据经系统密钥加密存储。</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card form">
          <div className="card-head">
            <h2>OpenList</h2>
            <span className="pill green">已连接</span>
          </div>
          <label className="field">
            <span>服务器地址</span>
            <div className="input">
              <Icon name="plug" />
              <input defaultValue="http://192.168.1.20:5244" />
            </div>
            <em>内网 HTTP 直连，无需 TLS</em>
          </label>
          <label className="field">
            <span>用户名</span>
            <div className="input">
              <input defaultValue="admin" />
            </div>
          </label>
          <label className="field">
            <span>密码</span>
            <div className="input">
              <input type="password" defaultValue="········" />
              <button className="icon-btn sm">
                <Icon name="eye" />
              </button>
            </div>
            <em>使用 Electron safeStorage 加密后落盘</em>
          </label>
          <label className="field">
            <span>存储驱动</span>
            <div className="input">
              <input defaultValue="QuarkOpen (SVIP)" disabled />
            </div>
            <em>单文件上限 20 GB</em>
          </label>

          <div className="hr" />
          <div className="card-head" style={{ marginBottom: '8px' }}>
            <h2>远端权限自检</h2>
            <span className="pill green">全部通过</span>
          </div>
          <div className="kv">
            <div className="kv-row">
              <span>读取远端目录</span>
              <b className="ok">通过</b>
            </div>
            <div className="kv-row">
              <span>写入远端目录</span>
              <b className="ok">通过</b>
            </div>
            <div className="kv-row">
              <span>穿透目录缓存</span>
              <b className="ok">
                通过 <em className="tiny">refresh:true 可用</em>
              </b>
            </div>
          </div>
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
              <input defaultValue="C:\Users\Administrator\Documents\SyncFolder" />
              <button className="btn tiny ghost">浏览…</button>
            </div>
          </label>
          <label className="field">
            <span>远端根目录</span>
            <div className="input">
              <Icon name="folder" />
              <input defaultValue="/quark-backup" />
            </div>
            <em>保留原有目录层级，OpenList 中可直接浏览</em>
          </label>
          <label className="field">
            <span>回收站目录</span>
            <div className="input">
              <Icon name="trash" />
              <input defaultValue="_trash" />
            </div>
            <em>远程删除先移入此处，默认保留 7 天</em>
          </label>
          <div className="field">
            <span>排除规则</span>
            <div className="textarea mono">
              {`**/node_modules/**
**/.git/**
**/*.tmp
~$*`}
            </div>
            <em>glob 语法，Watcher 与 Planner 两层同时生效</em>
          </div>
        </div>
      </div>
    </section>
  )
}
