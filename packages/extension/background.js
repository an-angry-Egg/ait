/* AIT 点睛 · service worker
 *
 * 为什么 WebSocket 必须在这里而不是 content script：
 * content script 的请求以页面身份发出，Origin 是页面地址（http://...），
 * 本地桥只接受 chrome-extension://，那条连接必然被拒。
 * service worker 的 Origin 是 chrome-extension://<id>，这才是能通过鉴权的身份。
 *
 * 职责：维持与本地桥的连接、心跳、断线重连，并在页面与桥之间转发消息。
 */

const DEFAULTS = { endpoint: 'ws://127.0.0.1:5198', token: '' }
const HEARTBEAT_MS = 20000
const RETRY_STEPS = [1000, 2000, 4000, 8000, 15000, 30000]

let socket = null
let state = 'off' // off | connecting | on | error
let detail = ''
let url = DEFAULTS.endpoint
let retryIndex = 0
let retryTimer = null
let heartbeatTimer = null

/** taskId → tabId，用于把桥回传的进度送回发起任务的那个标签页 */
const taskTabs = new Map()

function setState(next, reason) {
  state = next
  detail = reason || ''
  broadcast()
}

function broadcast() {
  const payload = { type: 'ait:bridge', state, detail, url }
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {
        // 标签页没有 content script（chrome:// 等），忽略
      })
    }
  })
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  const delay = RETRY_STEPS[Math.min(retryIndex, RETRY_STEPS.length - 1)]
  retryIndex++
  retryTimer = setTimeout(connect, delay)
}

function startHeartbeat() {
  clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'ping', t: Date.now() }))
      } catch {
        /* 下一轮重连会处理 */
      }
    }
  }, HEARTBEAT_MS)
}

async function connect() {
  clearTimeout(retryTimer)
  const cfg = await chrome.storage.local.get(DEFAULTS)
  url = cfg.endpoint || DEFAULTS.endpoint

  if (!cfg.token) {
    setState('off', '未配置口令')
    return
  }

  if (socket) {
    try {
      socket.close()
    } catch {
      /* 忽略 */
    }
    socket = null
  }

  setState('connecting')

  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    setState('error', '地址无效')
    scheduleRetry()
    return
  }

  socket = ws

  ws.onopen = () => {
    // 首条消息必须是 hello，5 秒内不完成配对桥会断开
    ws.send(JSON.stringify({ type: 'hello', token: cfg.token, client: 'extension/0.1.0' }))
  }

  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }

    if (msg.type === 'hello_ok') {
      retryIndex = 0
      setState('on')
      startHeartbeat()
      return
    }

    if (msg.type === 'phase') {
      const tabId = taskTabs.get(msg.taskId)
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'ait:phase', phase: msg.phase, message: msg.message, taskId: msg.taskId }).catch(() => {})
      }
    }
  }

  ws.onclose = (ev) => {
    clearInterval(heartbeatTimer)
    if (state !== 'off') {
      setState('error', ev.reason || '连接已关闭')
      scheduleRetry()
    }
  }

  ws.onerror = () => {
    setState('error', '无法连接本地桥')
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ait:status') {
    sendResponse({ state, detail, url })
    return true
  }

  if (msg?.type === 'ait:send') {
    if (!socket || socket.readyState !== WebSocket.OPEN || state !== 'on') {
      sendResponse({ ok: false, reason: '未连接' })
      return true
    }
    const taskId = msg.task?.taskId
    if (taskId && sender.tab?.id) taskTabs.set(taskId, sender.tab.id)
    try {
      socket.send(JSON.stringify({ type: 'task', task: msg.task }))
      sendResponse({ ok: true })
    } catch (err) {
      sendResponse({ ok: false, reason: String(err) })
    }
    return true
  }

  if (msg?.type === 'ait:reconnect') {
    retryIndex = 0
    connect()
    sendResponse({ ok: true })
    return true
  }

  return false
})

// 选项页改了口令就重连
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.token || changes.endpoint) {
    retryIndex = 0
    connect()
  }
})

chrome.runtime.onStartup.addListener(() => {
  retryIndex = 0
  connect()
})

chrome.runtime.onInstalled.addListener(() => {
  retryIndex = 0
  connect()
})

connect()
