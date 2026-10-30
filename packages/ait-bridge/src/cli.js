import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import aitPlugin from '@ait/vite-plugin'
import { startBridge } from './server.js'
import { loadConfig, saveConfig, tasksDir, logsFile } from './config.js'

const HELP = `
ait —— 在页面上画个圈，说一句，改动落到源码上

用法：
  npx ait [选项]

选项：
  --port <n>        桥接服务起始端口（默认 5198，被占用则递增）
  --open            启动后自动打开浏览器
  --reset-token     重新生成配对 token
  -h, --help        显示帮助

启动后：
  1. 浏览器打开输出的页面地址
  2. 在扩展的选项页填入此处打印的 token
  3. 画个圈，说一句
`

function parseArgs(argv) {
  const out = { port: 5198, open: false, resetToken: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') out.help = true
    else if (arg === '--open') out.open = true
    else if (arg === '--reset-token') out.resetToken = true
    else if (arg === '--port') out.port = Number(argv[++i]) || 5198
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7)) || 5198
  }
  return out
}

function resolveVite(root) {
  const require = createRequire(join(root, 'package.json'))
  try {
    return require.resolve('vite')
  } catch {
    return null
  }
}

function readProjectMeta(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return {
      name: pkg.name || 'unnamed',
      root,
      framework: pkg.dependencies?.vue || pkg.devDependencies?.vue ? 'vue' : 'unknown'
    }
  } catch {
    return { name: 'unnamed', root, framework: 'unknown' }
  }
}

/** 把任务落盘，便于事后复盘「它到底收到了什么」 */
async function persistTask(root, task) {
  const dir = tasksDir(root)
  const file = join(dir, `${task.taskId}.json`)
  writeFileSync(file, JSON.stringify(task, null, 2) + '\n', 'utf8')
  return file
}

/** 按 trace id 从项目日志里捞相关行（M6 的读侧，先实现最直接的一层） */
function collectLogs(root, task, limit = 10) {
  const file = logsFile(root)
  if (!existsSync(file)) return []

  const traces = new Set((task.traces || []).map((t) => t.trace_id).filter(Boolean))
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)

  const matched = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (traces.size && !traces.has(entry.trace_id)) continue
      matched.push(entry)
    } catch {
      /* 跳过坏行 */
    }
  }
  return matched.slice(-limit)
}

export async function run(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(HELP.trim())
    return
  }

  const root = process.cwd()
  const vitePath = resolveVite(root)
  if (!vitePath) {
    throw new Error(`当前目录没有找到 vite：${root}\n请在 Vite 项目根目录执行，或先在项目里安装 vite。`)
  }

  let config = loadConfig(root)
  if (args.resetToken) {
    config = { ...config, token: '' }
    config = loadConfig(root)
  }

  const projectMeta = readProjectMeta(root)

  const bridge = await startBridge({
    token: config.token,
    extensionId: config.extensionId,
    preferredPort: args.port,
    projectMeta,
    log: (line) => console.log('  ' + line),
    onTask: async (task, pushPhase) => {
      const file = await persistTask(root, task)
      const logs = collectLogs(root, task)
      pushPhase('received', `已收到，目标 ${task.target?.sourceLoc ?? task.target?.selector ?? '未定位'}`)
      console.log(`  ↳ 任务已保存 ${file}`)
      if (logs.length) {
        console.log(`  ↳ 关联日志 ${logs.length} 条（trace ${(task.traces || []).map((t) => t.trace_id).join(', ') || '未提供'}）`)
      } else {
        console.log('  ↳ 未匹配到关联日志')
      }
    }
  })

  const { createServer } = await import(pathToFileURL(vitePath).href)
  const server = await createServer({
    root,
    plugins: [aitPlugin()],
    server: { open: args.open }
  })
  await server.listen()

  const url = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.server.port}/`

  if (config.port !== bridge.port) {
    saveConfig(root, { ...config, port: bridge.port })
  }

  console.log('')
  console.log('  ait · 本地桥已就绪')
  console.log('  ' + '─'.repeat(46))
  console.log(`  页面    ${url}`)
  console.log(`  桥接    ${bridge.url}`)
  console.log(`  项目    ${projectMeta.name}（${projectMeta.framework}）`)
  console.log(`  Token   ${config.token}`)
  console.log('  ' + '─'.repeat(46))
  console.log('  在扩展选项页填入上面的 Token 即可配对。')
  if (!config.extensionId) {
    console.log('  提示：尚未锁定扩展 ID，当前接受任意扩展来源。')
  }
  console.log('')

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    console.log('\n  正在关闭…')
    try {
      await server.close()
    } catch {
      /* 忽略 */
    }
    await bridge.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { server, bridge }
}
