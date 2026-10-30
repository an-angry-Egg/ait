/* 演示页自身逻辑：产生假后端日志，供扩展按 trace 关联 */

(function () {
  'use strict';

  // ---------- 假后端日志 ----------

  window.__AIT_LOGS__ = [];

  let seq = 0;
  const trace = () => 'tr-' + (Date.now().toString(36).slice(-5)) + (seq++).toString(36).padStart(2, '0');

  function pushLog(entry) {
    const item = {
      trace_id: entry.trace_id || trace(),
      ts: new Date().toISOString(),
      level: entry.level || 'INFO',
      method: entry.method || 'GET',
      path: entry.path || '/',
      status: entry.status || 200,
      message: entry.message || ''
    };
    window.__AIT_LOGS__.push(item);
    if (window.__AIT_LOGS__.length > 60) window.__AIT_LOGS__.shift();
    return item;
  }

  // content script 运行在 isolated world，读不到 window.__AIT_LOGS__，
  // 因此把日志镜像到 DOM，扩展从 DOM 取（Demo 专用的跨世界通道）
  function mirrorToDom() {
    let node = document.getElementById('__ait_logs');
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = '__ait_logs';
      node.hidden = true;
      document.body.appendChild(node);
    }
    node.textContent = JSON.stringify(window.__AIT_LOGS__);
  }

  function renderLogs() {
    mirrorToDom();
    const box = document.getElementById('log-list');
    if (!box) return;
    box.innerHTML = window.__AIT_LOGS__
      .slice()
      .reverse()
      .map(l => {
        const lv = l.level === 'ERROR' ? 'error' : l.level === 'WARN' ? 'warn' : 'info';
        const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false });
        return `<div class="log-item ${lv}">${t} ${l.level.padEnd(5)} ${l.method} ${l.path} ${l.status} — ${escapeHtml(l.message)} <span style="color:#4b5563">[${l.trace_id}]</span></div>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- 页面行为 + 埋日志 ----------

  const $ = id => document.getElementById(id);

  $('edit-profile').addEventListener('click', () => {
    const t = trace();
    pushLog({ trace_id: t, method: 'GET', path: '/api/user/profile', status: 200, message: 'profile loaded in 32ms' });
    pushLog({ trace_id: t, level: 'WARN', method: 'PUT', path: '/api/user/profile', status: 422,
              message: 'validation failed: nickname duplicated' });
    renderLogs();
    toast('打开编辑面板（Demo 中无实际动作）');
  });

  $('send-msg').addEventListener('click', () => {
    const t = trace();
    pushLog({ trace_id: t, method: 'POST', path: '/api/messages', status: 201, message: 'message queued' });
    renderLogs();
    toast('消息已发送');
  });

  $('more').addEventListener('click', () => {
    pushLog({ method: 'GET', path: '/api/user/actions', status: 200, message: '3 actions available' });
    renderLogs();
    toast('更多操作');
  });

  $('save-all').addEventListener('click', () => {
    const t = trace();
    pushLog({ trace_id: t, method: 'PUT', path: '/api/user/profile', status: 200, message: 'saved 2 fields' });
    pushLog({ trace_id: t, method: 'PUT', path: '/api/user/preferences', status: 200, message: 'saved' });
    renderLogs();
    toast('已保存');
  });

  $('export').addEventListener('click', () => {
    pushLog({ method: 'POST', path: '/api/export', status: 202, message: 'export job created' });
    renderLogs();
    toast('导出任务已创建');
  });

  $('refresh-log').addEventListener('click', () => {
    const t = trace();
    pushLog({ trace_id: t, method: 'GET', path: '/api/user/logins', status: 200, message: '3 records' });
    pushLog({ trace_id: t, level: 'WARN', method: 'GET', path: '/api/geo/lookup', status: 503,
              message: 'geo service timeout, fallback to unknown' });
    renderLogs();
    toast('登录记录已刷新');
  });

  $('profile-form').addEventListener('submit', e => {
    e.preventDefault();
    const t = trace();
    pushLog({ trace_id: t, method: 'PUT', path: '/api/user/profile', status: 422,
              message: 'validation failed: phone number is not bound' });
    renderLogs();
    toast('保存失败：手机号未绑定（Demo 预设）');
  });

  $('log-toggle').addEventListener('click', e => {
    const card = $('log-card');
    card.classList.toggle('collapsed');
    e.target.textContent = card.classList.contains('collapsed') ? '展开' : '收起';
  });

  // ---------- 初始日志 ----------

  const boot = trace();
  pushLog({ trace_id: boot, method: 'GET', path: '/api/user/profile', status: 200, message: 'initial load' });
  pushLog({ trace_id: boot, method: 'GET', path: '/api/user/logins', status: 200, message: '3 records' });
  pushLog({ level: 'INFO', method: 'GET', path: '/api/feature-flags', status: 200, message: 'flags loaded' });
  renderLogs();

  // 供扩展读取
  window.__AIT_DEMO_READY__ = true;
})();
