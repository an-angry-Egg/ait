/**
 * 可见演示：打开一个真实 Chrome 窗口，慢速走完整条链路。
 *
 * 与 verify-full.mjs 的区别：
 *   - 不用 --headless，窗口真的出现在屏幕上
 *   - 每步停顿、终端打印，画圈放慢、打字逐字，肉眼跟得上
 *   - 结束时窗口保留，交给用户自己接着玩
 *
 * 用法：先 `pnpm ait` 起桥，再 `node scripts/demo-live.mjs`
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9340
const USER_DIR = 'C:/Users/Administrator/AppData/Local/Temp/ait-demo-live'
const EXT_DIR = 'D:/code/MidasUI/packages/extension'
const OUT_DIR = 'D:/code/MidasUI/scripts/demo-shots'
const CFG = JSON.parse(readFileSync('D:/code/MidasUI/examples/vite-vue/.ait/bridge.json', 'utf8'))
const PAGE = 'http://localhost:5173/'

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

console.log('\n════════ 点睛 · 可见演示 ════════')
console.log('Chrome 窗口即将打开，请盯着屏幕看。\n')

const chrome = spawn(CHROME, [
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DIR}`,
  '--window-size=1320,900',
  '--window-position=60,40',
  'about:blank'
], { stdio: 'ignore', detached: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (n, text) => console.log(`\n【${n}】${text}`)

async function waitDbg() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return r.json()
    } catch { /* 等待 */ }
    await sleep(300)
  }
  throw new Error('调试端口未就绪，可能已有 Chrome 占用了 ' + PORT)
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.waiters = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.waiters.has(m.id)) {
        const { resolve, reject } = this.waiters.get(m.id)
        this.waiters.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const p = { id, method, params }
    if (sessionId) p.sessionId = sessionId
    return new Promise((resolve, reject) => { this.waiters.set(id, { resolve, reject }); this.ws.send(JSON.stringify(p)) })
  }
}

const v = await waitDbg()
const cdp = new CDP(v.webSocketDebuggerUrl)
await cdp.ready

step(1, '加载扩展')
const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR })
console.log(`    扩展 ID = ${extId}`)

const opt = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` })
const os = (await cdp.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId
await cdp.send('Runtime.enable', {}, os)
await sleep(600)
await cdp.send('Runtime.evaluate', {
  expression: `chrome.storage.local.set({ endpoint: 'ws://127.0.0.1:${CFG.port}', token: ${JSON.stringify(CFG.token)} })`,
  awaitPromise: true
}, os)
await cdp.send('Target.closeTarget', { targetId: opt.targetId })
console.log('    已写入配对口令，选项页已关闭')

step(2, '打开演示页')
const page = await cdp.send('Target.createTarget', { url: PAGE })
const s = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
await cdp.send('Page.enable', {}, s)
await cdp.send('Runtime.enable', {}, s)
await sleep(4200)

const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, s)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}
const mouse = async (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1
}, s)
const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'))
}
const panelText = () => ev(`
  (() => {
    const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return h ? h.shadowRoot.querySelector('.panel').innerText.replace(/\\n+/g, ' / ') : '';
  })()
`)
const boxOf = (t) => ev(`
  (() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()
`)

/** 纯移动绕一个矩形：全程不按下任何键，末尾停顿等它自己锁定 */
async function circleBox(box, { slow = 45, hold = 900, pad = 16, shotAt = 0, shotName = null } = {}) {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const rx = box.w / 2 + pad
  const ry = box.h / 2 + pad

  // buttons: 0 —— 鼠标只是移动，没有任何按键按下
  for (let i = 1; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, buttons: 0
    }, s)
    await sleep(slow)
    if (shotAt && i === shotAt && shotName) await shot(shotName)
  }
  // 绕满后停住：这一拍就是确认
  await sleep(hold)
  return box
}

async function circle(label, opts = {}) {
  const box = await boxOf(label)
  if (!box) throw new Error('找不到按钮：' + label)
  return circleBox(box, opts)
}

const injected = await ev(`document.querySelectorAll('[data-ait]').length`)
console.log(`    页面已注入 ${injected} 个 data-ait 标记`)

step(3, '点击浮窗圆钮，进入聆听态')
const orb = await ev(`
  (() => {
    const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.orb'));
    const r = h.shadowRoot.querySelector('.orb').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()
`)
await mouse('mousePressed', orb.x, orb.y)
await mouse('mouseReleased', orb.x, orb.y)
await sleep(1600)
console.log('    浮窗：' + await panelText())
await shot('01-倾听')

step(4, '鼠标绕「编辑资料」转一圈——不按任何键，绕完停住（盯住蓝色轨迹）')
await circle('编辑资料', { slow: 45, hold: 900, shotAt: 40, shotName: '01b-绕圈中' })
console.log('    浮窗：' + await panelText())
await shot('02-命中')

step(5, '打字成句（相当于说一句话）')
async function type(text, perChar = 90) {
  await ev(`
    (() => {
      const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.say'));
      h.shadowRoot.querySelector('.say').focus();
      return true;
    })()
  `)
  for (const ch of text) {
    await cdp.send('Input.insertText', { text: ch }, s)
    await sleep(perChar)
  }
  await sleep(200)
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r'
    }, s)
  }
  await sleep(700)
}

await type('做成绿色')
await type('再圆一点')
await type('字大一点')
console.log('    浮窗：' + await panelText())
await shot('03-三句草稿')

step(6, '说「第二条不要」')
await type('第二条不要')
console.log('    浮窗：' + await panelText())
await shot('04-删掉第二条')

step(7, '说「开始改」')
// 取色前先把鼠标挪到空白处：按钮有 :hover 样式，鼠标压在上面会让读数变成悬停态颜色
const moveTo = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, s)
const bgOfEdit = async () => {
  await moveTo(8, 8)
  await sleep(180)
  return ev(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '编辑资料');
      return getComputedStyle(b).backgroundColor;
    })()
  `)
}

const colorBefore = await bgOfEdit()
await type('开始改')
await sleep(3200)
console.log('    浮窗：' + await panelText())
const colorAfter = await bgOfEdit()
console.log(`    按钮颜色：${colorBefore} → ${colorAfter}`)
await shot('05-改完')

step(8, '撤回')
await ev(`
  (() => {
    const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    const b = h.shadowRoot.querySelector('[data-act="rollback"]');
    if (b) b.click();
    return true;
  })()
`)
await sleep(1200)
const colorBack = await bgOfEdit()
console.log(`    按钮颜色：${colorAfter} → ${colorBack}`)
console.log(`    ${colorBack === colorBefore ? '已完整复原' : '未复原'}`)
await shot('06-撤回')

step(9, '验证副作用：先回到聆听态，再绕着「退出登录」转一圈')
// 「已改好」态下不采集轨迹。必须先点「再改一处」回到聆听态。
await ev(`
  (() => {
    const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    const b = h.shadowRoot.querySelector('[data-act="again"]');
    if (b) b.click();
    return true;
  })()
`)
await sleep(1000)
console.log('    浮窗：' + await panelText())

// 统计按钮收到的按下与点击：整个过程应当一次都没有
await ev(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '退出登录');
    window.__ev = { down: 0, up: 0, click: 0 };
    b.addEventListener('mousedown', () => { window.__ev.down++ });
    b.addEventListener('mouseup', () => { window.__ev.up++ });
    b.addEventListener('click', () => { window.__ev.click++ });
    return true;
  })()
`)
await circle('退出登录', { slow: 32, hold: 900 })
const sideEffects = await ev('window.__ev')
console.log(`    退出登录按钮收到：mousedown ${sideEffects.down} / mouseup ${sideEffects.up} / click ${sideEffects.click}（都应为 0）`)
console.log('    浮窗：' + await panelText())
await shot('07-危险按钮未被触发')

/* ==================== 10. 批量选中 ==================== */

step(10, '批量选中：圈住表格两行——圈住什么就选什么')

// 回到聆听态：点 × 关掉浮窗，再点圆钮
await ev(`
  (() => {
    const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.close'));
    const b = h && h.shadowRoot.querySelector('.close');
    if (b) b.click();
    return true;
  })()
`)
await sleep(500)
await ev(`
  (() => {
    const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.orb'));
    const o = h && h.shadowRoot.querySelector('.orb');
    if (o && !o.hidden) o.click();
    return true;
  })()
`)
await sleep(900)

// 把表格滚进视野，再量前两行的整体矩形
await ev(`
  (() => {
    const t = document.querySelector('tbody tr');
    if (t) t.scrollIntoView({ block: 'center' });
    return true;
  })()
`)
await sleep(700)

const gbox = await ev(`
  (() => {
    const list = [...document.querySelectorAll('tbody tr')].slice(0, 2);
    if (list.length < 2) return null;
    const a = list[0].getBoundingClientRect();
    const b = list[1].getBoundingClientRect();
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.right, b.right) - x, h: Math.max(a.bottom, b.bottom) - y };
  })()
`)
if (gbox) {
  await circleBox(gbox, { slow: 40, hold: 950, pad: 12, shotAt: 36, shotName: '08-批量绕圈中' })
  console.log('    浮窗：' + await panelText())

  const boxCount = await ev(`
    (() => {
      const h = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.layer'));
      return h ? h.shadowRoot.querySelectorAll('.layer .box').length : -1;
    })()
  `)
  console.log(`    高亮框：${boxCount} 个（圈住两行，两行各一框）`)
  await shot('09-批量选中')
} else {
  console.log('    页面上找不到两行表格，跳过这一步')
}

console.log('\n════════ 演示结束 ════════')
console.log('浏览器窗口保持打开，你可以直接接着操作。')
console.log(`截图已存到 ${OUT_DIR}`)
console.log('（浮窗仍处于聆听态：移动鼠标绕一圈即可试；点右上角 × 退出）\n')

try { chrome.unref() } catch { /* 忽略 */ }
process.exit(0)
