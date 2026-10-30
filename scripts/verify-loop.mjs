/**
 * 手势与批量选中验证：鼠标只移动、不按任何键
 *
 * 覆盖 5 项：
 *   1. 全程零按键 —— 不产生任何 click
 *   2. 拖尾存在且是渐变（不是一条实线）
 *   3. 鼠标停住后拖尾会衰减消失
 *   4. 绕满一圈 + 停顿 → 锁定
 *   5. 圈住多个互不嵌套的元素 → 全部自动选中
 *
 * 用法：先 `pnpm ait` 起桥，再 `node scripts/verify-loop.mjs`
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9337
const USER_DIR = 'C:/Users/Administrator/AppData/Local/Temp/ait-cdp-loop'
const EXT_DIR = 'D:/code/MidasUI/packages/extension'
const BRIDGE_CFG = JSON.parse(readFileSync('D:/code/MidasUI/examples/vite-vue/.ait/bridge.json', 'utf8'))
const PAGE = 'http://localhost:5173/'
const WS = `ws://127.0.0.1:${BRIDGE_CFG.port}`

if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DIR}`,
  '--window-size=1280,960',
  'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDebugger() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return await res.json()
    } catch { /* 等待 */ }
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

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`)
}

function finish(code = 0) {
  const failed = checks.filter((c) => !c.pass)
  console.log('\n──────── 结果 ────────')
  console.log(`通过 ${checks.length - failed.length}/${checks.length}`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? '  ' + f.detail : ''))
  }
  try { chrome.kill() } catch { /* 忽略 */ }
  process.exit(failed.length ? 1 : code)
}

const version = await waitForDebugger()
const cdp = new CDP(version.webSocketDebuggerUrl)
await cdp.ready

let extId = null
try {
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR })
  extId = loaded.id
  console.log(`\n扩展已加载 ${extId}\n`)
} catch (err) {
  console.log('扩展加载失败：', err.message)
  process.exit(1)
}

// 写入配对口令，等价于用户在选项页保存
const optTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` })
const optSession = (await cdp.send('Target.attachToTarget', { targetId: optTarget.targetId, flatten: true })).sessionId
await cdp.send('Runtime.enable', {}, optSession)
await sleep(700)
await cdp.send('Runtime.evaluate', {
  expression: `chrome.storage.local.set({ endpoint: ${JSON.stringify(WS)}, token: ${JSON.stringify(BRIDGE_CFG.token)} })`,
  awaitPromise: true
}, optSession)
await sleep(1000)

const page = await cdp.send('Target.createTarget', { url: PAGE })
const sessionId = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)
await sleep(3800)

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  }, sessionId)
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''))
  }
  return result.value
}

/** 只移动，永远不按下任何键 */
const move = async (x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, sessionId)
}

const panelText = () => evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return host ? host.shadowRoot.querySelector('.panel').innerText : null;
  })()
`)

const hudCount = () => evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.layer'));
    return host ? host.shadowRoot.querySelectorAll('.layer .box').length : -1;
  })()
`)

/** 画布上拖尾的像素统计：数量、灰阶层级、最大不透明度 */
const trailStats = () => evaluate(`
  (() => {
    const c = document.getElementById('__ait_demo_canvas__');
    if (!c) return null;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let px = 0, maxA = 0;
    const levels = new Set();
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 6) { px++; levels.add(d[i]); if (d[i] > maxA) maxA = d[i]; }
    }
    return { px, levels: levels.size, maxA };
  })()
`)

const enterListening = () => evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.orb'));
    const orb = host.shadowRoot.querySelector('.orb');
    if (!orb || orb.hidden) return false;
    orb.click();
    return true;
  })()
`)

const closePanel = () => evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.close'));
    const b = host && host.shadowRoot.querySelector('.close');
    if (b) b.click();
    return true;
  })()
`)

/* ==================== 1. 进聆听态 ==================== */

console.log('【1】进入聆听态')
await enterListening()
await sleep(600)
const listening = await panelText()
check('浮窗进入聆听态', !!listening && listening.includes('聆听中'), (listening || '').slice(0, 40).replace(/\n/g, ' / '))

const canvasReady = await evaluate(`!!document.getElementById('__ait_demo_canvas__')`)
check('画布已挂载', canvasReady === true)

/* ==================== 2. 拖尾渐隐 ==================== */

console.log('\n【2】拖尾效果：绕 3/4 圈后立刻采样画布')
const target = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '编辑资料');
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()
`)

const cx = target.x + target.w / 2
const cy = target.y + target.h / 2
const rx = target.w / 2 + 18
const ry = target.h / 2 + 16

// 3/4 圈：角度不够 330°，也不会闭合，必定不锁定
for (let i = 1; i <= 36; i++) {
  const t = (i / 48) * Math.PI * 2 // 只走 0 → 3/4 圈
  await move(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry)
  await sleep(16)
}
await sleep(60)

const drew = await trailStats()
check('轨迹被画出来了', !!drew && drew.px > 0, drew ? `${drew.px} 像素` : '读不到画布')
check('是渐变拖尾而非实线', !!drew && drew.levels >= 6, drew ? `${drew.levels} 级不透明度` : '')
check('头部比尾部实', !!drew && drew.maxA > 120, drew ? `峰值 alpha ${drew.maxA}` : '')

/* ==================== 3. 停住后衰减 ==================== */

console.log('\n【3】鼠标停住，拖尾应自行淡出')
await sleep(900)
const faded = await trailStats()
check('停住后轨迹消失', !!faded && faded.px === 0, faded ? `剩 ${faded.px} 像素` : '')
const notLocked = await panelText()
check('半圈不会误锁', !!notLocked && notLocked.includes('聆听中'))

/* ==================== 4. 绕满一圈 + 停顿 → 锁定 ==================== */

console.log('\n【4】绕满一圈并停顿')
await closePanel()
await sleep(300)
await enterListening()
await sleep(400)

const clicksBefore = await evaluate(`
  (() => {
    window.__cells = 0;
    document.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => { window.__cells++ }));
    document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { window.__btn = (window.__btn || 0) + 1 }));
    window.__btn = 0;
    return true;
  })()
`)

await evaluate(`window.__mm = 0; document.addEventListener('mousemove', function(){ window.__mm++ }, true); true`)

for (let i = 1; i <= 40; i++) {
  const t = (i / 40) * Math.PI * 2
  await move(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry)
  await sleep(32)
}

const mmCount = await evaluate(`window.__mm`)
console.log(`    发出 40 次移动，页面收到 ${mmCount} 次`)

// 刚停下时先看一眼：这一笔本身成不成立（此时还没到停顿阈值）
await sleep(180)
const midState = await evaluate(`document.documentElement.getAttribute('data-ait-state')`)
console.log('    停笔时：' + midState)

await sleep(420) // 停顿就是确认

const stateAfter = await evaluate(`document.documentElement.getAttribute('data-ait-state')`)
console.log('    判定后：' + stateAfter)

const afterLoop = await panelText()
check('绕满一圈并停顿后锁定', !!afterLoop && afterLoop.includes('草稿'), (afterLoop || '').split('\n')[0])
check('锁定的是「编辑资料」', !!afterLoop && afterLoop.includes('编辑资料'))

const oneBox = await hudCount()
check('单个目标只画一个框', oneBox === 1, `${oneBox} 个框`)

const oneList = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.picks'));
    if (!host) return null;
    return [...host.shadowRoot.querySelectorAll('.picks li')].map(li => li.innerText.replace(/\\n/g, ' | '));
  })()
`)
console.log('    选中清单：' + JSON.stringify(oneList, null, 0))

const clicksAfter = await evaluate(`({ cells: window.__cells, btn: window.__btn })`)
check('全程零按键，无 click 漏出', clicksAfter.cells === 0 && clicksBefore === true,
  `行 click ${clicksAfter.cells} 次`)

/* ==================== 5. 批量选中 ==================== */

console.log('\n【5】圈住表格两行，应同时选中两个元素')
await closePanel()
await sleep(300)
await enterListening()
await sleep(400)

// 滚到表格并量出前两行的位置
const rows = await evaluate(`
  (() => {
    const list = [...document.querySelectorAll('tbody tr')];
    if (list.length < 2) return null;
    list[0].scrollIntoView({ block: 'center' });
    return { count: list.length };
  })()
`)
await sleep(500)

const rects = await evaluate(`
  (() => {
    const list = [...document.querySelectorAll('tbody tr')].slice(0, 2);
    return list.map(tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  })()
`)
check('表格至少两行', !!rows && rows.count >= 2, rows ? `${rows.count} 行` : '找不到表格')

const gx1 = Math.min(...rects.map(r => r.x)) - 12
const gx2 = Math.max(...rects.map(r => r.x + r.w)) + 12
const gy1 = Math.min(...rects.map(r => r.y)) - 8
const gy2 = Math.max(...rects.map(r => r.y + r.h)) + 8

const gcx = (gx1 + gx2) / 2
const gcy = (gy1 + gy2) / 2
const grx = (gx2 - gx1) / 2
const gry = (gy2 - gy1) / 2

for (let i = 1; i <= 48; i++) {
  const t = (i / 48) * Math.PI * 2
  await move(gcx + Math.cos(t) * grx, gcy + Math.sin(t) * gry)
  await sleep(12)
}
await sleep(600)

const groupState = await evaluate(`document.documentElement.getAttribute('data-ait-state')`)
console.log('    内部状态：' + groupState)

const groupText = await panelText()
check('批量选中生效', !!groupText && /已选\s*2\s*个/.test(groupText), (groupText || '').split('\n').slice(0, 2).join(' / '))

const groupBoxes = await hudCount()
check('每个选中元素各画一框', groupBoxes === 2, `${groupBoxes} 个框`)

const pickedTags = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.picks'));
    if (!host) return null;
    return [...host.shadowRoot.querySelectorAll('.picks li')].map(li => li.innerText.replace(/\\n/g, ' '));
  })()
`)
check('清单列出两行', !!pickedTags && pickedTags.length === 2, JSON.stringify(pickedTags))

const stillNoClick = await evaluate(`({ cells: window.__cells, btn: window.__btn })`)
check('批量圈选同样无 click', stillNoClick.cells === 0 && stillNoClick.btn === 0,
  `行 ${stillNoClick.cells} 次 / 按钮 ${stillNoClick.btn} 次`)

/* ==================== 收尾 ==================== */

await cdp.send('Page.captureScreenshot', {}, sessionId).then(async (shot) => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('D:/code/MidasUI/scripts/shot-loop.png', Buffer.from(shot.data, 'base64'))
  console.log('\n截图：scripts/shot-loop.png')
}).catch(() => {})

finish()
