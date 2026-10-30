/**
 * 全流程验证：加载真实扩展 → 配对本地桥 → 画圈 → 打字成句 → 草稿编辑 → 开始改 → 撤回
 *
 * 覆盖 6 类行为：
 *   1. data-ait 注入与浮窗挂载
 *   2. 画圈不产生点击副作用（含从按钮内部起笔这种最容易误触的情况）
 *   3. 画圈命中与源码定位
 *   4. 打字成句、草稿编号、单条删除、整体清空
 *   5. 提交、桥回执、页面真实变更、撤回
 *   6. 任务落盘时的 trace 与日志关联
 *
 * 用法：先 `pnpm ait` 起桥，再 `node scripts/verify-full.mjs`
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9335
const USER_DIR = 'C:/Users/Administrator/AppData/Local/Temp/ait-cdp-full'
const EXT_DIR = 'D:/code/MidasUI/packages/extension'
const BRIDGE_CFG = JSON.parse(readFileSync('D:/code/MidasUI/examples/vite-vue/.ait/bridge.json', 'utf8'))
const TASKS_DIR = 'D:/code/MidasUI/examples/vite-vue/.ait/tasks'
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
await sleep(1200)

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

const mouse = async (type, x, y) => {
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1
  }, sessionId)
}

const boxOf = (text) => evaluate(`
  (() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()
`)

/** 在按钮外圈画一个椭圆；fromInside 为 true 时起笔落在按钮内部（最容易误触的情形） */
async function circle(label, fromInside = false) {
  const box = await boxOf(label)
  if (!box) throw new Error('找不到按钮：' + label)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2

  if (fromInside) {
    await mouse('mousePressed', box.x + 12, cy)
  } else {
    await mouse('mousePressed', box.x - 14, box.y - 12)
  }
  for (let i = 1; i <= 20; i++) {
    const t = (i / 20) * Math.PI * 2
    await mouse('mouseMoved', cx + Math.cos(t) * (box.w / 2 + 12), cy + Math.sin(t) * (box.h / 2 + 10))
    await sleep(8)
  }
  await mouse('mouseReleased', cx, cy)
  await sleep(850)
  return box
}

const panelText = () => evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return host ? host.shadowRoot.querySelector('.panel').innerText : null;
  })()
`)

/** 真实键盘打字 + 回车（等价于说完整一句话） */
async function type(text) {
  await evaluate(`
    (() => {
      const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.say'));
      host.shadowRoot.querySelector('.say').focus();
      return true;
    })()
  `)
  await cdp.send('Input.insertText', { text }, sessionId)
  await sleep(120)
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r'
    }, sessionId)
  }
  await sleep(500)
}

const clickAct = (act) => evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    const btn = host.shadowRoot.querySelector('[data-act="${act}"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()
`)

const bgOfEdit = () => evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '编辑资料');
    return getComputedStyle(b).backgroundColor;
  })()
`)

// ────────────────────── 1. 注入与挂载 ──────────────────────
console.log('1. 注入与挂载')
const dataAit = await evaluate(`document.querySelectorAll('[data-ait]').length`)
check('页面带 data-ait 的元素', dataAit === 47, `${dataAit} 个`)

const sample = await evaluate(`
  (() => {
    const el = document.querySelector('[data-ait*="ProfileCard"]');
    return el ? el.getAttribute('data-ait') : null;
  })()
`)
check('data-ait 指向真实源码位置', /ProfileCard\.vue:\d+:\d+/.test(sample || ''), sample || '无')

const orb = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.orb'));
    if (!host) return null;
    const r = host.shadowRoot.querySelector('.orb').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()
`)
check('浮窗圆钮已挂载', Boolean(orb))
if (!orb) finish(1)

const passThrough = await evaluate(`
  (() => {
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.panel'));
    return getComputedStyle(host).pointerEvents;
  })()
`)
check('浮窗不挡页面点击（pointer-events: none）', passThrough === 'none', passThrough)

// ────────────────────── 2. 先制造一条带 trace 的请求 ──────────────────────
// 此时浮窗还未进入聆听态，普通点击是允许的
console.log('\n2. 制造带 trace 的请求')
const refresh = await boxOf('刷新')
await mouse('mousePressed', refresh.x + refresh.w / 2, refresh.y + refresh.h / 2)
await mouse('mouseReleased', refresh.x + refresh.w / 2, refresh.y + refresh.h / 2)
await sleep(1200)

const mirrored = await evaluate(`
  (() => {
    const n = document.getElementById('__ait_logs');
    if (!n || !n.textContent) return { count: 0, withTrace: 0 };
    let all = [];
    try { all = JSON.parse(n.textContent) } catch { return { count: -1, withTrace: 0 } }
    return { count: all.length, withTrace: all.filter(l => l.trace_id).length };
  })()
`)
check('页面已镜像结构化日志', mirrored.count > 0, `${mirrored.count} 条`)
check('日志带 trace_id', mirrored.withTrace > 0, `${mirrored.withTrace} 条有 trace`)

// ────────────────────── 3. 进入聆听态 ──────────────────────
console.log('\n3. 进入聆听态')
await mouse('mousePressed', orb.x, orb.y)
await mouse('mouseReleased', orb.x, orb.y)
await sleep(1300)

const listen = await panelText()
check('浮窗进入聆听态', /聆听中/.test(listen || ''))
check('本地桥已连接', /本地桥已连接/.test(listen || ''))

// ────────────────────── 4. 画圈不产生点击副作用 ──────────────────────
console.log('\n4. 画圈不产生点击副作用')

async function armDangerButton() {
  await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '退出登录');
      if (window.__btnHandler) b.removeEventListener('click', window.__btnHandler);
      window.__btnClick = 0;
      window.__docClick = 0;
      window.__btnHandler = () => { window.__btnClick++ };
      b.addEventListener('click', window.__btnHandler);
      document.addEventListener('click', () => { window.__docClick++ }, true);
      window.__urlBefore = location.href;
      return true;
    })()
  `)
}
const clickStats = () => evaluate(`({ btn: window.__btnClick, doc: window.__docClick, sameUrl: location.href === window.__urlBefore })`)

const textBefore = await evaluate(`document.body.innerText.length`)

await armDangerButton()
await circle('退出登录', false)
let stats = await clickStats()
check('起笔在按钮外：按钮自身未收到 click', stats.btn === 0, `${stats.btn} 次`)
check('起笔在按钮外：捕获阶段也没漏出 click', stats.doc === 0, `${stats.doc} 次`)

await armDangerButton()
await circle('退出登录', true)
stats = await clickStats()
check('起笔在按钮内：按钮自身未收到 click', stats.btn === 0, `${stats.btn} 次`)
check('起笔在按钮内：捕获阶段也没漏出 click', stats.doc === 0, `${stats.doc} 次`)
check('画圈后页面未跳转', stats.sameUrl)

const textAfter = await evaluate(`document.body.innerText.length`)
check('画圈后页面内容未变化', textBefore === textAfter, `${textBefore} → ${textAfter}`)

// ────────────────────── 5. 画圈命中 ──────────────────────
console.log('\n5. 画圈命中')
await circle('编辑资料')
const hit = await panelText()
check('浮窗显示源码位置', /ProfileCard\.vue:\d+/.test(hit || ''), (hit || '').split('\n').find((l) => /\.vue:\d+/.test(l)) || '')
check('显示匹配分数', /\d+\s*分/.test(hit || ''))

// ────────────────────── 6. 打字成句与草稿编辑 ──────────────────────
console.log('\n6. 打字成句与草稿编辑')
const colorBefore = await bgOfEdit()
const draftCount = (t) => {
  const m = (t || '').match(/草稿 · (\d+) 句/)
  return m ? Number(m[1]) : -1
}

await type('做成绿色')
await type('再圆一点')
await type('字大一号')
let p = await panelText()
check('三句话进入草稿', draftCount(p) === 3, `草稿 · ${draftCount(p)} 句`)
check('草稿逐条编号', /1\s*做成绿色/.test(p || '') && /3\s*字大一号/.test(p || ''))

await type('第二条不要')
p = await panelText()
check('「第二条不要」删除指定一条', draftCount(p) === 2, `草稿 · ${draftCount(p)} 句`)
check('删掉的是第二条', !/再圆一点/.test(p || '') && /做成绿色/.test(p || '') && /字大一号/.test(p || ''))

await type('不要了')
p = await panelText()
check('「不要了」清空草稿', draftCount(p) === 0, `草稿 · ${draftCount(p)} 句`)

// ────────────────────── 7. 提交与回执 ──────────────────────
console.log('\n7. 提交与桥回执')
await type('做成绿色')
await type('加个圆角')
await clickAct('go')
await sleep(3200)

const done = await panelText()
check('浮窗进入完成态', /已改好/.test(done || ''))
check('显示变更数量', /\d+\s*处变更/.test(done || ''), (done || '').match(/\d+ 处变更/)?.[0] || '')
check('收到桥回执', /桥回执/.test(done || ''), (done || '').split('\n').find((l) => /桥回执/.test(l)) || '')
check('上下文包已组装', /上下文包/.test(done || ''))

const colorAfter = await bgOfEdit()
check('按钮颜色真的变了', colorAfter !== colorBefore, `${colorBefore} → ${colorAfter}`)

const shotDone = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync('D:/code/MidasUI/scripts/shot-full.png', Buffer.from(shotDone.data, 'base64'))

// ────────────────────── 8. 任务文件的 trace 与日志关联 ──────────────────────
console.log('\n8. 任务落盘的 trace 与日志')
const files = readdirSync(TASKS_DIR)
  .map((f) => ({ f, t: statSync(join(TASKS_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
const latestName = files[0]?.f
const task = JSON.parse(readFileSync(join(TASKS_DIR, latestName), 'utf8'))

check('任务含源码位置', /ProfileCard\.vue:\d+/.test(task.target?.sourceLoc || ''), task.target?.sourceLoc || '')
check('任务含草稿两条', (task.draft || []).length === 2, JSON.stringify((task.draft || []).map((d) => d.text)))
check('任务带 trace', (task.traces || []).length > 0, `${(task.traces || []).length} 个 trace`)
check('任务带关联日志', (task.logs || []).length > 0, `${(task.logs || []).length} 条`)

const traceIds = new Set((task.traces || []).map((t) => t.trace_id))
const linked = (task.logs || []).filter((l) => traceIds.has(l.trace_id))
check('日志与 trace 对得上', traceIds.size > 0 && linked.length > 0, `匹配 ${linked.length} 条`)

// ────────────────────── 9. 撤回 ──────────────────────
console.log('\n9. 撤回')
await clickAct('rollback')
await sleep(900)
const colorBack = await bgOfEdit()
check('撤回后颜色恢复', colorBack === colorBefore, `${colorAfter} → ${colorBack}`)

finish(0)
