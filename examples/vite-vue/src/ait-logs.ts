/**
 * 页面侧日志镜像。
 *
 * 扩展的 content script 跑在隔离世界，读不到页面上的 JS 变量；
 * 所以把结构化日志同时写一份到 DOM 里一个不会执行的 script 节点，
 * 扩展从 `#__ait_logs` 取，用来把「点了哪个按钮」和「后端报了什么错」对上。
 *
 * 真实项目里这一层通常由请求库的拦截器完成，示例工程放在 api.ts 的 request 里。
 */

export type AitLog = {
  ts: string
  trace_id: string
  level: 'INFO' | 'WARN' | 'ERROR'
  method: string
  path: string
  status: number
  message: string
  duration_ms?: number
}

const MAX = 50
const buffer: AitLog[] = []

declare global {
  interface Window {
    __AIT_LOGS__?: AitLog[]
  }
}

export function recordLog(entry: AitLog): void {
  buffer.push(entry)
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX)

  window.__AIT_LOGS__ = buffer

  let node = document.getElementById('__ait_logs') as HTMLScriptElement | null
  if (!node) {
    node = document.createElement('script')
    node.type = 'application/json'
    node.id = '__ait_logs'
    node.hidden = true
    document.body.appendChild(node)
  }
  node.textContent = JSON.stringify(buffer)
}
