import * as React from 'react'
import { Icon } from '../components/Icon'
import type { PageKey } from '../App'

/**
 * 帮助：真实可用的入口、状态图例与版本信息。
 *
 * 这一页曾经列过一整套键盘快捷键，而渲染进程一个都没实现——
 * 用户按了没反应，只会觉得软件坏了，所以整块拿掉了。
 * 同样道理：这里只保留**点了真的能到达某处**的入口，
 * 没有对应页面的说明（「秒传与去重」「常见问题」）宁可不放。
 */
export function Help(): React.JSX.Element {
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>帮助</h1>
          <p className="sub">常见问题与版本信息。</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card link-card">
          <div className="card-head">
            <h2>快速开始</h2>
          </div>
          <LinkRow icon="upload" title="首次配置向导" desc="连接 OpenList 并完成路径映射" to="connection" />
          <LinkRow icon="files" title="大文件与分片" desc="分片阈值与超限文件的处理" to="transfer" />
        </div>
        <div className="card link-card">
          <div className="card-head">
            <h2>排障</h2>
          </div>
          <LinkRow icon="terminal" title="查看运行日志" desc="定位失败任务与错误原因" to="logs" />
          <LinkRow icon="alert" title="导出诊断包" desc="包含清单、日志与配置快照" to="advanced" />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>状态说明</h2>
        </div>
        <div className="legend">
          <LegendRow tone="green" label="已同步" desc="远端已确认存在且大小一致" />
          <LegendRow tone="blue" label="等待" desc="已入队，等待上传" />
          <LegendRow tone="accent" label="上传中" desc="传输进行中，分片可续传" />
          <LegendRow tone="red" label="失败" desc="重试耗尽，需人工处理" />
          <LegendRow tone="amber" label="已删除" desc="本地已删除，远程在回收站" />
        </div>
        <div className="hr" />
        <div className="card-head" style={{ marginBottom: '10px' }}>
          <h2>对账差异</h2>
        </div>
        <div className="legend">
          <LegendRow tone="amber" label="远端缺失" desc="本地文件在远端不存在，将补传" />
          <LegendRow tone="purple" label="仅远端存在" desc="远端有本地无，默认只记录" />
          <LegendRow tone="orange" label="内容不符" desc="两侧大小不同，以本地为准" />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>两条扫描通道</h2>
        </div>
        <div className="rows">
          <div className="row">
            <Icon name="monitor" className="ic file accent" />
            <div className="row-main">
              <div className="row-title">本地扫描</div>
              <div className="row-sub">
                常驻监听本地目录，文件一变就进入上传队列。是同步的<b>主通道</b>。
              </div>
            </div>
          </div>
          <div className="row">
            <Icon name="diff" className="ic file blue" />
            <div className="row-main">
              <div className="row-title">远端对账</div>
              <div className="row-sub">
                周期性列举远端文件树，与本地清单比对。发现<b>远端被外部删除或改动</b>时补传——这是只扫本地发现不了的。
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card ver-card">
        <div className="ver-head">
          <span className="kv-k">版本</span>
          <span className="mono ver-txt">TopenSync v0.1.0 · dev</span>
        </div>
        <div className="hr" />
        <p className="note">
          <b className="warn">注意</b>：本程序为非官方客户端，通过 OpenList 的标准 HTTP 接口与夸克网盘交互，不包含任何绕过服务端校验的逻辑。当前处于开发阶段，请勿将其作为唯一的备份手段。
        </p>
      </div>
    </section>
  )
}

/**
 * 入口行：点击后必须真的能到某页。
 *
 * 走 hash 路由（App 监听 hashchange），不必把 onNavigate 一路传下来；
 * 没有对应页面的说明就不做成入口，点了没反应比没有更糟。
 */
function LinkRow({
  icon,
  title,
  desc,
  to
}: {
  icon: string
  title: string
  desc: string
  to: PageKey
}): React.JSX.Element {
  return (
    <button className="link-row" onClick={() => { location.hash = to }}>
      <span className="tile">
        <Icon name={icon} />
      </span>
      <span className="txt">
        <b>{title}</b>
        <em>{desc}</em>
      </span>
      <Icon name="chevron" className="ic chev" />
    </button>
  )
}

function LegendRow({
  tone,
  label,
  desc
}: {
  tone: string
  label: string
  desc: string
}): React.JSX.Element {
  return (
    <div className="lg">
      <span className={`pill ${tone}`}>{label}</span>
      <span>{desc}</span>
    </div>
  )
}
