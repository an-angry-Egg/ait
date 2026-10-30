import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const DIR = '.ait'
const FILE = 'bridge.json'

/**
 * 配对 token 写进项目目录，而不是全局配置：
 * 一个项目一份，切换项目即天然隔离，也避免多项目共用 token 时的越权风险。
 */
export function loadConfig(root) {
  const dir = join(root, DIR)
  const file = join(dir, FILE)

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed.token === 'string' && parsed.token) return parsed
    } catch {
      // 配置损坏就重建，不值得让启动失败
    }
  }

  const fresh = {
    token: randomBytes(12).toString('hex'),
    extensionId: null,
    port: null
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n', 'utf8')
  return fresh
}

export function saveConfig(root, config) {
  const dir = join(root, DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, FILE), JSON.stringify(config, null, 2) + '\n', 'utf8')
}

export function tasksDir(root) {
  const dir = join(root, DIR, 'tasks')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function logsFile(root) {
  return join(root, DIR, 'logs', 'app.log')
}
