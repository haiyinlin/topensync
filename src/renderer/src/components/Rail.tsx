import * as React from 'react'
import { Icon } from './Icon'
import type { PageKey } from '../App'

interface RailProps {
  current: PageKey
  onNavigate: (key: PageKey) => void
}

interface NavEntry {
  key: PageKey
  label: string
  icon: string
  badge?: number
  badgeTone?: 'amber'
}

const GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: '同步',
    items: [
      { key: 'overview', label: '概览', icon: 'gauge' },
      { key: 'queue', label: '传输队列', icon: 'list', badge: 23 },
      { key: 'manifest', label: '文件清单', icon: 'files' },
      { key: 'reconcile', label: '远端对账', icon: 'diff', badge: 3, badgeTone: 'amber' }
    ]
  },
  {
    label: '诊断',
    items: [{ key: 'logs', label: '运行日志', icon: 'terminal' }]
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
  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-name">QuarkSync</span>
        </div>
        <button className="icon-btn" title="全局设置">
          <Icon name="gear" />
        </button>
      </div>

      <div className="rail-search">
        <Icon name="search" />
        <input placeholder="搜索功能与设置" />
      </div>

      <nav className="rail-nav">
        {GROUPS.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => (
              <a
                key={item.key}
                className={`nav-item${current === item.key ? ' active' : ''}`}
                onClick={() => onNavigate(item.key)}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.badge !== undefined && (
                  <span className={`nav-badge${item.badgeTone ? ` ${item.badgeTone}` : ''}`}>
                    {item.badge}
                  </span>
                )}
              </a>
            ))}
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
