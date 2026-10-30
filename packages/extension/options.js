const DEFAULTS = { endpoint: 'ws://127.0.0.1:5198', token: '' }

const $endpoint = document.getElementById('endpoint')
const $token = document.getElementById('token')
const $status = document.getElementById('status')
const $extid = document.getElementById('extid')

function setStatus(text, kind) {
  $status.textContent = text
  $status.className = kind || ''
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS)
  $endpoint.value = stored.endpoint || DEFAULTS.endpoint
  $token.value = stored.token || ''
  $extid.textContent = chrome.runtime.id
}

async function save() {
  const endpoint = $endpoint.value.trim() || DEFAULTS.endpoint
  const token = $token.value.trim()
  await chrome.storage.local.set({ endpoint, token })
  setStatus('已保存', 'ok')
}

/** 用与 content script 相同的方式握手，确认地址和口令都对 */
function testConnection() {
  const endpoint = $endpoint.value.trim() || DEFAULTS.endpoint
  const token = $token.value.trim()

  if (!token) {
    setStatus('请先填配对口令', 'err')
    return
  }

  setStatus('连接中…')
  let settled = false
  let socket

  const finish = (text, kind) => {
    if (settled) return
    settled = true
    setStatus(text, kind)
    try {
      socket?.close()
    } catch {
      /* 忽略 */
    }
  }

  try {
    socket = new WebSocket(endpoint)
  } catch {
    finish('地址格式不对，应形如 ws://127.0.0.1:5198', 'err')
    return
  }

  const timer = setTimeout(() => finish('超时：本地桥没有响应，确认 npx ait 正在运行', 'err'), 4000)

  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token, client: 'options/0.1.0' }))
  socket.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.type === 'hello_ok') {
      clearTimeout(timer)
      const project = msg.project?.name ? `项目 ${msg.project.name}` : '已配对'
      finish(`连接成功 · ${project}`, 'ok')
    }
  }
  socket.onerror = () => {
    clearTimeout(timer)
    finish('连接失败：确认本地桥在运行，且地址端口一致', 'err')
  }
  socket.onclose = (ev) => {
    clearTimeout(timer)
    if (settled) return
    const reason = ev.reason || '连接被关闭'
    finish(`${reason}（码 ${ev.code}）`, 'err')
  }
}

document.getElementById('save').addEventListener('click', save)
document.getElementById('test').addEventListener('click', testConnection)
load()
