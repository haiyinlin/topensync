import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'
import type { RemoteScanConfig } from '@shared/types'

/**
 * 对账规则：远端对账的周期、并发与差异处置策略。
 *
 * 「穿透服务端目录缓存」是这里的要害：
 * refresh:true 需要目标目录写权限，关闭后对账读到的只是服务端缓存，
 * 发现不了「远端被外部删除」——那是最危险的一类静默备份缺失。
 */
export function ReconcileRules(): React.JSX.Element {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)

  const [enabled, setEnabled] = useState(true)
  const [intervalHours, setIntervalHours] = useState(6)
  const [onStartup, setOnStartup] = useState(true)
  const [maxConcurrency, setMaxConcurrency] = useState(1)
  const [timeoutMinutes, setTimeoutMinutes] = useState(30)
  const [refresh, setRefresh] = useState(true)
  const [conflictPolicy, setConflictPolicy] = useState<RemoteScanConfig['conflictPolicy']>(
    'local-wins'
  )
  const [remoteOnlyPolicy, setRemoteOnlyPolicy] = useState<
    RemoteScanConfig['remoteOnlyPolicy']
  >('record-only')
  const [autoFixLimit, setAutoFixLimit] = useState(20)
  const [adoptByNameAndSize, setAdoptByNameAndSize] = useState(true)
  const [excludeText, setExcludeText] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!config) return
    const rs = config.remoteScan
    setEnabled(rs.enabled)
    setIntervalHours(rs.intervalHours)
    setOnStartup(rs.onStartup)
    setMaxConcurrency(rs.maxConcurrency)
    setTimeoutMinutes(rs.timeoutMinutes)
    setRefresh(rs.refresh)
    setConflictPolicy(rs.conflictPolicy)
    setRemoteOnlyPolicy(rs.remoteOnlyPolicy)
    setAutoFixLimit(rs.autoFixLimit)
    setAdoptByNameAndSize(rs.adoptByNameAndSize)
    setExcludeText((rs.exclude ?? []).join('\n'))
  }, [config])

  const save = async (): Promise<void> => {
    await saveConfig({
      remoteScan: {
        enabled,
        intervalHours,
        onStartup,
        maxConcurrency,
        timeoutMinutes,
        refresh,
        conflictPolicy,
        remoteOnlyPolicy,
        autoFixLimit,
        adoptByNameAndSize,
        // 空行忽略：文本框里留空行是自然编辑行为，不该变成一条空规则
        exclude: excludeText
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>对账规则</h1>
          <p className="sub">远端对账的周期、并发与差异处置策略。</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => void save()}>
            {saved ? '已保存' : '保存'}
          </button>
        </div>
      </div>

      <div className="grid two">
        <div className="card form">
          <div className="card-head">
            <h2>对账计划</h2>
            <span className={`pill ${enabled ? 'green' : 'gray'}`}>
              {enabled ? '已启用' : '已关闭'}
            </span>
          </div>
          <label className="switch-row">
            <span>
              <b>开启远端对账</b>
              <em>关闭后无法发现远端被外部删除或修改</em>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
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
              <input
                type="checkbox"
                checked={onStartup}
                onChange={(e) => setOnStartup(e.target.checked)}
              />
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
              <input
                type="checkbox"
                checked={refresh}
                onChange={(e) => setRefresh(e.target.checked)}
              />
              <i />
            </span>
          </label>
          <label className="field">
            <span>远端扫描排除项</span>
            <textarea
              className="textarea mono"
              rows={4}
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              placeholder={'_trash/**\n其他设备上传/**'}
            />
            <em>
              glob 语法，每行一条；作用于相对远端根目录的路径。这些路径不参与差异比对。
            </em>
          </label>
        </div>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>差异处置</h2>
        </div>
        <div className="radios">
          <label className="radio">
            <input
              type="radio"
              name="cp"
              checked={conflictPolicy === 'local-wins'}
              onChange={() => setConflictPolicy('local-wins')}
            />
            <span>
              <b>本地为准</b>
              <em>远端缺失自动重传，内容不符覆盖远端（推荐）</em>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="cp"
              checked={conflictPolicy === 'manual'}
              onChange={() => setConflictPolicy('manual')}
            />
            <span>
              <b>全部交由我确认</b>
              <em>只列出差异，任何修复都需手动触发</em>
            </span>
          </label>
        </div>
        <div className="hr" />
        <div className="radios">
          <label className="radio">
            <input
              type="radio"
              name="ro"
              checked={remoteOnlyPolicy === 'record-only'}
              onChange={() => setRemoteOnlyPolicy('record-only')}
            />
            <span>
              <b>仅远端存在的文件：只记录</b>
              <em>不删除也不下载，避免误删其他设备刚上传的内容（推荐）</em>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="ro"
              checked={remoteOnlyPolicy === 'pull'}
              onChange={() => setRemoteOnlyPolicy('pull')}
            />
            <span>
              <b>下载到本地</b>
              <em>远端多出的文件拉回同步目录</em>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="ro"
              checked={remoteOnlyPolicy === 'delete'}
              onChange={() => setRemoteOnlyPolicy('delete')}
            />
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
        <div className="hr" />
        <label className="switch-row">
          <span>
            <b>按「文件名 + 大小」认领远端已有文件</b>
            <em>
              远端已有同名同大小的文件时直接认定已同步，不再上传。
              关闭后这类文件一律重新上传。哈希去重不受影响。
            </em>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              checked={adoptByNameAndSize}
              onChange={(e) => setAdoptByNameAndSize(e.target.checked)}
            />
            <i />
          </span>
        </label>
        <p className="warn-note">
          <Icon name="shield" />
          认领只比对文件名与大小，<b>不校验内容</b>。因此认领出来的记录会标记为「仅大小」，
          需要时可对它们做深度校验（文件清单页 → 勾选 → 深度校验）确认内容是否真的一致。
          哈希去重比的是内容，永远准确，不受这个开关影响。
        </p>
        <p className="warn-note">
          <Icon name="shield" />
          远端对账只做单向校正——从远端下载文件到本地属于独立动作，始终需要你显式确认。
        </p>
      </div>
    </section>
  )
}
