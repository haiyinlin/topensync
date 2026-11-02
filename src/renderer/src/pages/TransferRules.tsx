import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAppStore } from '../store'
import type { AppConfig, DeletePolicy } from '@shared/types'

/**
 * 传输规则：并发、阈值与删除策略。
 *
 * 控件绑定真实配置；改动后需显式保存——滑块拖动过程中不适合每帧落盘。
 */
export function TransferRules(): React.JSX.Element {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)

  const [uploadConcurrency, setUploadConcurrency] = useState(4)
  const [hashConcurrency, setHashConcurrency] = useState(2)
  const [chunkConcurrency, setChunkConcurrency] = useState(2)
  const [singlePutMB, setSinglePutMB] = useState(8)
  const [quarkMaxGB, setQuarkMaxGB] = useState(20)
  const [verifyMode, setVerifyMode] = useState<AppConfig['verifyMode']>('size')
  const [deletePolicy, setDeletePolicy] = useState<DeletePolicy>('trash')
  const [deleteLimit, setDeleteLimit] = useState(200)
  const [deleteBytesGB, setDeleteBytesGB] = useState(10)
  const [syncEmptyDirs, setSyncEmptyDirs] = useState(false)
  const [detectRenames, setDetectRenames] = useState(true)
  const [renameWindowMs, setRenameWindowMs] = useState(5000)
  const [saved, setSaved] = useState(false)

  // 首次拿到配置时回填控件
  useEffect(() => {
    if (!config) return
    setUploadConcurrency(config.uploadConcurrency)
    setHashConcurrency(config.hashConcurrency)
    setChunkConcurrency(config.chunkConcurrency)
    setSinglePutMB(Math.round(config.singlePutMaxBytes / 1024 / 1024))
    setQuarkMaxGB(Math.round(config.quarkMaxFileBytes / 1024 / 1024 / 1024))
    setVerifyMode(config.verifyMode)
    setDeletePolicy(config.deletePolicy)
    setDeleteLimit(config.maxDeletesPerRun)
    setDeleteBytesGB(Math.round(config.maxDeleteBytesPerRun / 1024 / 1024 / 1024))
    setSyncEmptyDirs(config.syncEmptyDirs)
    setDetectRenames(config.detectRenames)
    setRenameWindowMs(config.renameWindowMs)
  }, [config])

  const save = async (): Promise<void> => {
    await saveConfig({
      uploadConcurrency,
      hashConcurrency,
      chunkConcurrency,
      singlePutMaxBytes: Math.round(singlePutMB * 1024 * 1024),
      quarkMaxFileBytes: Math.round(quarkMaxGB * 1024 * 1024 * 1024),
      verifyMode,
      deletePolicy,
      maxDeletesPerRun: deleteLimit,
      maxDeleteBytesPerRun: Math.round(deleteBytesGB * 1024 * 1024 * 1024),
      syncEmptyDirs,
      detectRenames,
      renameWindowMs
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>传输规则</h1>
          <p className="sub">并发、阈值与删除策略。</p>
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
            <h2>并发</h2>
          </div>
          <label className="field">
            <span>
              上传并发数 <b className="mono val">{uploadConcurrency}</b>
            </span>
            <input
              type="range"
              min={1}
              max={8}
              value={uploadConcurrency}
              className="range"
              onChange={(e) => setUploadConcurrency(Number(e.target.value))}
            />
            <em>夸克侧上行按账号共享，提高并发不增带宽，仅增大风控概率</em>
          </label>
          <label className="field">
            <span>
              哈希并发数 <b className="mono val">{hashConcurrency}</b>
            </span>
            <input
              type="range"
              min={1}
              max={6}
              value={hashConcurrency}
              className="range"
              onChange={(e) => setHashConcurrency(Number(e.target.value))}
            />
            <em>CPU 密集，超过 4 收益有限</em>
          </label>
          <label className="field">
            <span>
              单文件分片并发 <b className="mono val">{chunkConcurrency}</b>
            </span>
            <input
              type="range"
              min={1}
              max={4}
              value={chunkConcurrency}
              className="range"
              onChange={(e) => setChunkConcurrency(Number(e.target.value))}
            />
            <em>过高会触发服务端窗口 429</em>
          </label>
        </div>

        <div className="card form">
          <div className="card-head">
            <h2>阈值</h2>
          </div>
          <label className="field">
            <span>
              单次上传上限 <b className="mono val">{singlePutMB} MB</b>
            </span>
            <div className="input narrow">
              <input
                value={singlePutMB}
                onChange={(e) => setSinglePutMB(Number(e.target.value))}
              />
              <span className="unit">MB</span>
            </div>
            <em>超过此大小改走分片上传，以支持断点续传</em>
          </label>
          <label className="field">
            <span>
              夸克单文件上限 <b className="mono val">{quarkMaxGB} GB</b>
            </span>
            <div className="input narrow">
              <input value={quarkMaxGB} onChange={(e) => setQuarkMaxGB(Number(e.target.value))} />
              <span className="unit">GB</span>
            </div>
            <em>超过此值的文件将标记为超限并跳过告警</em>
          </label>
          <label className="field">
            <span>校验模式</span>
            <div className="seg">
              <button
                className={verifyMode === 'none' ? 'active' : ''}
                onClick={() => setVerifyMode('none')}
              >
                不校验
              </button>
              <button
                className={verifyMode === 'size' ? 'active' : ''}
                onClick={() => setVerifyMode('size')}
              >
                校验大小
              </button>
              <button
                className={verifyMode === 'hash' ? 'active' : ''}
                onClick={() => setVerifyMode('hash')}
              >
                校验哈希
              </button>
            </div>
            <em>
              上传成功后回读远端确认内容。哈希模式需下载远端重算，流量成本与文件大小成正比。
            </em>
          </label>
        </div>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>目录与重命名</h2>
        </div>
        <label className="switch-row">
          <span>
            <b>同步空目录</b>
            <em>本地没有文件的目录也在远端建出来</em>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              checked={syncEmptyDirs}
              onChange={(e) => setSyncEmptyDirs(e.target.checked)}
            />
            <i />
          </span>
        </label>
        <label className="switch-row">
          <span>
            <b>识别重命名</b>
            <em>改名时远端移动而非删除加重传，省一次完整上行</em>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              checked={detectRenames}
              onChange={(e) => setDetectRenames(e.target.checked)}
            />
            <i />
          </span>
        </label>
        <label className="field">
          <span>
            重命名判定窗口 <b className="mono val">{renameWindowMs}</b> 毫秒
          </span>
          <div className="input narrow">
            <input
              value={renameWindowMs}
              onChange={(e) => setRenameWindowMs(Number(e.target.value))}
            />
            <span className="unit">ms</span>
          </div>
          <em>
            删除与新增两条事件的间隔超过此值就不再视为重命名。期间远端的删除会推迟执行。
          </em>
        </label>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>删除策略</h2>
        </div>
        <div className="radios">
          <label className="radio">
            <input
              type="radio"
              name="dp"
              checked={deletePolicy === 'trash'}
              onChange={() => setDeletePolicy('trash')}
            />
            <span>
              <b>移入回收站</b>
              <em>远程文件先移动到 _trash/，可恢复（推荐）</em>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="dp"
              checked={deletePolicy === 'delete'}
              onChange={() => setDeletePolicy('delete')}
            />
            <span>
              <b>直接删除</b>
              <em>立即从夸克网盘移除，不可恢复</em>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="dp"
              checked={deletePolicy === 'keep'}
              onChange={() => setDeletePolicy('keep')}
            />
            <span>
              <b>保留远程</b>
              <em>本地删除不反映到远端（归档语义）</em>
            </span>
          </label>
        </div>
        <div className="hr" />
        <div className="grid two">
          <label className="field">
            <span>单次会话最大删除数</span>
            <div className="input">
              <input value={deleteLimit} onChange={(e) => setDeleteLimit(Number(e.target.value))} />
            </div>
          </label>
          <label className="field">
            <span>单次会话最大删除量</span>
            <div className="input narrow">
              <input
                value={deleteBytesGB}
                onChange={(e) => setDeleteBytesGB(Number(e.target.value))}
              />
              <span className="unit">GB</span>
            </div>
          </label>
        </div>
        <p className="warn-note">
          <Icon name="alert" />
          超过熔断阈值将暂停删除队列并告警，防止误删风暴。
        </p>
      </div>
    </section>
  )
}
