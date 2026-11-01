import * as React from 'react'
import { useState } from 'react'
import { Icon } from '../components/Icon'

/** 传输规则：并发、阈值与删除策略。 */
export function TransferRules(): React.JSX.Element {
  const [uploadConcurrency, setUploadConcurrency] = useState(4)
  const [hashConcurrency, setHashConcurrency] = useState(2)
  const [chunkConcurrency, setChunkConcurrency] = useState(2)
  const [singlePutMB, setSinglePutMB] = useState(8)
  const [quarkMaxGB, setQuarkMaxGB] = useState(20)
  const [deleteLimit, setDeleteLimit] = useState(200)
  const [deleteBytesGB, setDeleteBytesGB] = useState(10)

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>传输规则</h1>
          <p className="sub">并发、阈值与删除策略。</p>
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
              <button>不校验</button>
              <button className="active">校验大小</button>
              <button>校验哈希</button>
            </div>
          </label>
        </div>
      </div>

      <div className="card form">
        <div className="card-head">
          <h2>删除策略</h2>
        </div>
        <div className="radios">
          <label className="radio">
            <input type="radio" name="dp" defaultChecked />
            <span>
              <b>移入回收站</b>
              <em>远程文件先移动到 _trash/，可恢复（推荐）</em>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="dp" />
            <span>
              <b>直接删除</b>
              <em>立即从夸克网盘移除，不可恢复</em>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="dp" />
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
