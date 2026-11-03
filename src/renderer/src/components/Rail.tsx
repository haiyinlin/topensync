import * as React from 'react'
import { Icon } from './Icon'
import { useAppStore } from '../store'
import logo from '../assets/logo.png'
import type { PageKey } from '../App'

interface RailProps {
  current: PageKey
  onNavigate: (key: PageKey) => void
}

interface NavEntry {
  key: PageKey
  label: string
  icon: string
  /** 徽章取哪一路真实计数 */
  badge?: 'queue' | 'diffs'
  badgeTone?: 'amber'
}

const GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: '同步',
    items: [
      { key: 'overview', label: '概览', icon: 'gauge' },
      { key: 'queue', label: '传输队列', icon: 'list', badge: 'queue' },
      { key: 'manifest', label: '文件清单', icon: 'files' },
      { key: 'reconcile', label: '远端对账', icon: 'diff', badge: 'diffs', badgeTone: 'amber' }
    ]
  },
  {
    label: '诊断',
    items: [
      { key: 'history', label: '同步历史', icon: 'clock' },
      { key: 'logs', label: '运行日志', icon: 'terminal' }
    ]
  },
  {
    label: '设置',
    items: [
      { key: 'connection', label: '连接与路径', icon: 'plug' },
      { key: 'transfer', label: '传输规则', icon: 'sliders' },
      { key: 'reconrule', label: '对账规则', icon: 'cloud-check' },
      { key: 'advanced', label: '高级', icon: 'cpu' }
    ]
  }
]

export function Rail({ current, onNavigate }: RailProps): React.JSX.Element {
  const tasks = useAppStore((s) => s.tasks)
  const diffs = useAppStore((s) => s.diffs)

  // 徽章数取真实值：队列里未完成的传输 + 未处置的对账差异
  // 「进行中」的口径与概览页、队列页一致：上传、哈希、下载都算。
  // 漏掉 downloading 时，正在拉远端文件的用户看到徽章不亮，会以为程序卡住了。
  const queueCount = tasks.filter(
    (t) =>
      t.state === 'queued' ||
      t.state === 'uploading' ||
      t.state === 'hashing' ||
      t.state === 'downloading'
  ).length
  const diffCount = diffs.filter((d) => !d.resolvedAt).length

  const badgeValue = (kind?: NavEntry['badge']): number | undefined => {
    if (kind === 'queue') return queueCount > 0 ? queueCount : undefined
    if (kind === 'diffs') return diffCount > 0 ? diffCount : undefined
    return undefined
  }

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <img className="brand-mark" src={logo} alt="TopenSync" />
          <span className="brand-name">TopenSync</span>
        </div>
        <button className="icon-btn" title="全局设置" onClick={() => onNavigate('connection')}>
          <Icon name="gear" />
        </button>
      </div>

      <nav className="rail-nav">
        {GROUPS.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => {
              const badge = badgeValue(item.badge)
              return (
                <a
                  key={item.key}
                  className={`nav-item${current === item.key ? ' active' : ''}`}
                  onClick={() => onNavigate(item.key)}
                >
                  <Icon name={item.icon} />
                  {item.label}
                  {badge !== undefined && (
                    <span className={`nav-badge${item.badgeTone ? ` ${item.badgeTone}` : ''}`}>
                      {badge}
                    </span>
                  )}
                </a>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="rail-foot">
        <a
          className={`nav-item${current === 'help' ? ' active' : ''}`}
          onClick={() => onNavigate('help')}
        >
          <Icon name="help" />
          帮助
        </a>
      </div>
    </aside>
  )
}
