import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { AppConfig } from '@shared/types'

/**
 * 配置持久化。
 *
 * 凭据（OpenList 密码）经 Electron safeStorage 加密后落盘，
 * 密文与明文同文件但以独立字段保存，绝不写明文（计划书 §10）。
 */

const CONFIG_FILE = 'config.json'

/** 默认配置：与计划书 §10 的配置块一致 */
export const DEFAULT_CONFIG: AppConfig = {
  syncRoot: '',
  openlist: {
    baseUrl: 'http://127.0.0.1:5244',
    username: '',
    password: ''
  },
  remoteRoot: '/quark-backup',
  hashConcurrency: 2,
  uploadConcurrency: 4,
  singlePutMaxBytes: 8 * 1024 * 1024,
  chunkConcurrency: 2,
  deletePolicy: 'trash',
  trashRoot: '_trash',
  maxDeletesPerRun: 200,
  maxDeleteBytesPerRun: 10 * 1024 * 1024 * 1024,
  retry: { maxAttempts: 3, baseDelayMs: 1000 },
  exclude: ['**/node_modules/**', '**/.git/**', '**/*.tmp', '~$*'],
  verifyMode: 'size',
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  remoteScan: {
    enabled: true,
    intervalHours: 6,
    onStartup: true,
    refresh: true,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20
  }
}

/** 磁盘上的实际结构：密码字段是密文 */
interface StoredConfig extends Omit<AppConfig, 'openlist'> {
  openlist: Omit<AppConfig['openlist'], 'password'> & {
    /** base64 密文；空字符串表示未设置 */
    password: string
  }
}

function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

/** safeStorage 在部分 Linux 环境不可用；Windows 上始终可用 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (!encryptionAvailable()) {
    // 降级：无法加密时不落盘明文，交由上层提示用户
    throw new Error('系统密钥库不可用，无法安全存储凭据')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(cipher: string): string {
  if (!cipher) return ''
  if (!encryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    return ''
  }
}

export function loadConfig(): AppConfig {
  const path = configPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredConfig
    const merged: AppConfig = {
      ...DEFAULT_CONFIG,
      ...raw,
      openlist: {
        ...DEFAULT_CONFIG.openlist,
        ...raw.openlist,
        password: decryptSecret(raw.openlist?.password ?? '')
      },
      remoteScan: { ...DEFAULT_CONFIG.remoteScan, ...(raw.remoteScan ?? {}) }
    }
    return merged
  } catch {
    // 配置损坏时回退默认值，不阻断启动
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })

  const stored: StoredConfig = {
    ...config,
    openlist: {
      ...config.openlist,
      password: encryptSecret(config.openlist.password)
    }
  }
  writeFileSync(path, JSON.stringify(stored, null, 2), 'utf8')
}
