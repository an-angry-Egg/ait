import type { Plugin } from 'vite'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 模拟真实后端：返回数据、按业务规则报错、把每次请求写成结构化日志。
 * 日志里带 trace_id —— AIT 的日志关联靠它把「点了哪个按钮」和「后端报了什么错」对上。
 * 真实项目里这一步由后端完成；这里用中间件模拟，保证链路可验证。
 */

const LOG_FILE = resolve(process.cwd(), '.ait/logs/app.log')

type LogEntry = {
  ts: string
  trace_id: string
  level: 'INFO' | 'WARN' | 'ERROR'
  method: string
  path: string
  status: number
  message: string
}

function writeLog(entry: LogEntry): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) {
        fail(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => ok(raw))
    req.on('error', fail)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(payload)
}

function traceOf(req: IncomingMessage): string {
  const raw = req.headers['x-ait-trace-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value || 'tr-' + Math.random().toString(16).slice(2, 9)
}

const profile = {
  name: '张春宇',
  email: 'chunyu@example.com',
  phone: '138****6621',
  avatar: 'Z',
  role: '管理员'
}

const loginHistory = [
  { time: '2026-10-30 09:12', ip: '127.0.0.1', device: 'Chrome · Windows', place: '本机' },
  { time: '2026-10-29 21:40', ip: '10.0.0.23', device: 'Safari · iPhone', place: '杭州' },
  { time: '2026-10-28 08:05', ip: '10.0.0.11', device: 'Chrome · macOS', place: '上海' }
]

export function mockApi(): Plugin {
  return {
    name: 'ait:mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        const path = url.split('?')[0]
        if (!path.startsWith('/api/')) return next()

        const method = (req.method || 'GET').toUpperCase()
        const trace = traceOf(req)
        req.headers['x-ait-trace-id'] = trace

        try {
          if (method === 'GET' && path === '/api/user/profile') {
            writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'INFO', method, path, status: 200, message: '读取用户资料' })
            return send(res, 200, profile)
          }

          if (method === 'PUT' && path === '/api/user/profile') {
            const body = JSON.parse((await readBody(req)) || '{}')
            const email = String(body.email ?? '')
            if (!email.includes('@') || email.length < 6) {
              writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'WARN', method, path, status: 422, message: '邮箱格式不正确，拒绝写入' })
              return send(res, 422, { message: '邮箱格式不正确' })
            }
            Object.assign(profile, { name: body.name ?? profile.name, email })
            writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'INFO', method, path, status: 200, message: '更新用户资料成功' })
            return send(res, 200, profile)
          }

          if (method === 'GET' && path === '/api/user/login-history') {
            writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'INFO', method, path, status: 200, message: '读取登录记录 ' + loginHistory.length + ' 条' })
            return send(res, 200, loginHistory)
          }

          if (method === 'POST' && path === '/api/auth/logout') {
            writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'INFO', method, path, status: 200, message: '退出登录' })
            return send(res, 200, { ok: true })
          }

          writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'WARN', method, path, status: 404, message: '接口不存在' })
          return send(res, 404, { message: 'not found' })
        } catch (err) {
          writeLog({ ts: new Date().toISOString(), trace_id: trace, level: 'ERROR', method, path, status: 500, message: String(err) })
          return send(res, 500, { message: 'server error' })
        }
      })
    }
  }
}
