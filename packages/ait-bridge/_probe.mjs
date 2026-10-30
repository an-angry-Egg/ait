import WebSocket from 'ws'

const URL = process.env.AIT_WS || 'ws://127.0.0.1:5198'
const TOKEN = process.env.AIT_TOKEN || ''

function connect({ origin, token, task }) {
  return new Promise((resolve) => {
    const events = []
    const socket = new WebSocket(URL, origin ? { origin } : undefined)
    const done = (result) => {
      try {
        socket.close()
      } catch {
        /* 忽略 */
      }
      resolve(result)
    }

    socket.on('open', () => {
      if (token !== undefined) socket.send(JSON.stringify({ type: 'hello', token, client: 'test/0.1.0' }))
      if (task) {
        setTimeout(() => socket.send(JSON.stringify({ type: 'task', task })), 200)
      }
      setTimeout(() => done({ events }), 1200)
    })
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())))
    socket.on('close', (code, reason) => done({ events, closeCode: code, reason: reason.toString() }))
    socket.on('error', (err) => done({ events, error: err.message }))
  })
}

const cases = [
  {
    name: '网页来源（应拒绝）',
    opts: { origin: 'https://evil.example.com', token: TOKEN }
  },
  {
    name: '扩展来源 + 错误 token（应拒绝）',
    opts: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', token: 'wrong-token' }
  },
  {
    name: '扩展来源 + 正确 token（应通过并提交任务）',
    opts: {
      origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      token: TOKEN,
      task: {
        taskId: 't_probe_001',
        page: { url: 'http://localhost:5173/user/profile', route: '/user/profile', title: '账号设置' },
        target: {
          sourceLoc: 'src/components/ProfileCard.vue:22:9',
          selector: 'button.btn-primary',
          text: '编辑资料'
        },
        instruction: { text: '改成绿色', source: 'voice', raw: '呃…那个编辑按钮，弄绿一点' },
        traces: [{ trace_id: 'tr-probe' }]
      }
    }
  }
]

for (const item of cases) {
  const result = await connect(item.opts)
  const kinds = result.events.map((e) => e.type).join(', ') || '（无消息）'
  const close = result.closeCode ? `关闭码 ${result.closeCode}「${result.reason}」` : ''
  console.log(`\n[${item.name}]`)
  console.log(`  消息: ${kinds}`)
  if (close) console.log(`  ${close}`)
  if (result.events.some((e) => e.type === 'ack')) console.log('  → 任务已被接收 ✓')
}
