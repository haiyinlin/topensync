import * as React from 'react'
import { Icon } from '../components/Icon'

/** 高级：本地清单维护与诊断选项。 */
export function Advanced(): React.JSX.Element {
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>高级</h1>
          <p className="sub">本地清单、缓存与诊断选项。</p>
        </div>
      </div>

      <div className="grid two">
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
              <b className="mono">0</b>
            </div>
            <div className="kv-row">
              <span>占用空间</span>
              <b className="mono">0 MB</b>
            </div>
            <div className="kv-row">
              <span>上次备份</span>
              <b className="mono">—</b>
            </div>
          </div>
          <div className="quick">
            <button className="quick-item">
              <Icon name="db" />
              <span>备份清单数据库</span>
              <Icon name="chevron" className="ic chev" />
            </button>
            <button className="quick-item">
              <Icon name="refresh" />
              <span>重建本地清单</span>
              <Icon name="chevron" className="ic chev" />
            </button>
            <button className="quick-item">
              <Icon name="trash" />
              <span>清理已删除记录</span>
              <Icon name="chevron" className="ic chev" />
            </button>
          </div>
        </div>

        <div className="card form">
          <div className="card-head">
            <h2>诊断</h2>
          </div>
          <label className="switch-row">
            <span>
              <b>详细日志</b>
              <em>记录每个文件的状态流转</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
          <label className="switch-row">
            <span>
              <b>启动即全量扫描</b>
              <em>关闭则仅处理增量变更</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
          <label className="switch-row">
            <span>
              <b>跟随符号链接</b>
              <em>Windows 下建议关闭，防止目录联接递归</em>
            </span>
            <span className="switch">
              <input type="checkbox" />
              <i />
            </span>
          </label>
          <label className="switch-row">
            <span>
              <b>跳过云占位文件</b>
              <em>OneDrive / 坚果云等重解析点占位符</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
          <label className="switch-row">
            <span>
              <b>开机自启</b>
              <em>登录 Windows 后静默驻留托盘</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
        </div>
      </div>
    </section>
  )
}
