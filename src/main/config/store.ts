import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { AppConfig } from '@shared/types'

/**
 * 配置持久化。
 *
 * 凭据（OpenList 密码）经 Electron safeStorage 加密后落盘，
 * 密文与明文同文件但以独立字段保存，绝不写明文。
 */

const CONFIG_FILE = 'config.json'

/** 默认配置：各配置块的出厂默认值 */
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
  verifyHashMaxBytes: 64 * 1024 * 1024,
  quarkMaxFileBytes: 20 * 1024 * 1024 * 1024,
  syncEmptyDirs: false,
  detectRenames: true,
  renameWindowMs: 5000,
  remoteScan: {
    enabled: true,
    intervalHours: 6,
    onStartup: true,
    refresh: true,
    maxConcurrency: 1,
    timeoutMinutes: 30,
    conflictPolicy: 'local-wins',
    remoteOnlyPolicy: 'record-only',
    autoFixLimit: 20,
    // 默认开启「同名 + 同大小」认领：这是「换了设备/清了 userData 就整批重传」的解法。
    // 它不校验内容，所以认领出来的记录会打上 verify_level='size' 标记，
    // 需要时可对它们做深度校验。
    adoptByNameAndSize: true,
    exclude: ['_trash/**', '@eadir/**', '**/.DS_Store']
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

/**
 * 路径归一化：去掉首尾空白。
 *
 * 为什么要 trim：路径首尾的空白在界面上**完全不可见**，
 * 却会改变它在文件系统/远端存储里的实际含义。
 *
 * 实测踩过的坑：远端根配成 `/qh/qh/download/photo/照片备份/公司 `（尾部一个空格），
 * 应用便把整批文件传进了新建的「公司␣」目录，而用户原有的「公司」目录原封不动——
 * 夸克侧出现两个「公司」，同一批照片传了两遍。
 * 界面上看不出来（空格不可见），只有去网盘里翻才能发现。
 *
 * 所以路径一律在入口 trim 掉首尾空白，不让「看不见的字符」改变目标位置。
 */
function normalizePath(value: string): string {
  return value.trim()
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
    // 读出来时也归一化：老配置可能存着带空白的路径
    return normalizeConfig(merged)
  } catch {
    // 配置损坏时回退默认值，不阻断启动
    return { ...DEFAULT_CONFIG }
  }
}

/** 对配置里的路径字段做归一化 */
export function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    syncRoot: normalizePath(config.syncRoot),
    remoteRoot: normalizePath(config.remoteRoot),
    trashRoot: normalizePath(config.trashRoot),
    openlist: {
      ...config.openlist,
      baseUrl: normalizePath(config.openlist.baseUrl),
      username: normalizePath(config.openlist.username)
    }
  }
}

export function saveConfig(config: AppConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })

  // 落盘前再归一化一次：路径带首尾空白会静默改变目标位置
  const normalized = normalizeConfig(config)

  const stored: StoredConfig = {
    ...normalized,
    openlist: {
      ...normalized.openlist,
      password: encryptSecret(normalized.openlist.password)
    }
  }
  writeFileSync(path, JSON.stringify(stored, null, 2), 'utf8')
}
