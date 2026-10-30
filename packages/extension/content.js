/* AIT 点睛 · content script
 *
 * 链路：画圈 → 命中候选 → 语义匹配 → 草稿 → 任务对象 → 本地桥（未连接则剪贴板降级）
 *
 * 已实现：画圈命中、语义匹配、草稿编辑、源码位置读取、与本地桥配对和提交。
 * 未实现：端侧语音（M3）、真实补丁落地（M5）。
 * 详见 docs/AIT-架构定稿.md。
 */

(function () {
  'use strict';

  if (window.__AIT_DEMO__) return;
  window.__AIT_DEMO__ = true;

  /* ==================== 常量 ==================== */

  const MAX_CANDS = 5;
  const MAX_LOGS = 8;
  const MIN_POINTS = 8;
  const ACCENT = '#3b82f6';

  /* ==================== 状态 ==================== */

  const S = {
    mode: 'idle',        // idle | listening | drafting | doing | done
    points: [],
    drawing: false,
    candidates: [],      // [{ el, votes, area, score }]
    target: null,
    draft: [],           // [{ id, text }]
    snapshot: null,      // [{ el, cssText }]
    changed: 0,
    startedAt: 0,
    statusText: ''
  };

  /* ==================== 基础工具 ==================== */

  const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.body) return 'body';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) &&
        document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + el.id;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let sel = node.tagName.toLowerCase();
      const cls = [...node.classList].filter(c => c && !/^(css-|sc-|jsx-)/.test(c)).slice(0, 2);
      if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
      const p = node.parentElement;
      if (p) {
        const same = [...p.children].filter(c => c.tagName === node.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function labelOf(el) {
    if (!el) return '';
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      return (el.getAttribute('placeholder') || el.value || el.name || tag.toLowerCase()).trim();
    }
    const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (t) return t.slice(0, 40);
    return (el.getAttribute('aria-label') || el.getAttribute('title') || tag.toLowerCase()).trim();
  }

  function sourceOf(el) {
    let node = el;
    let hop = 0;
    while (node && node.nodeType === 1 && hop < 4) {
      const v = node.getAttribute && node.getAttribute('data-ait');
      if (v) return v;
      node = node.parentElement;
      hop++;
    }
    return '';
  }

  function shortLoc(src) {
    if (!src) return '';
    const m = src.match(/([^/\\]+?):(\d+)(?::(\d+))?$/);
    return m ? m[1] + ':' + m[2] : src;
  }

  /* ==================== 浮窗 ==================== */

  const host = document.createElement('div');
  host.id = '__ait_demo_hud__';
  host.style.cssText = 'all: initial; display: block; position: fixed; top: 16px; right: 16px; width: 320px; z-index: 2147483600; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'open' });

  const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.hud {
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #e8eaed; pointer-events: none; width: 320px;
}
.layer { position: fixed; inset: 0; pointer-events: none; }
.box {
  position: fixed; border: 1px dashed rgba(59,130,246,.85); border-radius: 4px;
  background: rgba(59,130,246,.06); pointer-events: none;
}
.box.locked { border-style: solid; box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
.box-tag {
  position: absolute; left: 0; top: -18px; font-size: 10px; line-height: 16px;
  padding: 0 6px; border-radius: 4px; background: ${ACCENT}; color: #fff;
  white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
}

/* 待机圆钮 */
.orb {
  position: absolute; top: 0; right: 0; width: 46px; height: 46px; border-radius: 50%;
  border: none; cursor: pointer; pointer-events: auto; color: #fff;
  background: linear-gradient(140deg, #3b82f6, #2563eb);
  box-shadow: 0 6px 20px rgba(37,99,235,.42), 0 0 0 1px rgba(255,255,255,.12) inset;
  font: 600 13px/46px inherit; font-family: inherit; letter-spacing: .06em;
  transition: transform .12s ease;
}
.orb:hover { transform: scale(1.06); }
.orb:active { transform: scale(.97); }

/* 面板 */
.panel {
  pointer-events: auto; width: 320px; border-radius: 14px; overflow: hidden;
  background: rgba(19,22,29,.9); border: 1px solid rgba(255,255,255,.09);
  box-shadow: 0 16px 48px rgba(0,0,0,.42);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  backdrop-filter: blur(16px) saturate(1.4);
  animation: fade .16s ease;
}
@keyframes fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

.head {
  display: flex; align-items: center; gap: 7px;
  padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.07);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: ${ACCENT}; flex: none; }
.dot.live { animation: pulse 1.1s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .28; } }
.status { font-size: 12px; font-weight: 600; letter-spacing: .01em; }
.meta { font-size: 11px; color: #7d8794; margin-left: auto; font-variant-numeric: tabular-nums; }
.close {
  pointer-events: auto; border: none; background: none; color: #6b7480;
  font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 3px; border-radius: 4px;
  font-family: inherit;
}
.close:hover { color: #c9ced6; background: rgba(255,255,255,.06); }

.body { padding: 12px; }
.foot { padding: 10px 12px; border-top: 1px solid rgba(255,255,255,.07); }

/* 聆听 */
.tip { font-size: 12px; color: #9aa3af; line-height: 1.6; }
.tip b { color: #cfd5dd; font-weight: 500; }
.wave { display: flex; align-items: flex-end; gap: 3px; height: 22px; margin-top: 10px; }
.wave i {
  width: 3px; border-radius: 2px; background: ${ACCENT}; opacity: .9;
  animation: wv 1s infinite ease-in-out;
}
@keyframes wv { 0%,100% { height: 5px; } 50% { height: 20px; } }

/* 目标 */
.target {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 9px; background: rgba(59,130,246,.1);
  border: 1px solid rgba(59,130,246,.24); margin-bottom: 10px;
}
.tag {
  font-size: 10px; padding: 1px 5px; border-radius: 4px;
  background: rgba(59,130,246,.22); color: #93c5fd; letter-spacing: .04em;
}
.name { font-size: 12px; color: #e2e8f0; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loc { font-size: 11px; color: #6ee7b7; margin-left: auto; font-variant-numeric: tabular-nums; }
.loc.none { color: #6b7480; }

/* 草稿 */
.draft { list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
.draft li {
  display: flex; align-items: flex-start; gap: 7px; font-size: 12.5px; color: #d4dae2;
  padding: 5px 7px; border-radius: 7px; background: rgba(255,255,255,.04);
}
.draft li:hover { background: rgba(255,255,255,.07); }
.draft .n {
  flex: none; width: 15px; height: 15px; border-radius: 4px; margin-top: 1px;
  background: rgba(255,255,255,.1); color: #9aa3af;
  font-size: 10px; line-height: 15px; text-align: center; font-variant-numeric: tabular-nums;
}
.draft .t { flex: 1; word-break: break-word; }
.draft .x {
  pointer-events: auto; border: none; background: none; color: #5f6875;
  cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; font-family: inherit;
}
.draft .x:hover { color: #f87171; }
.empty { font-size: 12px; color: #6b7480; }

/* 候选 */
.cands { margin-top: 10px; font-size: 11.5px; color: #7d8794; line-height: 1.7; }
.cands b { color: #93c5fd; font-weight: 500; }
.cands .sep { color: #4b5563; }

/* 输入 */
.row { display: flex; gap: 5px; }
.say {
  flex: 1; min-width: 0; font: inherit; font-size: 12px; color: #e8eaed;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px; padding: 7px 8px; outline: none; pointer-events: auto;
  font-family: inherit;
}
.say::placeholder { color: #5f6875; }
.say:focus { border-color: rgba(59,130,246,.55); background: rgba(255,255,255,.08); }
.mic, .go {
  flex: none; border: none; border-radius: 8px; cursor: pointer; pointer-events: auto;
  font-family: inherit; font-size: 12px; padding: 7px 9px; transition: background .12s;
}
.mic { background: rgba(255,255,255,.08); color: #9aa3af; }
.mic:hover { background: rgba(255,255,255,.14); color: #e2e8f0; }
.mic.on { background: #dc2626; color: #fff; }
.go { background: ${ACCENT}; color: #fff; font-weight: 500; }
.go:hover { background: #2563eb; }
.go:disabled { background: rgba(255,255,255,.08); color: #5f6875; cursor: not-allowed; }

/* 执行 / 完成 */
.line { font-size: 12.5px; color: #b7bec7; line-height: 1.8; word-break: break-all; }
.line .ok { color: #6ee7b7; }
.line .warn { color: #fbbf24; }
.bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,.09); overflow: hidden; margin-top: 10px; }
.bar > i { display: block; height: 100%; width: 30%; background: ${ACCENT}; animation: run 1.1s infinite; }
@keyframes run { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.acts { display: flex; gap: 6px; margin-top: 10px; }
.acts button {
  pointer-events: auto; flex: 1; font: inherit; font-size: 12px; padding: 6px 0;
  border-radius: 7px; border: 1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.06); color: #c9ced6; cursor: pointer; font-family: inherit;
}
.acts button:hover { background: rgba(255,255,255,.11); }
.acts button.primary { background: ${ACCENT}; border-color: transparent; color: #fff; }
pre.json {
  margin-top: 8px; max-height: 132px; overflow: auto; font-size: 10.5px; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #8b95a3; background: rgba(0,0,0,.32); border-radius: 7px; padding: 8px;
  white-space: pre-wrap; word-break: break-all;
}
details > summary { font-size: 11.5px; color: #7d8794; cursor: pointer; outline: none; pointer-events: auto; }
`;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS_TEXT);
  shadow.adoptedStyleSheets = [sheet];

  shadow.innerHTML = `
    <div class="hud">
      <div class="layer"></div>
      <button class="orb" title="点睛 · 点击开始（Demo 中替代唤醒词）">点睛</button>
      <div class="panel" hidden></div>
    </div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const layer = $('.layer');
  const orb = $('.orb');
  const panel = $('.panel');

  function mount() {
    if (!document.body) { requestAnimationFrame(mount); return; }
    document.body.appendChild(host);
  }
  mount();

  /* ==================== 画圈 ==================== */

  const canvas = document.createElement('canvas');
  canvas.id = '__ait_demo_canvas__';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2147483500;pointer-events:none;display:none;';
  const ctx = canvas.getContext('2d');

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function showCanvas(on) {
    if (on && !canvas.isConnected) { document.documentElement.appendChild(canvas); sizeCanvas(); }
    canvas.style.display = on ? 'block' : 'none';
  }

  function drawTrace() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pts = S.points;
    if (pts.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.closePath();
    ctx.fillStyle = 'rgba(59,130,246,.10)';
    ctx.fill();
  }

  function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function isHudPath(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(host) !== -1 || path.indexOf(canvas) !== -1;
  }

  function canDraw() {
    return S.mode === 'listening' || S.mode === 'drafting';
  }

  function onDown(e) {
    if (e.button !== 0 || !canDraw() || isHudPath(e)) return;
    e.preventDefault();
    e.stopPropagation();
    S.drawing = true;
    S.points = [{ x: e.clientX, y: e.clientY }];
    showCanvas(true);
    clearBoxes();
  }

  function onMove(e) {
    if (!S.drawing) return;
    e.preventDefault();
    e.stopPropagation();
    S.points.push({ x: e.clientX, y: e.clientY });
    drawTrace();
  }

  function onUp(e) {
    if (!S.drawing) return;
    e.preventDefault();
    e.stopPropagation();
    S.drawing = false;

    if (S.points.length < MIN_POINTS) {
      // 轨迹太短，按误触处理，不产生任何后果
      S.points = [];
      clearCanvas();
      showCanvas(false);
      return;
    }

    const pts = S.points.slice();
    clearCanvas();
    showCanvas(false);

    const cands = hitTest(pts);
    if (!cands.length) {
      S.draft.length ? render() : null;
      flash('圈里没有可选元素，换个圈试试');
      return;
    }
    S.candidates = cands;
    rank(S.currentText());
    S.target = S.candidates[0];
    if (S.mode === 'listening') S.mode = 'drafting';
    render();
    focusSay();
  }

  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('dragstart', (e) => { if (canDraw() && !isHudPath(e)) e.preventDefault(); }, true);

  /* ==================== 命中测试 ==================== */

  function selectable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === host || host.contains(el)) return false;
    if (el === canvas) return false;
    if (/^(HTML|BODY|SCRIPT|STYLE|HEAD|META|LINK|NOSCRIPT|TITLE)$/.test(el.tagName)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    if (r.width * r.height > window.innerWidth * window.innerHeight * 0.85) return false;
    return true;
  }

  function hitTest(points) {
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const x1 = Math.min.apply(null, xs), x2 = Math.max.apply(null, xs);
    const y1 = Math.min.apply(null, ys), y2 = Math.max.apply(null, ys);

    const N = 8;
    const votes = new Map();

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = x1 + (x2 - x1) * (i + 0.5) / N;
        const y = y1 + (y2 - y1) * (j + 0.5) / N;
        const stack = document.elementsFromPoint(x, y);
        for (let k = 0; k < stack.length; k++) {
          const el = stack[k];
          if (!selectable(el)) continue;
          votes.set(el, (votes.get(el) || 0) + 1);
          break;
        }
      }
    }

    const list = [];
    votes.forEach((v, el) => {
      const r = el.getBoundingClientRect();
      list.push({ el: el, votes: v, area: r.width * r.height, score: 0 });
    });
    list.sort((a, b) => (b.votes - a.votes) || (a.area - b.area));
    return list.slice(0, MAX_CANDS);
  }

  /* ==================== 语义匹配 ==================== */

  const TYPE_HINTS = [
    { re: /按钮|按一下|点它|button/i, tag: /^(BUTTON|A)$/ },
    { re: /输入|填|打字|input/i, tag: /^(INPUT|TEXTAREA)$/ },
    { re: /表格|列表|行|table/i, tag: /^(TABLE|TR|TD|TH|LI|UL|TBODY)$/ },
    { re: /卡片|卡/i, tag: /^(SECTION|DIV|ARTICLE)$/ },
    { re: /链接|link/i, tag: /^A$/ },
    { re: /标题|题目/i, tag: /^(H1|H2|H3|H4)$/ }
  ];

  function scoreOf(cand, text) {
    const el = cand.el;
    const t = (text || '').toLowerCase().replace(/\s+/g, '');
    let s = 0;

    const label = labelOf(el).toLowerCase().replace(/\s+/g, '');
    if (label && t && t.length >= 2 && (t.indexOf(label) !== -1 || label.indexOf(t) !== -1)) s += 60;

    const aria = (el.getAttribute('aria-label') || '').toLowerCase().replace(/\s+/g, '');
    if (aria && t && t.length >= 2 && (t.indexOf(aria) !== -1 || aria.indexOf(t) !== -1)) s += 45;

    for (let i = 0; i < TYPE_HINTS.length; i++) {
      if (TYPE_HINTS[i].re.test(text || '')) {
        if (TYPE_HINTS[i].tag.test(el.tagName)) s += 20;
        break;
      }
    }

    s += Math.min(15, cand.votes);
    if (sourceOf(el)) s += 5;

    const viewport = window.innerWidth * window.innerHeight;
    s += Math.max(0, 10 * (1 - Math.min(1, cand.area / (viewport * 0.2))));
    return Math.round(s);
  }

  function rank(text) {
    for (let i = 0; i < S.candidates.length; i++) {
      S.candidates[i].score = scoreOf(S.candidates[i], text);
    }
    S.candidates.sort((a, b) => (b.score - a.score) || (a.area - b.area));
  }

  function confidenceOf(cand) {
    if (!cand) return 0;
    return Math.min(0.99, Math.round((cand.score / 100) * 100) / 100);
  }

  /* ==================== 候选框 ==================== */

  let boxTimer = null;

  function clearBoxes() {
    layer.innerHTML = '';
  }

  function updateBoxes() {
    if (!S.target || S.mode === 'idle' || S.mode === 'listening') { clearBoxes(); return; }
    layer.innerHTML = '';
    if (!S.target.el || !S.target.el.isConnected) return;

    const r = S.target.el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'box locked';
    box.style.left = (r.left - 2) + 'px';
    box.style.top = (r.top - 2) + 'px';
    box.style.width = (r.width + 4) + 'px';
    box.style.height = (r.height + 4) + 'px';

    const tag = document.createElement('div');
    tag.className = 'box-tag';
    const loc = shortLoc(sourceOf(S.target.el));
    tag.textContent = labelOf(S.target.el).slice(0, 16) + (loc ? ' · ' + loc : '');
    // 优先放框下方，避免遮住元素上方的页面内容；下方不够再放上方，都不够才放进框内
    const below = window.innerHeight - (r.top + r.height);
    tag.style.top = below > 26 ? (r.height + 6) + 'px' : (r.top > 26 ? '-18px' : '2px');
    box.appendChild(tag);

    layer.appendChild(box);
  }

  function scheduleBoxes() {
    clearTimeout(boxTimer);
    boxTimer = setTimeout(updateBoxes, 40);
  }

  window.addEventListener('scroll', scheduleBoxes, true);
  window.addEventListener('resize', () => { sizeCanvas(); scheduleBoxes(); });

  /* ==================== 本地桥 ==================== */

  // 连接不在这里建：content script 的 WebSocket 带的是页面 Origin，会被桥按设计拒绝。
  // 真正的连接由 background service worker 持有，这里只同步状态、转发任务。
  const BRIDGE = {
    state: 'off',      // off | connecting | on | error
    url: '',
    detail: ''
  };

  function bridgeLabel() {
    if (BRIDGE.state === 'on') return '本地桥已连接';
    if (BRIDGE.state === 'connecting') return '正在连接本地桥';
    if (BRIDGE.state === 'error') return '本地桥未连接（' + (BRIDGE.detail || '连接失败') + '）';
    return '未配置本地桥口令';
  }

  function bridgeRepaint() {
    if (S.mode !== 'idle' && S.mode !== 'doing') render();
  }

  function bridgeSync() {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    try {
      chrome.runtime.sendMessage({ type: 'ait:status' }, function (res) {
        if (chrome.runtime.lastError || !res) return;
        BRIDGE.state = res.state;
        BRIDGE.detail = res.detail || '';
        BRIDGE.url = res.url || '';
        bridgeRepaint();
      });
    } catch (e) { /* 扩展重载后上下文失效 */ }
  }

  function bridgeSend(task) {
    if (BRIDGE.state !== 'on') return false;
    if (typeof chrome === 'undefined' || !chrome.runtime) return false;
    try {
      chrome.runtime.sendMessage({ type: 'ait:send', task: task }, function (res) {
        if (chrome.runtime.lastError) return;
        if (res && res.ok === false) {
          BRIDGE.state = 'error';
          BRIDGE.detail = res.reason || '发送失败';
          bridgeRepaint();
        }
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === 'ait:bridge') {
        BRIDGE.state = msg.state;
        BRIDGE.detail = msg.detail || '';
        BRIDGE.url = msg.url || '';
        if (S.mode !== 'idle') render();
      } else if (msg.type === 'ait:phase') {
        if (S.mode === 'doing' || S.mode === 'done') {
          S.statusText = msg.message || msg.phase;
          S.phaseFromBridge = true;
          render();
        }
      }
    });
  }

  /* ==================== 语音输入（可选通道） ==================== */

  let recog = null;
  let listeningMic = false;

  function toggleMic() {
    if (listeningMic) { stopMic(); return; }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      flash('此浏览器不支持语音识别，用输入条代替');
      return;
    }
    try {
      recog = new SR();
      recog.lang = 'zh-CN';
      recog.interimResults = false;
      recog.continuous = false;
      recog.onresult = (ev) => {
        const text = ev.results[0][0].transcript.trim();
        if (text) addSentence(text);
      };
      recog.onerror = (ev) => {
        stopMic();
        flash('语音识别不可用（' + (ev.error || 'unknown') + '），用输入条代替');
      };
      recog.onend = () => stopMic();
      recog.start();
      listeningMic = true;
      render();
    } catch (err) {
      flash('语音启动失败，用输入条代替');
    }
  }

  function stopMic() {
    listeningMic = false;
    if (recog) { try { recog.stop(); } catch (e) {} recog = null; }
    render();
  }

  /* ==================== 文本清洗与命令 ==================== */

  function clean(text) {
    let t = String(text || '').trim();
    t = t.replace(/^(呃|嗯|啊|那个|然后)[，,、\s]*/g, '');
    t = t.replace(/(呃|嗯)[，,、\s]*/g, '');
    t = t.replace(/\s+/g, ' ');
    return t;
  }

  const NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };

  function tryCommand(text) {
    const t = text.replace(/[\s，。！？、,.!?]/g, '');

    if (/^(开始改|开始|执行|改吧|开始执行)$/.test(t)) {
      submit();
      return true;
    }
    if (/^(不要了|清空|算了|全部删掉|都删掉)$/.test(t)) {
      S.draft = [];
      S.mode = S.target ? 'drafting' : 'listening';
      render();
      return true;
    }
    const m = t.match(/^(?:删掉|删除|去掉)?第([一二三四五12345])条?(?:不要|删掉|去掉)?$/);
    if (m) {
      const idx = NUM[m[1]];
      if (idx && S.draft[idx - 1]) {
        S.draft.splice(idx - 1, 1);
        render();
        return true;
      }
    }
    return false;
  }

  function addSentence(raw) {
    const text = clean(raw);
    if (!text) return;
    if (tryCommand(text)) return;

    S.draft.push({ id: uid('s'), text: text });
    if (S.candidates.length) {
      rank(S.currentText());
      S.target = S.candidates[0];
    }
    if (S.mode === 'listening' && S.target) S.mode = 'drafting';
    render();
  }

  S.currentText = function () {
    return S.draft.map(d => d.text).join(' ');
  };

  /* ==================== 上下文包 ==================== */

  function readLogs() {
    const node = document.getElementById('__ait_logs');
    if (!node || !node.textContent) return [];
    let all = [];
    try { all = JSON.parse(node.textContent); } catch (e) { return []; }

    const since = Date.now() - 60 * 1000;
    const recent = all.filter(l => {
      const t = Date.parse(l.ts);
      return isNaN(t) || t >= since;
    });
    const pick = (recent.length ? recent : all).slice(-MAX_LOGS);

    return pick.map(l => ({
      trace_id: l.trace_id || '',
      level: l.level || 'INFO',
      method: l.method || '',
      path: redact(l.path || ''),
      status: l.status || 0,
      message: redact(l.message || ''),
      ts: l.ts
    }));
  }

  function redact(s) {
    return String(s)
      .replace(/1[3-9]\d{9}/g, '[REDACTED_PHONE]')
      .replace(/\b\d{17}[\dxX]\b/g, '[REDACTED_ID]')
      .replace(/(Bearer\s+)[\w\-._~+/]+=*/gi, '$1[REDACTED]')
      .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
  }

  function buildPayload() {
    const cand = S.target;
    const el = cand.el;
    const r = el.getBoundingClientRect();
    const logs = readLogs();
    const traces = [];
    const seen = {};
    for (let i = 0; i < logs.length; i++) {
      const id = logs[i].trace_id;
      if (id && !seen[id]) {
        seen[id] = 1;
        traces.push({ trace_id: id, captured_at: logs[i].ts });
      }
    }

    return {
      event: 'ait_task',
      version: 'ait-demo/0.1',
      taskId: uid('tk'),
      createdAt: new Date().toISOString(),
      page: {
        url: location.href,
        title: document.title,
        path: location.pathname,
        route: location.pathname
      },
      target: {
        selector: cssPath(el),
        tag: el.tagName,
        text: labelOf(el).slice(0, 60),
        source: sourceOf(el) || null,
        sourceLoc: shortLoc(sourceOf(el)) || null,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        confidence: confidenceOf(cand),
        candidateCount: S.candidates.length
      },
      instruction: {
        text: S.draft.map(d => d.text).join('；'),
        source: 'voice',
        mode: 'simulated-asr',
        raw: S.draft.map(d => d.text).join('；')
      },
      draft: S.draft.map((d, i) => ({ index: i + 1, text: d.text })),
      traces: traces,
      logs: logs,
      secrets_redacted: true
    };
  }

  /* ==================== 应用改动 ==================== */

  const ACTIONS = [
    { re: /绿|green/i, label: '主色改为绿', fn: el => { el.style.background = '#10b981'; el.style.borderColor = '#10b981'; el.style.color = '#ffffff'; } },
    { re: /蓝|blue/i, label: '主色改为蓝', fn: el => { el.style.background = '#2563eb'; el.style.borderColor = '#2563eb'; el.style.color = '#ffffff'; } },
    { re: /红|red/i, label: '主色改为红', fn: el => { el.style.background = '#ef4444'; el.style.borderColor = '#ef4444'; el.style.color = '#ffffff'; } },
    { re: /大一点|大点|字号大|放大|大一些/i, label: '字号加大', fn: el => { el.style.fontSize = bumpSize(el, 2); } },
    { re: /小一点|小点|字号小|缩小|小一些/i, label: '字号缩小', fn: el => { el.style.fontSize = bumpSize(el, -2); } },
    { re: /加粗|粗体|加黑/i, label: '字重加粗', fn: el => { el.style.fontWeight = '600'; } },
    { re: /圆角/i, label: '加圆角', fn: el => { el.style.borderRadius = '14px'; } },
    { re: /阴影|投影/i, label: '加阴影', fn: el => { el.style.boxShadow = '0 8px 24px rgba(0,0,0,.18)'; } },
    { re: /隐藏|藏起来|不要显示|去掉/i, label: '隐藏元素', fn: el => { el.style.opacity = '0'; el.style.pointerEvents = 'none'; } },
    { re: /宽一点|宽一些|加宽/i, label: '加宽', fn: el => { el.style.width = Math.round(el.getBoundingClientRect().width * 1.3) + 'px'; } },
    { re: /居中|中间/i, label: '文本居中', fn: el => { el.style.textAlign = 'center'; el.style.justifyContent = 'center'; } },
    { re: /间距|留白|padding/i, label: '内边距加大', fn: el => { el.style.padding = '10px 16px'; } }
  ];

  function bumpSize(el, delta) {
    const cur = parseFloat(getComputedStyle(el).fontSize) || 14;
    return Math.round(cur + delta) + 'px';
  }

  function applyChanges() {
    const el = S.target.el;
    S.snapshot = [{ el: el, cssText: el.style.cssText }];

    let changed = 0;
    const hits = [];

    for (let i = 0; i < S.draft.length; i++) {
      const text = S.draft[i].text;
      for (let j = 0; j < ACTIONS.length; j++) {
        if (ACTIONS[j].re.test(text)) {
          ACTIONS[j].fn(el);
          changed++;
          hits.push(ACTIONS[j].label);
          break;
        }
      }
    }

    if (!changed) {
      el.style.outline = '2px solid #3b82f6';
      el.style.outlineOffset = '2px';
      changed = 1;
      hits.push('标记（未识别具体改法）');
    }

    S.hits = hits;
    return changed;
  }

  function rollback() {
    if (!S.snapshot) return;
    for (let i = 0; i < S.snapshot.length; i++) {
      S.snapshot[i].el.style.cssText = S.snapshot[i].cssText;
    }
    S.snapshot = null;
    S.changed = 0;
    flash('已撤回');
    S.mode = 'drafting';
    render();
  }

  /* ==================== 提交流程 ==================== */

  async function submit() {
    if (!S.draft.length) { flash('还没有要改的内容'); return; }
    if (!S.target) { flash('先画个圈选中要改的元素'); return; }

    S.mode = 'doing';
    S.statusText = '整理上下文…';
    render();

    const payload = buildPayload();
    const sent = bridgeSend(payload);
    S.channel = sent ? 'bridge' : 'clipboard';

    if (!sent) copyText(JSON.stringify(payload, null, 2));

    const where = payload.target.sourceLoc || payload.target.selector.slice(0, 24);

    await sleep(520);
    // 桥回执比本地文案更可信，收到了就不要覆盖
    if (!S.phaseFromBridge) {
      S.statusText = (sent ? '已发送到本地桥 · ' : '已复制上下文包 · ') + where;
    }
    render();

    await sleep(680);
    S.changed = applyChanges();
    S.mode = 'done';
    render();
    updateBoxes();
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {});
        return true;
      }
    } catch (e) { /* 忽略，UI 另有降级提示 */ }
    return false;
  }

  /* ==================== 渲染 ==================== */

  function renderListening() {
    const secs = ((Date.now() - S.startedAt) / 1000).toFixed(1);
    panel.innerHTML =
      '<div class="head">' +
        '<span class="dot live"></span>' +
        '<span class="status">聆听中</span>' +
        '<span class="meta">' + secs + 's</span>' +
        '<button class="close" data-act="close">×</button>' +
      '</div>' +
      '<div class="body">' +
        '<div class="tip">在页面上拖一个圈，然后说出要改什么。<br>也可以直接说，<b>我先把话记下来</b>。' +
          '<br><span style="opacity:.55;font-size:11px">' + esc(bridgeLabel()) + '</span></div>' +
        '<div class="wave">' +
          '<i style="animation-delay:0s"></i><i style="animation-delay:.12s"></i><i style="animation-delay:.24s"></i>' +
          '<i style="animation-delay:.36s"></i><i style="animation-delay:.48s"></i>' +
        '</div>' +
      '</div>' +
      footHtml();
    bindFoot();
  }

  function renderDrafting() {
    const cand = S.target;
    const el = cand.el;
    const loc = shortLoc(sourceOf(el));
    // 与目标互为父子关系的候选不算"备选"——指向它们等于指向同一块内容
    const others = S.candidates.slice(1)
      .filter(c => c.el !== el && !c.el.contains(el) && !el.contains(c.el))
      .map(c => labelOf(c.el).trim())
      .filter(t => t && t.length >= 2)
      .slice(0, 2)
      .map(t => t.slice(0, 8));

    let html = '';
    html += '<div class="head">' +
      '<span class="dot live"></span>' +
      '<span class="status">草稿 · ' + S.draft.length + ' 句</span>' +
      '<span class="meta">' + esc(cand.score) + ' 分</span>' +
      '<button class="close" data-act="close">×</button>' +
    '</div>';

    html += '<div class="body">';
    html += '<div class="target">' +
      '<span class="tag">' + esc(el.tagName) + '</span>' +
      '<span class="name">' + esc(labelOf(el).slice(0, 18)) + '</span>' +
      (loc ? '<span class="loc">' + esc(loc) + '</span>' : '<span class="loc none">无 data-ait</span>') +
    '</div>';

    if (S.draft.length) {
      html += '<ol class="draft">';
      for (let i = 0; i < S.draft.length; i++) {
        html += '<li><span class="n">' + (i + 1) + '</span>' +
                '<span class="t">' + esc(S.draft[i].text) + '</span>' +
                '<button class="x" data-del="' + S.draft[i].id + '">×</button></li>';
      }
      html += '</ol>';
    } else {
      html += '<div class="empty">还没有内容。说出要改什么，回车成句。</div>';
    }

    if (others.length) {
      html += '<div class="cands">候选 ' + S.candidates.length + ' 个：<b>' +
              esc(labelOf(el).slice(0, 10)) + '</b>' +
              '<span class="sep"> · </span>' + others.map(esc).join('<span class="sep"> · </span>') + '</div>';
    }

    html += '</div>';
    html += footHtml();
    panel.innerHTML = html;
    bindFoot();
  }

  function renderDoing() {
    panel.innerHTML =
      '<div class="head">' +
        '<span class="dot live"></span>' +
        '<span class="status">正在改</span>' +
        '<span class="meta">' + S.draft.length + ' 句</span>' +
      '</div>' +
      '<div class="body">' +
        '<div class="line">' + esc(S.statusText) + '</div>' +
        '<div class="bar"><i></i></div>' +
      '</div>';
  }

  function renderDone() {
    const loc = S.target && S.target.el ? shortLoc(sourceOf(S.target.el)) : '';
    const hits = S.hits || [];

    panel.innerHTML =
      '<div class="head">' +
        '<span class="dot"></span>' +
        '<span class="status">已改好</span>' +
        '<span class="meta">' + S.changed + ' 处变更</span>' +
      '</div>' +
      '<div class="body">' +
        '<div class="line"><span class="ok">' + esc(hits.join(' · ') || '已应用') + '</span>' +
          (loc ? '<br><span style="color:#7d8794;font-size:11px">' + esc(loc) + '</span>' : '') +
        '</div>' +
        '<div style="font-size:11px;color:#7d8794;margin-top:4px;line-height:1.5">' +
          (S.channel === 'bridge'
            ? '已发送到本地桥，等 Agent 回执。页面上的变化是本地预览。'
            : '未连接本地桥，上下文包已复制到剪贴板。页面上的变化是本地预览。') +
        '</div>' +
        (S.statusText && S.channel === 'bridge'
          ? '<div style="font-size:11px;color:#8ea2c0;margin-top:4px">桥回执：' + esc(S.statusText) + '</div>'
          : '') +
        '<details style="margin-top:8px"><summary>上下文包（已复制到剪贴板）</summary>' +
          '<pre class="json">' + esc(JSON.stringify(buildPayload(), null, 2)).slice(0, 1400) + '</pre>' +
        '</details>' +
        '<div class="acts">' +
          '<button data-act="rollback">撤回</button>' +
          '<button class="primary" data-act="again">再改一处</button>' +
        '</div>' +
      '</div>';
  }

  function footHtml() {
    return '<div class="foot">' +
      '<div class="row">' +
        '<input class="say" placeholder="打字模拟语音">' +
        '<button class="mic' + (listeningMic ? ' on' : '') + '" data-act="mic" title="尝试真实语音">🎤</button>' +
        '<button class="go" data-act="go"' + (S.draft.length ? '' : ' disabled') + '>开始改</button>' +
      '</div>' +
    '</div>';
  }

  function bindFoot() {
    const say = panel.querySelector('.say');
    if (say) {
      say.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          const v = say.value;
          say.value = '';
          addSentence(v);
        }
      });
    }
  }

  function focusSay() {
    const say = panel.querySelector('.say');
    if (say) setTimeout(function () { try { say.focus(); } catch (e) {} }, 30);
  }

  function flash(msg) {
    if (S.mode === 'idle') {
      S.mode = 'listening';
      S.startedAt = Date.now();
    }
    render();
    const body = panel.querySelector('.body');
    if (!body) return;
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.style.cssText = 'margin-top:8px;color:#fbbf24';
    tip.textContent = msg;
    body.appendChild(tip);
    setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 2600);
  }

  function render() {
    const idle = S.mode === 'idle';
    orb.hidden = !idle;
    panel.hidden = idle;

    if (idle) { clearBoxes(); return; }
    if (S.mode === 'listening') renderListening();
    else if (S.mode === 'drafting') renderDrafting();
    else if (S.mode === 'doing') renderDoing();
    else if (S.mode === 'done') renderDone();

    updateBoxes();
  }

  /* ==================== 事件绑定 ==================== */

  orb.addEventListener('click', function () {
    S.mode = 'listening';
    S.startedAt = Date.now();
    S.points = [];
    render();
  });

  panel.addEventListener('click', function (e) {
    const t = e.target;
    const act = t.getAttribute && t.getAttribute('data-act');
    const del = t.getAttribute && t.getAttribute('data-del');

    if (del) {
      S.draft = S.draft.filter(function (d) { return d.id !== del; });
      if (S.candidates.length) { rank(S.currentText()); S.target = S.candidates[0]; }
      render();
      return;
    }

    if (!act) return;

    if (act === 'close') {
      S.mode = 'idle';
      S.points = [];
      render();
    } else if (act === 'go') {
      submit();
    } else if (act === 'mic') {
      toggleMic();
    } else if (act === 'rollback') {
      rollback();
    } else if (act === 'again') {
      S.mode = 'listening';
      S.startedAt = Date.now();
      S.draft = [];
      S.target = null;
      S.candidates = [];
      S.snapshot = null;
      S.changed = 0;
      render();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.mode !== 'idle') {
      S.mode = 'idle';
      S.points = [];
      render();
    }
  }, true);

  // 聆听态计时刷新
  setInterval(function () {
    if (S.mode !== 'listening') return;
    const meta = panel.querySelector('.meta');
    if (meta) meta.textContent = ((Date.now() - S.startedAt) / 1000).toFixed(1) + 's';
  }, 200);

  /* ==================== 启动 ==================== */

  render();
  bridgeSync();

  console.log('[AIT] ready ·', document.querySelectorAll('[data-ait]').length, '个元素带 data-ait');
})();
