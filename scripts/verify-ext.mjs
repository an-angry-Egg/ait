import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
const USER_DIR = 'C:/Users/Administrator/AppData/Local/Temp/ait-cdp-ext'
const EXT_DIR = 'D:/code/MidasUI/packages/extension'
const PAGE = 'http://localhost:5173/'
const TOKEN = JSON.parse(readFileSync('D:/code/MidasUI/examples/vite-vue/.ait/bridge.json', 'utf8')).token

if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DIR}`,
  '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDebugger() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 等待 */
    }
    await sleep(300)
  }
  throw new Error('调试端口未就绪')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.waiters = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.waiters.has(msg.id)) {
        const { resolve, reject } = this.waiters.get(msg.id)
        this.waiters.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
    })
  }
}

const version = await waitForDebugger()
const cdp = new CDP(version.webSocketDebuggerUrl)
await cdp.ready

let extId = null
try {
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR })
  extId = loaded.id
  console.log('扩展已加载，ID =', extId)
} catch (err) {
  console.log('扩展加载失败：', err.message)
  chrome.kill()
  process.exit(1)
}

// 在扩展页面里写入口令（等价于用户在选项页保存）
const optTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` })
const optSession = (await cdp.send('Target.attachToTarget', { targetId: optTarget.targetId, flatten: true })).sessionId
await cdp.send('Runtime.enable', {}, optSession)
await sleep(800)
await cdp.send('Runtime.evaluate', {
  expression: `chrome.storage.local.set({ endpoint: 'ws://127.0.0.1:5198', token: ${JSON.stringify(TOKEN)} })`,
  awaitPromise: true
}, optSession)

await sleep(1500)

const page = await cdp.send('Target.createTarget', { url: PAGE })
const sessionId = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)
await sleep(3500)

const evaluate = async (expression) => {
  const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  return result.value
}

const mouse = async (type, x, y) => {
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1
  }, sessionId)
}

const results = { extId }

results.dataAit = await evaluate(`document.querySelectorAll('[data-ait]').length`)

const orb = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.orb'));
    if (!host) return null;
    const r = host.shadowRoot.querySelector('.orb').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()
`)
results.orbFound = Boolean(orb)
if (!orb) {
  console.log(JSON.stringify(results, null, 2))
  chrome.kill()
  process.exit(0)
}

await mouse('mousePressed', orb.x, orb.y)
await mouse('mouseReleased', orb.x, orb.y)
await sleep(1200)

results.listenPanel = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return host.shadowRoot.querySelector('.panel').innerText;
  })()
`)

const btn = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('编辑资料'));
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()
`)

// 纯移动绕一圈再停住：指向靠轨迹判断，全程不按键
for (let i = 1; i <= 32; i++) {
  const t = (i / 32) * Math.PI * 2
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: btn.x + btn.w / 2 + Math.cos(t) * (btn.w / 2 + 8),
    y: btn.y + btn.h / 2 + Math.sin(t) * (btn.h / 2 + 8),
    buttons: 0
  }, sessionId)
  await sleep(18)
}
await sleep(900)

const speak = async (text) => {
  await evaluate(`
    (() => {
      const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.say'));
      const input = host.shadowRoot.querySelector('.say');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `)
  await sleep(600)
}

await speak('做成绿色')

await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.go'));
    host.shadowRoot.querySelector('.go').click();
    return true;
  })()
`)
await sleep(2600)

results.donePanel = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return host.shadowRoot.querySelector('.panel').innerText;
  })()
`)

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync('D:/code/MidasUI/scripts/shot-ext.png', Buffer.from(shot.data, 'base64'))

console.log(JSON.stringify(results, null, 2))
try { chrome.kill() } catch { /* 忽略 */ }
process.exit(0)
