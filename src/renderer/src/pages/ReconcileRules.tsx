import * as React from 'react'
import { useState } from 'react'
import { Icon } from '../components/Icon'

/** 对账规则：远端对账的周期、并发与差异处置策略。 */
export function ReconcileRules(): React.JSX.Element {
  const [intervalHours, setIntervalHours] = useState(6)
  const [maxConcurrency, setMaxConcurrency] = useState(1)
  const [timeoutMinutes, setTimeoutMinutes] = useState(30)
  const [autoFixLimit, setAutoFixLimit] = useState(20)

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>对账规则</h1>
          <p className="sub">远端对账的周期、并发与差异处置策略。</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card form">
          <div className="card-head">
            <h2>对账计划</h2>
            <span className="pill green">已启用</span>
          </div>
          <label className="switch-row">
            <span>
              <b>开启远端对账</b>
              <em>关闭后无法发现远端被外部删除或修改</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
          <label className="field">
            <span>
              对账周期 <b className="mono val">{intervalHours}</b> 小时
            </span>
            <input
              type="range"
              min={1}
              max={24}
              value={intervalHours}
              className="range"
              onChange={(e) => setIntervalHours(Number(e.target.value))}
            />
            <em>过于频繁会持续消耗夸克 API 配额并抬高风控概率</em>
          </label>
          <label className="switch-row">
            <span>
              <b>启动后立即对账一次</b>
              <em>异步执行，不阻塞启动</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
          <label className="field">
            <span>单次对账超时</span>
            <div className="input narrow">
              <input
                value={timeoutMinutes}
                onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
              />
              <span className="unit">分钟</span>
            </div>
            <em>超时则保留剩余目录到下一轮，并提示未完成</em>
          </label>
        </div>

        <div className="card form">
          <div className="card-head">
            <h2>遍历与并发</h2>
          </div>
          <label className="field">
            <span>
              目录列举并发 <b className="mono val">{maxConcurrency}</b>
            </span>
            <input
              type="range"
              min={1}
              max={4}
              value={maxConcurrency}
              className="range"
              onChange={(e) => setMaxConcurrency(Number(e.target.value))}
            />
            <em>夸克驱动逐目录发 API，并发不会更快，只会招致风控</em>
          </label>
          <label className="switch-row">
            <span>
              <b>穿透服务端目录缓存</b>
              <em>refresh:true，否则看不到外部删除</em>
            </span>
            <span className="switch">
              <input type="checkbox" defaultChecked />
              <i />
            </span>
          </label>
          <div className="field">
            <span>远端扫描排除项</span>
            <div className="textarea mono">
              {`_trash/**
其他设备上传/**`}
            </div>
            <em>这些路径不会参与差异比对</em>
          </div>
        </div>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>差异处置</h2>
        </div>
        <div className="radios">
          <label className="radio">
            <input type="radio" name="cp" defaultChecked />
            <span>
              <b>本地为准</b>
              <em>远端缺失自动重传，内容不符覆盖远端（推荐）</em>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="cp" />
            <span>
              <b>全部交由我确认</b>
              <em>只列出差异，任何修复都需手动触发</em>
            </span>
          </label>
        </div>
        <div className="hr" />
        <div className="radios">
          <label className="radio">
            <input type="radio" name="ro" defaultChecked />
            <span>
              <b>仅远端存在的文件：只记录</b>
              <em>不删除也不下载，避免误删其他设备刚上传的内容（推荐）</em>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="ro" />
            <span>
              <b>下载到本地</b>
              <em>远端多出的文件拉回同步目录</em>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="ro" />
            <span>
              <b>移入回收站</b>
              <em>远端多出的文件移入 _trash/，破坏性操作</em>
            </span>
          </label>
        </div>
        <div className="hr" />
        <label className="field">
          <span>
            单次自动修复上限 <b className="mono val">{autoFixLimit}</b> 个文件
          </span>
          <div className="input narrow">
            <input value={autoFixLimit} onChange={(e) => setAutoFixLimit(Number(e.target.value))} />
            <span className="unit">个</span>
          </div>
          <em>超过则只记录差异并在对账页列出，防止一次对账引发大批重传</em>
        </label>
        <p className="warn-note">
          <Icon name="shield" />
          远端对账只做单向校正——从远端下载文件到本地属于独立动作，始终需要你显式确认。
        </p>
      </div>
    </section>
  )
}
