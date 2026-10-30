import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

/**
 * ① ↔ ② 的本地 WS。
 *
 * 必须鉴权：一个不校验来源的 localhost 服务，等于让任意网页都能改用户源码。
 * 两道门 —— Origin 限定为 chrome-extension://，token 限定为本项目独有的配对值。
 * Origin 挡恶意网页，token 挡本机其他程序。
 */

const CLOSE = {
  BAD_ORIGIN: 4001,
  AUTH_TIMEOUT: 4002,
  BAD_TOKEN: 4003,
  BAD_MESSAGE: 4004
}

const HELLO_TIMEOUT_MS = 5000
const HEARTBEAT_MS = 30000

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port })
    const onError = (err) => {
      server.close()
      reject(err)
    }
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}

export async function startBridge(options) {
  const { token, extensionId = null, preferredPort = 5198, onTask, log } = options

  let wss = null
  let port = 0

  for (let i = 0; i < 20; i++) {
    const candidate = preferredPort + i
    try {
      wss = await tryListen(candidate)
      port = candidate
      break
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err
      log?.(`端口 ${candidate} 被占用，尝试下一个`)
    }
  }

  if (!wss) throw new Error('找不到可用端口（5198–5217 均被占用）')

  const sessions = new Map()

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate()
        continue
      }
      socket.isAlive = false
      try {
        socket.ping()
      } catch {
        /* 忽略 */
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  wss.on('connection', (socket, req) => {
    const origin = req.headers.origin || ''
    const remote = req.socket.remoteAddress || ''

    if (!origin.startsWith('chrome-extension://')) {
      log?.(`拒绝连接：来源不是扩展（origin=${origin || '空'}，来自 ${remote}）`)
      socket.close(CLOSE.BAD_ORIGIN, '仅接受 Chrome 扩展连接')
      return
    }

    if (extensionId && origin !== `chrome-extension://${extensionId}`) {
      log?.(`拒绝连接：扩展 ID 不匹配（${origin}）`)
      socket.close(CLOSE.BAD_ORIGIN, '扩展 ID 未授权')
      return
    }

    socket.isAlive = true
    socket.on('pong', () => {
      socket.isAlive = true
    })

    let authed = false
    let sessionId = null

    const authTimer = setTimeout(() => {
      if (!authed) {
        log?.('拒绝连接：未在 5 秒内完成配对')
        socket.close(CLOSE.AUTH_TIMEOUT, '未完成配对')
      }
    }, HELLO_TIMEOUT_MS)

    const reply = (payload) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
    }

    socket.on('message', async (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        socket.close(CLOSE.BAD_MESSAGE, '消息不是合法 JSON')
        return
      }

      if (!authed) {
        if (msg.type !== 'hello') {
          socket.close(CLOSE.BAD_MESSAGE, '首条消息必须是 hello')
          return
        }
        if (msg.token !== token) {
          log?.(`拒绝连接：token 不匹配（收到 ${String(msg.token).slice(0, 6)}…）`)
          socket.close(CLOSE.BAD_TOKEN, 'token 不匹配')
          return
        }
        authed = true
        clearTimeout(authTimer)
        sessionId = randomUUID()
        sessions.set(sessionId, socket)
        log?.(`扩展已配对（${msg.client || 'unknown'}，扩展 ID ${origin.replace('chrome-extension://', '')}）`)
        reply({
          type: 'hello_ok',
          sessionId,
          project: options.projectMeta ?? null
        })
        return
      }

      if (msg.type === 'ping') {
        reply({ type: 'pong', t: msg.t })
        return
      }

      if (msg.type === 'task') {
        const task = msg.task ?? {}
        const taskId = task.taskId || randomUUID()
        reply({ type: 'ack', taskId, received: true })
        try {
          log?.(`收到任务 ${taskId}：${task.target?.sourceLoc || task.target?.selector || '未定位'} · ${task.instruction?.text ?? ''}`)
          await onTask?.({ ...task, taskId }, (phase, message) => {
            reply({ type: 'phase', taskId, phase, message })
          })
        } catch (err) {
          log?.(`任务 ${taskId} 处理失败：${err?.message ?? err}`)
          reply({ type: 'phase', taskId, phase: 'failed', message: String(err?.message ?? err) })
        }
        return
      }

      reply({ type: 'error', message: `未知消息类型：${msg.type}` })
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      if (sessionId) sessions.delete(sessionId)
    })

    socket.on('error', () => {
      /* 客户端异常断开，无需处理 */
    })
  })

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    sessions,
    async close() {
      clearInterval(heartbeat)
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
    }
  }
}
