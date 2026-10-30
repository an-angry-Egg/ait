import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const USER_DIR = 'C:/Users/Administrator/AppData/Local/Temp/ait-cdp'
const PAGE = 'http://localhost:5173/'
const TOKEN = JSON.parse(readFileSync('D:/code/MidasUI/examples/vite-vue/.ait/bridge.json', 'utf8')).token
const CONTENT = readFileSync('D:/code/MidasUI/packages/extension/content.js', 'utf8')

if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
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
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('Chrome 调试端口未就绪')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.waiters = new Map()
    this.events = []
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
      } else if (msg.method) {
        this.events.push(msg)
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

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

// 用假的 chrome API 顶替扩展环境：这里只验证页面侧交互与降级路径，
// 真实桥接需要加载扩展后由 service worker 建立。
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          if (typeof cb === 'function') {
            setTimeout(() => cb(msg && msg.type === 'ait:status'
              ? { state: 'off', detail: '验证环境未接桥', url: 'ws://127.0.0.1:5198' }
              : { ok: false, reason: 'offline' }), 0);
          }
        },
        onMessage: { addListener: () => {} }
      },
      storage: {
        local: { get: async (defaults) => Object.assign({}, defaults, {
          endpoint: 'ws://127.0.0.1:5198',
          token: ${JSON.stringify(TOKEN)}
        }) },
        onChanged: { addListener: () => {} }
      }
    };
  `
}, sessionId)

await cdp.send('Page.navigate', { url: PAGE }, sessionId)
await sleep(3000)

await cdp.send('Runtime.evaluate', { expression: CONTENT }, sessionId)
await sleep(1500)

const evaluate = async (expression) => {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId)
  return result.value
}

const mouse = async (type, x, y) => {
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1
  }, sessionId)
}

const results = {}

results.dataAit = await evaluate(`
  (() => {
    const els = [...document.querySelectorAll('[data-ait]')];
    return { count: els.length, sample: els.slice(0, 3).map(e => e.getAttribute('data-ait')) };
  })()
`)

// 1) 点圆钮进入聆听
const orb = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.orb'));
    if (!host) return null;
    const r = host.shadowRoot.querySelector('.orb').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()
`)
results.orb = orb
await mouse('mousePressed', orb.x, orb.y)
await mouse('mouseReleased', orb.x, orb.y)
await sleep(700)

// 2) 圈住「编辑资料」
const btn = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('编辑资料'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, loc: b.getAttribute('data-ait') };
  })()
`)
results.target = btn

await mouse('mousePressed', btn.x - 12, btn.y - 12)
const steps = 18
for (let i = 1; i <= steps; i++) {
  const t = (i / steps) * Math.PI * 2
  const cx = btn.x + btn.w / 2 + Math.cos(t) * (btn.w / 2 + 10)
  const cy = btn.y + btn.h / 2 + Math.sin(t) * (btn.h / 2 + 10)
  await mouse('mouseMoved', cx, cy)
  await sleep(12)
}
await mouse('mouseReleased', btn.x + btn.w / 2, btn.y + btn.h / 2)
await sleep(800)

// 3) 说两句
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
await speak('再大一点')

results.panelAfterDraft = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return host.shadowRoot.querySelector('.panel').innerText;
  })()
`)

// 4) 提交
await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.go'));
    host.shadowRoot.querySelector('.go').click();
    return true;
  })()
`)
await sleep(2200)

results.panelAfterSubmit = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return host.shadowRoot.querySelector('.panel').innerText;
  })()
`)

results.buttonStyle = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('编辑资料'));
    return b ? b.style.cssText : null;
  })()
`)

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync('D:/code/MidasUI/scripts/shot-ui.png', Buffer.from(shot.data, 'base64'))

console.log(JSON.stringify(results, null, 2))

try { chrome.kill() } catch { /* 忽略 */ }
process.exit(0)
