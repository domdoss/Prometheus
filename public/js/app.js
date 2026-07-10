/* Warden dashboard — rewritten v2 app controller.
 *
 * Wires every endpoint in src/status-server.ts that's in scope for the
 * single-user Warden dashboard:
 *   GET    /api/status              — verbose bar, agent activity, metrics
 *   GET    /api/settings           — load settings
 *   POST   /api/settings           — save settings (orchestrator/atlas/council/ctx/...)
 *   GET    /api/messages?jid&since&limit&idea
 *   POST   /api/messages            — { text, jid, sender_name, model, thinking, idea, verbose }
 *   GET    /api/ollama/test         — list of local models, friendly names, cloud models, thinking
 *   POST   /api/ollama/model-names  — { names }
 *   POST   /api/ollama/model-names  — { names }
 *   GET    /api/automation/model   — { model }
 *   POST   /api/automation/model    — { model }
 *   GET    /api/tasks               — { tasks: [...] }
 *   POST   /api/tasks               — create
 *   PATCH  /api/tasks/:id           — { status }
 *   DELETE /api/tasks/:id
 *   GET    /api/skills              — { installed: { name: bool, ... } }
 *   POST   /api/audit/run
 *   GET    /api/audit/status
 *   GET    /api/process-logs?lines=
 *   POST   /api/process-logs        — { action: 'truncate' }
 *   POST   /api/agents/kill
 *   POST   /api/chat/stop           — { jid, advance_cursor }
 *   POST   /api/server/restart
 *   GET    /api/activity?limit=
 *   GET    /api/search?q=
 *   GET    /api/groups               — single-owner stub
 *   GET    /api/notifications (SSE)  — broadcast
 *   GET    /api/notifications/poll   — fallback
 */

(function () {
  'use strict';

  // ============================================================= State
  const STATE = {
    currentView: 'chat',
    currentJid: 'owner@local',
    chatLastTs: '',
    polling: false,
    pollTimer: null,
    verboseTimer: null,
    statusTimer: null,
    activityTimer: null,
    assistantName: 'WARDEN',
    localAssistantName: 'Warden',
    // Server-reported timezone (America/Vancouver). Used to render chat timestamps
    // in Warden's local time regardless of the viewer's browser/OS timezone — a
    // browser in PST (UTC-8) would otherwise show every message 1h behind PDT.
    timezone: '',
    cachedOllamaModels: [],
    cachedFriendlyNames: {},
    cachedCloudModels: [],
    cachedThinking: {},
    cachedSettings: null,
    renderedMessageIds: new Set(),
    currentIdea: '',
    currentSender: 'Dominic',
    currentSenderKey: 'dominic',
    senders: [
      { key: 'dominic', name: 'Dominic', color: '#5eead4' },
    ],
    pendingMessages: [],
    stopSuppressUntil: 0,
    waitingForReply: false,
    auditRunning: false,
    auditPollTimer: null,
    selectedAttachments: [],
    sseSource: null,
    notifPollTimer: null,
    cachedStatus: null,
  };

  // ============================================================= Helpers
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return esc(s); }

  function fmtUptime(s) {
    if (!s || s < 0) return '--';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + 'd' + h + 'h';
    if (h) return h + 'h' + m + 'm';
    if (m) return m + 'm' + sec + 's';
    return sec + 's';
  }
  function fmtTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      // Render in Warden's server timezone (STATE.timezone) when available so
      // chat times match the host clock even if the viewer's browser is in a
      // different/off-by-one timezone. Falls back to browser default before the
      // first status poll lands.
      const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
      if (STATE.timezone) opts.timeZone = STATE.timezone;
      return d.toLocaleTimeString([], opts);
    } catch { return ts; }
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '--';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + u[i];
  }

  function renderMarkdown(text) {
    if (!text) return '';

    const fences = [];
    const stashed = String(text).replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (_, _lang, body) => {
      const i = fences.length;
      fences.push(esc(body.replace(/\n$/, '')));
      return '\x00F' + i + '\x00';
    });

    const inline = (s) => {
      let x = esc(s);
      x = x.replace(/`([^`\n]+)`/g, (_, c) => '<code>' + c + '</code>');
      x = x.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      x = x.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s)!?.,;:]|$)/g, '$1<em>$2</em>');
      x = x.replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s)!?.,;:]|$)/g, '$1<em>$2</em>');
      x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      x = x.replace(/\x00F(\d+)\x00/g, (_, i) => '<pre><code>' + fences[Number(i)] + '</code></pre>');
      return x;
    };

    const lines = stashed.split(/\r?\n/);
    const out = [];
    let list = null;
    let quote = false;
    let para = [];

    const flushPara = () => {
      if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; }
    };
    const flushList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const flushQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    const splitRow = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const isTableSep = (s) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(s);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\x00F\d+\x00$/.test(line.trim())) { flushAll(); out.push(inline(line.trim())); continue; }
      if (!line.trim()) { flushAll(); continue; }

      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushAll();
        const headers = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(':');
          const r = c.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].indexOf('|') >= 0 && lines[j].trim()) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        let html = '<table><thead><tr>';
        for (let k = 0; k < headers.length; k++) {
          const a = align[k] ? ' style="text-align:' + align[k] + '"' : '';
          html += '<th' + a + '>' + inline(headers[k]) + '</th>';
        }
        html += '</tr></thead><tbody>';
        for (const row of rows) {
          html += '<tr>';
          for (let k = 0; k < headers.length; k++) {
            const a = align[k] ? ' style="text-align:' + align[k] + '"' : '';
            html += '<td' + a + '>' + inline(row[k] || '') + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        out.push(html);
        i = j - 1;
        continue;
      }

      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) { flushAll(); const n = h[1].length; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); continue; }

      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

      const ul = /^\s*[-*]\s+(.+)$/.exec(line);
      if (ul) {
        flushPara(); flushQuote();
        if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(ul[1]) + '</li>');
        continue;
      }

      const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (ol) {
        flushPara(); flushQuote();
        if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(ol[1]) + '</li>');
        continue;
      }

      const bq = /^>\s?(.*)$/.exec(line);
      if (bq) {
        flushPara(); flushList();
        if (!quote) { out.push('<blockquote>'); quote = true; }
        out.push('<p>' + inline(bq[1]) + '</p>');
        continue;
      }

      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();

    return out.join('\n');
  }

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = message;
    $('toastContainer').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, 4200);
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return r.json();
    return r.text();
  }
  function postJson(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function patchJson(path, body) {
    return api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function putJson(path, body) {
    return api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function del(path, body) {
    const opts = { method: 'DELETE' };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    return api(path, opts);
  }

  // ============================================================= View switching
  function switchView(name) {
    // Ported home-view cards may target views that map to native ones here.
    if (name === 'automater' || name === 'files') name = 'tasks';
    if (!$('view-' + name)) return; // unknown view — don't blank the page
    STATE.currentView = name;
    qsa('.view').forEach(v => v.classList.remove('active'));
    const v = $('view-' + name);
    if (v) v.classList.add('active');
    qsa('.rail-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    closeDrawer();
    if (name === 'tasks') refreshTasks();
    else if (name === 'skills') { refreshSkills(); refreshMcp(); }
    else if (name === 'activity') refreshActivity();
    else if (name === 'logs') refreshProcessLogs();
    else if (name === 'accounts') refreshAccounts();
    else if (name === 'calendar' && window.PIM) window.PIM.refreshCalendar();
    else if (name === 'email' && window.PIM) window.PIM.refreshEmail();
    else if (window.UserDash) {
      // Views ported from the groupware user dashboard (userdash-extras.js)
      const UD = window.UserDash;
      if (name === 'projects' && UD.loadProjects) UD.loadProjects();
      else if (name === 'heartbeat' && UD.loadHeartbeat) UD.loadHeartbeat();
      else if (name === 'alarms' && UD.loadAlarms) UD.loadAlarms();
      else if (name === 'vault' && UD.loadVault) UD.loadVault();
      else if (name === 'apikeys' && UD.loadUsageDashboard) UD.loadUsageDashboard();
      else if (name === 'actions' && UD.renderActions) UD.renderActions();
      else if (name === 'sms' && UD.loadSmsView) UD.loadSmsView();
      else if (name === 'talk' && UD.initTalkView) UD.initTalkView();
    }
  }
  window.__localSwitchView = switchView;

  // ============================================================= Status / verbose bar
  async function pollStatus() {
    try {
      const d = await api('/api/status');
      STATE.cachedStatus = d;
      if (d.assistant) { STATE.assistantName = d.assistant; $('assistantName').textContent = d.assistant.toUpperCase(); }
      if (d.localAssistant) STATE.localAssistantName = d.localAssistant;
      if (d.timezone) STATE.timezone = d.timezone;

      // topbar stats
      $('statUptime').textContent = fmtUptime(d.uptime);
      if (d.system) {
        $('statCpu').textContent = d.system.cpuPercent + '%';
        $('statMem').textContent = d.system.memPercent + '%';
      }
      $('statTasks').textContent = d.runningJobs != null ? d.runningJobs : '--';

      // dot
      const dot = $('statusDot');
      const groups = (d.groups || []);
      const active = groups.some(g => g.active && !g.idle);
      dot.className = 'dot' + (active ? ' busy' : '');

      // verbose bar
      const g = groups.find(x => x.jid === STATE.currentJid) || groups[0];
      updateVerboseBar(g);

      // stop button enable/disable
      $('btnStop').disabled = !active;
    } catch (e) {
      $('statusDot').className = 'dot dead';
    }
  }

  function updateVerboseBar(g) {
    const bar = $('verboseBar');
    if (!bar) return;
    const phaseEl = qs('.phase', bar);
    const toolsEl = qs('.tools', bar);
    const active = g && g.active && !g.idle;
    const label = g && g.liveLabel ? g.liveLabel : '';
    const phase = g && g.livePhase ? g.livePhase : '';
    const tools = g && g.liveTools && g.liveTools.length ? g.liveTools : [];
    // Background Atlas jobs keep emitting status after the orchestrator's turn
    // ends (the group goes idle), so treat a fresh label as live even when the
    // group isn't active — otherwise the bar flips to "idle" while Atlas is
    // still working in the background.
    const fresh = g && g.liveTs && (Date.now() - g.liveTs < 30000);
    if ((active || fresh) && (label || phase)) {
      bar.classList.remove('idle');
      phaseEl.textContent = label || phase;
      toolsEl.textContent = tools.length ? '· ' + tools.join(', ') : '';
      bar.style.display = '';
    } else {
      bar.classList.add('idle');
      phaseEl.textContent = 'idle';
      toolsEl.textContent = '';
    }
  }

  function startStatusPolling() {
    if (STATE.statusTimer) clearInterval(STATE.statusTimer);
    pollStatus();
    STATE.statusTimer = setInterval(pollStatus, 5000);
  }

  // ============================================================= Chat
  async function loadMessages() {
    try {
      const url = '/api/messages?jid=' + encodeURIComponent(STATE.currentJid) +
        '&limit=200&idea=' + encodeURIComponent(STATE.currentIdea);
      const d = await api(url);
      renderMessages(d.messages || []);
      if (d.messages && d.messages.length) {
        STATE.chatLastTs = d.messages[d.messages.length - 1].timestamp;
        STATE.waitingForReply = false;
      }
    } catch (e) {
      console.error('loadMessages', e);
    }
  }

  function renderMessages(messages) {
    const el = $('messages');
    const empty = $('msgEmpty');
    // keep empty state as first child but hidden if any msgs
    qsa('.msg', el).forEach(n => n.remove());
    STATE.renderedMessageIds.clear();
    if (!messages.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    for (const m of messages) appendMessage(m);
    el.scrollTop = el.scrollHeight;
  }

  function appendMessage(m) {
    const el = $('messages');
    const empty = $('msgEmpty');
    if (m.id && STATE.renderedMessageIds.has(m.id)) return null;
    if (m.id) STATE.renderedMessageIds.add(m.id);
    if (empty) empty.style.display = 'none';
    const div = document.createElement('div');
    const isBot = !!m.is_bot_message;
    div.className = 'msg ' + (isBot ? 'bot' : 'user');
    const sender = isBot ? (m.sender_name || STATE.assistantName) : (m.sender_name || m.sender || 'You');
    const ts = fmtTime(m.timestamp);
    div.innerHTML =
      '<div class="msg-text">' + renderMarkdown(m.content || '') + '</div>' +
      '<div class="msg-meta"><span class="sender ' + (isBot ? 'bot' : '') + '">' + esc(sender) + '</span>' +
      '<span class="ts">' + esc(ts) + '</span></div>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    return div;
  }

  function appendPendingMsg(text) {
    const el = $('messages');
    const empty = $('msgEmpty');
    if (empty) empty.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'msg user pending';
    div.innerHTML =
      '<div class="msg-text">' + renderMarkdown(text) + '</div>' +
      '<div class="msg-meta"><span class="sender">You</span><span class="ts">sending…</span></div>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    return div;
  }

  function markMsgFailed(pendingEl, text) {
    if (!pendingEl) return;
    pendingEl.classList.remove('pending');
    pendingEl.classList.add('failed');
    const meta = qs('.msg-meta', pendingEl);
    if (meta) {
      meta.innerHTML = '<span class="sender">You</span><span class="ts">not sent</span>' +
        ' <span class="retry">retry</span>';
      const r = qs('.retry', meta);
      if (r) r.addEventListener('click', () => { pendingEl.remove(); sendChatText(text); });
    }
  }

  async function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    await sendChatText(text);
  }

  async function sendChatText(text) {
    const pendingEl = appendPendingMsg(text);

    const payload = {
      text: text,
      jid: STATE.currentJid,
      sender_name: STATE.currentSender,
    };
    if (STATE.currentIdea) payload.idea = STATE.currentIdea;
    payload.verbose = true;

    try {
      await postJson('/api/messages', payload);
      STATE.stopSuppressUntil = 0;
      STATE.waitingForReply = true;
      // remove pending flag — real message will arrive via poll
      setTimeout(() => {
        if (pendingEl && pendingEl.parentNode) pendingEl.classList.remove('pending');
      }, 300);
      startChatPolling();
    } catch (e) {
      markMsgFailed(pendingEl, text);
      toast('Failed to send: ' + e.message, 'error');
    }
  }

  async function pollChat() {
    if (STATE.polling) return;
    STATE.polling = true;
    try {
      const url = '/api/messages?jid=' + encodeURIComponent(STATE.currentJid) +
        '&since=' + encodeURIComponent(STATE.chatLastTs) +
        '&limit=100&idea=' + encodeURIComponent(STATE.currentIdea);
      const d = await api(url);
      const msgs = d.messages || [];
      if (msgs.length) {
        for (const m of msgs) {
          appendMessage(m);
          // a real user message arriving from the server means the pending
          // placeholder is now duplicated — remove it
          if (!m.is_bot_message) {
            qsa('.msg.user.pending', $('messages')).forEach(n => n.remove());
          }
        }
        STATE.chatLastTs = msgs[msgs.length - 1].timestamp;
        // If we got a bot message, we're no longer waiting
        if (msgs.some(m => m.is_bot_message)) {
          STATE.waitingForReply = false;
          // remove any leftover pending user bubbles that the server has now stored
          qsa('.msg.user.pending', $('messages')).forEach(n => n.remove());
          // Auto-poll a bit longer in case follow-up chunks arrive
          if (!STATE.pollTimer) startChatPolling();
        }
      }
    } catch (e) {
      /* swallow; will retry next tick */
    } finally {
      STATE.polling = false;
    }
  }

  // Poll cadence: fast (2.5s) while a turn is in flight, slow (6s) while idle.
  // The slow poll always runs so pushed messages (Telegram, scheduled agents,
  // sub-agent replies) show up without a hard refresh.
  const FAST_POLL_MS = 2500;
  const SLOW_POLL_MS = 6000;
  function startChatPolling() {
    const tick = async () => {
      await pollChat();
      const idle = !STATE.waitingForReply && STATE.cachedStatus && isAgentIdle();
      const wantMode = idle ? 'slow' : 'fast';
      if (wantMode !== STATE.pollMode) {
        STATE.pollMode = wantMode;
        if (STATE.pollTimer) clearInterval(STATE.pollTimer);
        STATE.pollTimer = setInterval(tick, wantMode === 'slow' ? SLOW_POLL_MS : FAST_POLL_MS);
      }
    };
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollMode = 'fast';
    tick();
    STATE.pollTimer = setInterval(tick, FAST_POLL_MS);
  }

  function isAgentIdle() {
    const d = STATE.cachedStatus;
    if (!d) return true;
    const g = d.groups && d.groups.find(x => x.jid === STATE.currentJid);
    return !(g && g.active && !g.idle);
  }

  async function stopAgent() {
    try {
      await postJson('/api/chat/stop', { jid: STATE.currentJid, advance_cursor: true });
      toast('Stop sent', 'success');
      STATE.waitingForReply = false;
      pollStatus();
      startChatPolling();
    } catch (e) {
      toast('Stop failed: ' + e.message, 'error');
    }
  }

  async function restartServer() {
    if (!confirm('Restart the Warden server? It will be unavailable for a few seconds.')) return;
    try {
      await postJson('/api/server/restart', {});
      toast('Restart issued — server will be back in a few seconds', 'success');
    } catch (e) {
      toast('Restart failed: ' + e.message, 'error');
    }
  }

  function newThought() {
    // Clear the cursor and reload — equivalent to starting a fresh conversation
    STATE.chatLastTs = '';
    STATE.waitingForReply = false;
    loadMessages();
    startChatPolling();
    toast('New thought started', 'info');
  }

  // ============================================================= Settings drawer
  function openDrawer(title, bodyHtml) {
    $('drawerTitle').textContent = title;
    $('drawerBody').innerHTML = bodyHtml;
    $('drawer').classList.add('open');
    $('drawerBackdrop').classList.add('show');
  }
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawerBackdrop').classList.remove('show');
  }

  async function openSettings() {
    openDrawer('Settings', '<p class="dim mono" style="font-size:11px">Loading…</p>');
    try {
      await loadOllama();
      await loadSettingsValues();
    } catch (e) {
      console.error('openSettings', e);
    }
  }

  async function openAddPage() {
    openDrawer('Dashboard Pages (Beta)', '<p class="dim mono" style="font-size:11px">Loading…</p>');
    await renderDashboardPages();
  }

  async function renderDashboardPages() {
    let files = [];
    try {
      const d = await api('/api/dashboard-pages');
      files = d.files || [];
    } catch (e) {
      $('drawerBody').innerHTML = '<p class="dim" style="color:var(--danger)">Failed to load: ' + esc(e.message) + '</p>';
      return;
    }
    let html = '<div class="drawer-form">' +
      '<div class="help-callout help-callout-info" style="margin-bottom:14px">' +
        '<div class="help-callout-icon">β</div>' +
        '<div class="help-callout-body">' +
          '<p><strong>Beta → Live pipeline.</strong> Edit dashboard files in beta first, preview at <code>/beta/</code>, then promote. Live is backed up before every promotion so you can revert if something breaks.</p>' +
          '<p><strong>How to use:</strong> Tell Warden "add a dashboard page called X" or "edit the dashboard to add Y". Warden will write the change to <code>public/beta/</code>, then you preview and promote here.</p>' +
          '<p>Editable files: <code>index.html</code> (page structure + rail button), <code>js/app.js</code> (view logic), <code>css/style.css</code> (styling).</p>' +
          '<p><a href="/help/dashboard-pages.html" target="_blank">Read the full guide →</a></p>' +
        '</div>' +
      '</div>' +
      '<table class="dashboard-pages-table" style="width:100%;font-size:12px;border-collapse:collapse">' +
        '<thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">File</th><th style="text-align:center;padding:6px;border-bottom:1px solid var(--border)">Beta</th><th style="text-align:center;padding:6px;border-bottom:1px solid var(--border)">Live</th><th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">Actions</th></tr></thead>' +
        '<tbody>' +
        files.map(f => {
          const status = f.dirty ? '<span style="color:var(--warn)">draft</span>' : (f.beta ? '<span style="color:var(--text-faint)">same as live</span>' : '<span style="color:var(--text-faint)">no draft</span>');
          return '<tr>' +
            '<td style="padding:6px;border-bottom:1px solid var(--border)"><code>' + esc(f.file) + '</code><br><span class="dim" style="font-size:10px">' + status + '</span></td>' +
            '<td style="text-align:center;padding:6px;border-bottom:1px solid var(--border)">' + (f.beta ? '✓' : '—') + '</td>' +
            '<td style="text-align:center;padding:6px;border-bottom:1px solid var(--border)">' + (f.live ? '✓' : '—') + '</td>' +
            '<td style="padding:6px;border-bottom:1px solid var(--border)">' +
              '<button class="btn btn-ghost btn-sm btn-dp-edit" data-file="' + escAttr(f.file) + '" style="margin-right:4px">Edit beta</button>' +
              '<button class="btn btn-ghost btn-sm btn-dp-diff" data-file="' + escAttr(f.file) + '" style="margin-right:4px" ' + (f.beta && f.dirty ? '' : 'disabled') + '>Diff</button>' +
              '<button class="btn btn-primary btn-sm btn-dp-promote" data-file="' + escAttr(f.file) + '" style="margin-right:4px" ' + (f.beta && f.dirty ? '' : 'disabled') + '>Promote</button>' +
              '<button class="btn btn-danger btn-sm btn-dp-revert" data-file="' + escAttr(f.file) + '" ' + (f.live ? '' : 'disabled') + '>Revert</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
      '</tbody></table>' +
      '<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" id="btnDpRefresh">Refresh</button>' +
      ' <a class="btn btn-ghost btn-sm" href="/beta/" target="_blank">Open /beta preview</a>' +
      ' <a class="btn btn-ghost btn-sm" href="/help/dashboard-pages.html" target="_blank">Help →</a></div>' +
    '</div>';
    $('drawerBody').innerHTML = html;
    qsa('.btn-dp-edit', $('drawerBody')).forEach(b => b.addEventListener('click', () => openDashboardPageEditor(b.dataset.file)));
    qsa('.btn-dp-diff', $('drawerBody')).forEach(b => b.addEventListener('click', () => showDashboardPageDiff(b.dataset.file)));
    qsa('.btn-dp-promote', $('drawerBody')).forEach(b => b.addEventListener('click', () => promoteDashboardPage(b.dataset.file)));
    qsa('.btn-dp-revert', $('drawerBody')).forEach(b => b.addEventListener('click', () => revertDashboardPage(b.dataset.file)));
    $('btnDpRefresh').addEventListener('click', renderDashboardPages);
  }

  async function openDashboardPageEditor(file) {
    let content = '', which = 'beta';
    try {
      const d = await api('/api/dashboard-pages/' + encodeURIComponent(file) + '?which=beta');
      content = d.content || '';
      which = d.which || 'beta';
    } catch (e) {
      // No beta yet — seed from live
      try {
        const d = await api('/api/dashboard-pages/' + encodeURIComponent(file) + '?which=live');
        content = d.content || '';
        which = 'live';
      } catch (e2) {
        toast('Failed to load ' + file + ': ' + e2.message, 'error');
        return;
      }
    }
    const html = '<div class="drawer-form">' +
      '<p class="dim mono" style="font-size:11px">Editing <strong>' + esc(file) + '</strong> in beta. Preview at <a href="/beta/" target="_blank">/beta/</a> before promoting.</p>' +
      '<textarea class="input" id="dpEditor" style="min-height:360px;font-family:var(--font-mono);font-size:12px;white-space:pre">' + escAttr(content) + '</textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
        '<button class="btn btn-ghost btn-sm" id="btnDpCancel">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" id="btnDpSave">Save beta draft</button>' +
      '</div>' +
    '</div>';
    $('drawerBody').innerHTML = html;
    $('btnDpCancel').addEventListener('click', renderDashboardPages);
    $('btnDpSave').addEventListener('click', async () => {
      try {
        await postJson('/api/dashboard-pages/' + encodeURIComponent(file), { content: $('dpEditor').value });
        toast('Beta draft saved', 'success');
        await renderDashboardPages();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  async function showDashboardPageDiff(file) {
    try {
      const d = await api('/api/dashboard-pages/' + encodeURIComponent(file) + '/diff');
      const html = '<div class="drawer-form">' +
        '<p class="dim mono" style="font-size:11px">Diff for <strong>' + esc(file) + '</strong> (live → beta).</p>' +
        '<pre style="background:var(--surface-2);padding:10px;border-radius:6px;font-size:10px;overflow:auto;max-height:420px">' + esc(d.diff || 'no diff') + '</pre>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button class="btn btn-ghost btn-sm" id="btnDpDiffBack">Back</button></div>' +
      '</div>';
      $('drawerBody').innerHTML = html;
      $('btnDpDiffBack').addEventListener('click', renderDashboardPages);
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function promoteDashboardPage(file) {
    if (!confirm('Promote ' + file + ' from beta to live? Live will be backed up.')) return;
    try {
      await postJson('/api/dashboard-pages/' + encodeURIComponent(file) + '/promote', {});
      toast(file + ' promoted to live. Refresh the main dashboard.', 'success');
      await renderDashboardPages();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function revertDashboardPage(file) {
    if (!confirm('Revert ' + file + ' live from the most recent backup?')) return;
    try {
      await postJson('/api/dashboard-pages/' + encodeURIComponent(file) + '/revert', {});
      toast(file + ' reverted to backup.', 'success');
      await renderDashboardPages();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function loadOllama() {
    try {
      const d = await api('/api/ollama/test');
      STATE.cachedOllamaModels = d.models || [];
      STATE.cachedFriendlyNames = d.friendlyNames || {};
      STATE.cachedCloudModels = d.cloudModels || [];
      STATE.cachedThinking = d.thinking || {};
    } catch (e) {
      STATE.cachedOllamaModels = [];
      STATE.cachedFriendlyNames = {};
      STATE.cachedCloudModels = [];
      STATE.cachedThinking = {};
    }
  }

  function modelOption(value, label, selected) {
    return '<option value="' + escAttr(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  }
  function buildModelOptions(models, fn, valueFn, opts) {
    opts = opts || {};
    if (!models.length) return '<option value="">No models</option>';
    const inheritOpt = opts.inherit ? '<option value="">(inherit)</option>' : '';
    return inheritOpt + models.map(m => {
      const value = valueFn(m);
      const label = fn[m] || (m.split(':')[0] || m);
      return modelOption(value, label);
    }).join('');
  }
  function buildCtxOptions(currentValue) {
    const common = ['', '2048', '4096', '8192', '16384', '32768', '65536', '128000'];
    const cur = String(currentValue || '');
    if (cur && !common.includes(cur)) common.push(cur);
    common.sort((a, b) => {
      const an = a === '' ? 0 : Number(a);
      const bn = b === '' ? 0 : Number(b);
      return an - bn;
    });
    return common.map(v => modelOption(v, v || 'default', cur === v)).join('');
  }

  async function loadSettingsValues() {
    let d = {};
    try { d = await api('/api/settings'); STATE.cachedSettings = d; } catch (e) { console.error(e); }

    const models = STATE.cachedOllamaModels || [];
    const fn = STATE.cachedFriendlyNames || {};

    // All models come from Ollama's /api/tags (including :cloud variants).
    // Cloud tags end in :cloud; everything else is local. No hardcoded cloud list.
    const orchHtml = buildModelOptions(models, fn, m => m);
    const anyModelHtml = buildModelOptions(models, fn, m => m, { inherit: true });

    const body = `
      <div class="setting-card">
        <h3>General</h3>
        <div class="hint">Assistant name, timezone. Changes propagate to all group WARDEN.md files on save.</div>
        <div class="setting-row"><label>Assistant</label><input class="input" id="sAssistantName" value="${escAttr(d.assistantName || '')}" placeholder="Warden"></div>
        <div class="setting-row"><label>Local name</label><input class="input" id="sLocalAssistantName" value="${escAttr(d.localAssistantName || '')}" placeholder="Warden"></div>
        <div class="setting-row"><label>Timezone</label><input class="input" id="sTimezone" value="${escAttr(d.timezone || '')}" placeholder="America/Vancouver"></div>
        <div class="save-row"><button class="btn btn-primary btn-sm" id="btnSaveGeneral">Save</button><span class="status" id="generalStatus"></span></div>
      </div>

      <div class="setting-card">
        <h3>Model Configuration</h3>
        <div class="hint">Orchestrator replies to you. Atlas does browser/research/review. The Council uses three Artemis seats. Tools (Iris/Byte/Dexter) execute fast tool calls.</div>
        <div class="setting-row"><label>Orchestrator</label>
          <select class="select" id="sOrchestrator">${orchHtml}</select>
        </div>
        <div class="setting-row"><label>Orchestrator ctx</label>
          <select class="select small" id="sOrchestratorCtx">${buildCtxOptions(d.orchestratorCtx)}</select>
          <span class="dim mono" style="font-size:10px">common values; blank = model default</span>
        </div>
        <div class="setting-row"><label>Atlas</label>
          <select class="select" id="sAtlas">${anyModelHtml}</select>
        </div>
        <div class="setting-row"><label>Atlas ctx</label>
          <select class="select small" id="sAtlasCtx">${buildCtxOptions(d.atlasCtx)}</select>
          <span class="dim mono" style="font-size:10px">common values; blank = model default</span>
        </div>
        <div class="setting-row" style="align-items:flex-start">
          <label>The Council</label>
          <div class="council-grid" style="flex:1">
            <div><label>Skeptic</label><select class="select" id="sSkeptic">${anyModelHtml}</select></div>
            <div><label>Pragmatist</label><select class="select" id="sPragmatist">${anyModelHtml}</select></div>
            <div><label>Synthesist</label><select class="select" id="sSynthesist">${anyModelHtml}</select></div>
          </div>
        </div>
        <div class="setting-row"><label>Toolcall model</label>
          <select class="select" id="sOllamaChatModel">${anyModelHtml}</select>
        </div>
        <div class="setting-row"><label>Toolcall ctx</label>
          <select class="select small" id="sToolsCtx">${buildCtxOptions(d.toolsCtx)}</select>
          <span class="dim mono" style="font-size:10px">common values; blank = model default</span>
        </div>
        <div class="setting-row"><label>Ollama URL</label><input class="input" id="sOllamaUrl" value="${escAttr(d.ollamaUrl || '')}" placeholder="http://127.0.0.1:11434"></div>
        <div class="setting-row"><label>Mercury</label>
          <select class="select" id="sMercury">
            <option value="off">Off — no automatic context</option>
            <option value="rag">RAG — inject relevant older turns</option>
            <option value="summary">Summary — rolling memory only</option>
            <option value="full">Full — summary + RAG</option>
          </select>
        </div>
        <div class="setting-row"><label>Mercury model</label>
          <select class="select" id="sMercuryModel">${anyModelHtml}</select>
          <span class="dim mono" style="font-size:10px">blank = inherit orchestrator</span>
        </div>
        <div class="setting-row"><label>Mercury ctx</label>
          <select class="select small" id="sMercuryCtx">${buildCtxOptions(d.mercuryCtx)}</select>
          <span class="dim mono" style="font-size:10px">blank = model default</span>
        </div>
        <div class="setting-row"><label>Thinking</label>
          <select class="select" id="sThinking">
            <option value="true">On — first turn + always-think models</option>
            <option value="max">Max — every iteration</option>
            <option value="false">Off — no reasoning blocks</option>
          </select>
          <span class="dim mono" style="font-size:10px">global default; chat-level override removed</span>
        </div>
        <div class="save-row"><button class="btn btn-primary btn-sm" id="btnSaveModels">Save</button><span class="status" id="modelStatus"></span></div>
      </div>

      <div class="setting-card">
        <h3>Automation model</h3>
        <div class="hint">Model used for scheduled/automation tasks. Blank = inherit orchestrator.</div>
        <div class="setting-row"><label>Model</label><select class="select" id="sAutomationModel"><option value="">(inherit orchestrator)</option>${orchHtml}</select></div>
        <div class="save-row"><button class="btn btn-primary btn-sm" id="btnSaveAutomation">Save</button><span class="status" id="autoStatus"></span></div>
      </div>

      <div class="setting-card">
        <h3>Friendly model names</h3>
        <div class="hint">Rename Ollama models for display in dropdowns. Blank = use original tag.</div>
        <div id="friendlyList"></div>
        <div class="save-row"><button class="btn btn-primary btn-sm" id="btnSaveFriendly">Save</button><span class="status" id="friendlyStatus"></span></div>
      </div>

      <div class="setting-card">
        <h3>Chat logs</h3>
        <div class="hint">Persistent logs are written by the system service. View them from the Process Logs page or directly on disk.</div>
        <div id="logInfo"></div>
        <div class="save-row">
          <button class="btn btn-ghost btn-sm" id="btnRefreshLogInfo">Refresh size</button>
          <button class="btn btn-danger btn-sm" id="btnTruncateLogs">Delete logs</button>
        </div>
      </div>

      <div class="setting-card">
        <h3>Danger</h3>
        <div class="hint">Server restart required for some env changes (container image, ollama URL) to fully take effect.</div>
        <div class="save-row"><button class="btn btn-danger btn-sm" id="btnRestartServer2">Restart server</button></div>
      </div>
    `;
    $('drawerBody').innerHTML = body;

    // Apply current values
    const setSelect = (id, val) => {
      const sel = $(id);
      if (!sel) return;
      const v = (val || '').replace(/^local:/, '');
      const opt = Array.from(sel.options).find(o => o.value === val || o.value === v);
      if (opt) sel.value = opt.value;
    };
    setSelect('sOrchestrator', d.orchestratorModel || d.globalDefaultModel || '');
    setSelect('sAtlas', (d.atlasModel || '').replace(/^local:/, ''));
    setSelect('sSkeptic', (d.councilSkepticModel || '').replace(/^local:/, ''));
    setSelect('sPragmatist', (d.councilPragmatistModel || '').replace(/^local:/, ''));
    setSelect('sSynthesist', (d.councilSynthesistModel || '').replace(/^local:/, ''));
    setSelect('sOllamaChatModel', (d.ollamaChatModel || '').replace(/^local:/, ''));
    setSelect('sMercury', d.mercuryMode || 'full');
    setSelect('sMercuryModel', (d.mercuryModel || '').replace(/^local:/, ''));
    setSelect('sMercuryCtx', d.mercuryCtx || '');
    setSelect('sThinking', d.thinking || 'true');
    setSelect('sOrchestratorCtx', d.orchestratorCtx || '');
    setSelect('sAtlasCtx', d.atlasCtx || '');
    setSelect('sToolsCtx', d.toolsCtx || '');
    setSelect('sAutomationModel', d.automationModel || '');

    // Friendly names list
    const fl = $('friendlyList');
    if (models.length === 0) {
      fl.innerHTML = '<p class="dim mono" style="font-size:11px">No Ollama models loaded. Start Ollama and reload.</p>';
    } else {
      fl.innerHTML = models.map(m =>
        '<div class="row tight" style="margin-bottom:4px">' +
        '<span class="mono" style="flex:0 0 160px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(m) + '">' + esc(m) + '</span>' +
        '<input class="input" data-model="' + escAttr(m) + '" value="' + escAttr(fn[m] || '') + '" placeholder="' + escAttr(m.split(':')[0] || m) + '" style="flex:1;min-width:0">' +
        '</div>'
      ).join('');
    }

    // Hook save buttons
    $('btnSaveGeneral').addEventListener('click', saveGeneral);
    $('btnSaveModels').addEventListener('click', saveModels);
    $('btnSaveAutomation').addEventListener('click', saveAutomation);
    $('btnSaveFriendly').addEventListener('click', saveFriendly);
    $('btnRestartServer2').addEventListener('click', restartServer);

    refreshLogInfo();
    $('btnRefreshLogInfo').addEventListener('click', refreshLogInfo);
    $('btnTruncateLogs').addEventListener('click', truncateLogs);
  }

  function fmtBytes(n) {
    const num = Number(n) || 0;
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
    if (num < 1024 * 1024 * 1024) return (num / (1024 * 1024)).toFixed(1) + ' MB';
    return (num / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  async function refreshLogInfo() {
    const el = $('logInfo');
    if (!el) return;
    el.innerHTML = '<p class="dim mono" style="font-size:11px">Loading…</p>';
    try {
      const d = await api('/api/process-logs?lines=1');
      const sizes = d.sizes || {};
      el.innerHTML = `
        <div class="setting-row"><label>Stdout</label><span class="mono"><code>logs/dockbox.log</code> · ${esc(fmtBytes(sizes.stdout))}</span></div>
        <div class="setting-row"><label>Stderr</label><span class="mono"><code>logs/dockbox.error.log</code> · ${esc(fmtBytes(sizes.stderr))}</span></div>
        <div class="setting-row"><label>Access</label><span class="dim">Process Logs tab · shell: <code>tail -f logs/dockbox.log</code></span></div>
        <div class="setting-row"><label>Retention</label><span class="dim">No automatic rotation. Delete manually with the button below when size grows.</span></div>
        <div class="setting-row"><label>Delete</label><span class="dim">Truncates both log files to 0 bytes. Irreversible.</span></div>
      `;
    } catch (e) {
      el.innerHTML = '<p class="dim mono" style="font-size:11px;color:var(--danger)">Failed: ' + esc(e.message) + '</p>';
    }
  }

  async function truncateLogs() {
    if (!confirm('Delete both dockbox.log and dockbox.error.log? This cannot be undone.')) return;
    try {
      await postJson('/api/process-logs', { action: 'truncate' });
      toast('Logs truncated', 'success');
      refreshLogInfo();
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  }

  async function saveGeneral() {
    const st = $('generalStatus');
    st.textContent = 'saving…'; st.className = 'status';
    try {
      const body = {
        assistantName: $('sAssistantName').value.trim(),
        localAssistantName: $('sLocalAssistantName').value.trim(),
        timezone: $('sTimezone').value.trim(),
      };
      await postJson('/api/settings', body);
      st.textContent = 'saved'; st.className = 'status ok';
      if (body.assistantName) { STATE.assistantName = body.assistantName; $('assistantName').textContent = body.assistantName.toUpperCase(); }
      toast('General settings saved', 'success');
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.className = 'status err';
    }
  }

  async function saveModels() {
    const st = $('modelStatus');
    st.textContent = 'saving…'; st.className = 'status';
    try {
      const stripLocal = (v) => (v || '').replace(/^local:/, '');
      const body = {
        globalDefaultModel: stripLocal($('sOrchestrator').value),
        atlasModel: stripLocal($('sAtlas').value),
        councilSkepticModel: stripLocal($('sSkeptic').value),
        councilPragmatistModel: stripLocal($('sPragmatist').value),
        councilSynthesistModel: stripLocal($('sSynthesist').value),
        ollamaChatModel: stripLocal($('sOllamaChatModel').value),
        mercuryMode: $('sMercury').value,
        mercuryModel: stripLocal($('sMercuryModel').value),
        mercuryCtx: $('sMercuryCtx').value,
        thinking: $('sThinking').value,
        orchestratorCtx: $('sOrchestratorCtx').value,
        atlasCtx: $('sAtlasCtx').value,
        toolsCtx: $('sToolsCtx').value,
        ollamaUrl: $('sOllamaUrl').value,
      };
      await postJson('/api/settings', body);
      st.textContent = 'saved'; st.className = 'status ok';
      toast('Model configuration saved', 'success');
      // refresh chat model select
      // per-chat model dropdown removed; model is only configured in Settings
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.className = 'status err';
    }
  }

  async function saveAutomation() {
    const st = $('autoStatus');
    st.textContent = 'saving…'; st.className = 'status';
    try {
      const model = $('sAutomationModel').value.trim();
      await postJson('/api/automation/model', { model });
      st.textContent = 'saved'; st.className = 'status ok';
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.className = 'status err';
    }
  }

  async function saveFriendly() {
    const st = $('friendlyStatus');
    st.textContent = 'saving…'; st.className = 'status';
    try {
      const inputs = qsa('#friendlyList input[data-model]');
      const names = {};
      for (const inp of inputs) {
        const v = inp.value.trim();
        if (v) names[inp.dataset.model] = v;
      }
      await postJson('/api/ollama/model-names', { names });
      STATE.cachedFriendlyNames = names;
      st.textContent = 'saved'; st.className = 'status ok';
      toast('Friendly names saved', 'success');
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.className = 'status err';
    }
  }

  // ============================================================= Chat model dropdown
  // per-chat model dropdown removed; model is only configured in Settings

  // ============================================================= Tasks
  async function refreshTasks() {
    const list = $('taskList');
    list.innerHTML = '<div class="task-empty">Loading…</div>';
    try {
      const d = await api('/api/tasks');
      const tasks = d.tasks || [];
      // populate group dropdown from /api/groups (owner stub) + web:dashboard
      const grp = $('taskGroup');
      if (grp) {
        grp.innerHTML = '<option value="owner">owner</option><option value="web:dashboard">web:dashboard</option>';
      }
      if (!tasks.length) { list.innerHTML = '<div class="task-empty">No scheduled tasks. Click "+ New Task" above.</div>'; return; }
      list.innerHTML = tasks.map(t => {
        const badge = t.schedule_type ? '<span class="badge ' + esc(t.schedule_type) + '">' + esc(t.schedule_type) + '</span>' : '';
        const status = t.status === 'paused' ? '<span class="badge paused">paused</span>' : '<span class="badge active">active</span>';
        const next = t.next_run ? fmtTime(t.next_run) : '—';
        const last = t.last_run ? fmtTime(t.last_run) : '—';
        return '<div class="task-item ' + (t.status === 'paused' ? 'paused' : '') + '">' +
          '<div class="head"><span class="prompt" title="' + escAttr(t.prompt || '') + '">' + esc(t.prompt || '') + '</span>' + badge + status + '</div>' +
          '<div class="meta"><span>id: ' + esc(t.id) + '</span><span>group: ' + esc(t.group_folder || '') + '</span><span>value: ' + esc(t.schedule_value || '') + '</span><span>next: ' + next + '</span><span>last: ' + last + '</span></div>' +
          '<div class="actions">' +
            (t.status === 'paused'
              ? '<button class="btn btn-ghost btn-sm" data-task-resume="' + escAttr(t.id) + '">Resume</button>'
              : '<button class="btn btn-ghost btn-sm" data-task-pause="' + escAttr(t.id) + '">Pause</button>') +
            '<button class="btn btn-danger btn-sm" data-task-del="' + escAttr(t.id) + '">Delete</button>' +
          '</div></div>';
      }).join('');

      qsa('[data-task-resume]', list).forEach(b => b.addEventListener('click', () => updateTask(b.dataset.taskResume, 'active')));
      qsa('[data-task-pause]', list).forEach(b => b.addEventListener('click', () => updateTask(b.dataset.taskPause, 'paused')));
      qsa('[data-task-del]', list).forEach(b => b.addEventListener('click', () => deleteTask(b.dataset.taskDel)));
    } catch (e) {
      list.innerHTML = '<div class="task-empty">Failed to load: ' + esc(e.message) + '</div>';
    }
  }

  function showTaskForm() {
    $('taskForm').classList.remove('hidden');
    $('taskPrompt').focus();
  }
  function hideTaskForm() {
    $('taskForm').classList.add('hidden');
    $('taskPrompt').value = '';
    $('taskValue').value = '';
  }

  async function saveTask() {
    const prompt = $('taskPrompt').value.trim();
    const type = $('taskType').value;
    const value = $('taskValue').value.trim();
    const group = $('taskGroup').value;
    const ctx = $('taskCtx').value;
    if (!prompt || !value) { toast('Prompt and schedule value required', 'warn'); return; }
    try {
      await postJson('/api/tasks', {
        group_folder: group || 'owner',
        prompt, schedule_type: type, schedule_value: value,
        context_mode: ctx, chat_jid: STATE.currentJid,
      });
      toast('Task created', 'success');
      hideTaskForm();
      refreshTasks();
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  }

  async function updateTask(id, status) {
    try { await patchJson('/api/tasks/' + encodeURIComponent(id), { status }); refreshTasks(); }
    catch (e) { toast('Failed: ' + e.message, 'error'); }
  }
  async function deleteTask(id) {
    if (!confirm('Delete this task?')) return;
    try { await del('/api/tasks/' + encodeURIComponent(id)); refreshTasks(); }
    catch (e) { toast('Failed: ' + e.message, 'error'); }
  }
  async function bulkDeleteTasks(filter) {
    const labels = { active: 'active', inactive: 'inactive', all: 'all' };
    const label = labels[filter] || filter;
    if (!confirm('Delete ' + label + ' tasks? This cannot be undone.')) return;
    try {
      const d = await del('/api/tasks/bulk', { filter });
      toast('Deleted ' + (d.deleted || 0) + ' task(s)', 'success');
      refreshTasks();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  // ============================================================= Accounts
  const ACCOUNTS = { oauthConfigured: { google: false, microsoft: false }, oauth: [], imap: [], keys: [], channels: [] };

  async function refreshAccounts() {
    try {
      const settings = await api('/api/settings');
      ACCOUNTS.oauthConfigured.google = !!settings.google_configured;
      ACCOUNTS.oauthConfigured.microsoft = !!settings.microsoft_configured;
    } catch {}

    try {
      const oa = await api('/api/oauth/accounts?userId=owner');
      ACCOUNTS.oauth = oa.accounts || [];
    } catch { ACCOUNTS.oauth = []; }

    try {
      const em = await api('/api/email/accounts?userId=owner');
      ACCOUNTS.imap = (em.accounts || []).filter(a => !a.oauth_account_id);
    } catch { ACCOUNTS.imap = []; }

    try {
      const kr = await api('/api/api-keys');
      ACCOUNTS.keys = kr.keys || [];
    } catch { ACCOUNTS.keys = []; }

    try {
      const ch = await api('/api/channels');
      ACCOUNTS.channels = ch.channels || [];
    } catch { ACCOUNTS.channels = []; }

    renderAccounts();
  }

  function renderAccounts() {
    const oauthActions = $('oauthActions');
    const oauthList = $('oauthList');
    const channelsList = $('channelsList');
    const imapList = $('imapList');
    const keyList = $('apiKeyList');

    oauthActions.innerHTML = '';
    oauthList.innerHTML = '';
    channelsList.innerHTML = '';

    const gCfg = ACCOUNTS.oauthConfigured.google;
    const mCfg = ACCOUNTS.oauthConfigured.microsoft;
    oauthActions.innerHTML =
      '<button class="btn btn-secondary btn-sm" ' + (gCfg ? '' : 'disabled title="Not configured"') + ' id="btnConnectGoogle">Connect Google</button>' +
      '<button class="btn btn-secondary btn-sm" ' + (mCfg ? '' : 'disabled title="Not configured"') + ' id="btnConnectMicrosoft">Connect Microsoft</button>';
    const gBtn = $('btnConnectGoogle');
    const mBtn = $('btnConnectMicrosoft');
    if (gBtn && gCfg) gBtn.addEventListener('click', () => startOAuthConnect('google'));
    if (mBtn && mCfg) mBtn.addEventListener('click', () => startOAuthConnect('microsoft'));

    if (!ACCOUNTS.oauth.length) {
      oauthList.innerHTML = '<div class="account-empty">No connected accounts.</div>';
    } else {
      oauthList.innerHTML = ACCOUNTS.oauth.map(a => {
        const feats = [];
        if (a.calendar_enabled) feats.push('Calendar');
        if (a.email_enabled) feats.push('Email');
        return '<div class="account-card" data-oauth-id="' + escAttr(a.id) + '" data-provider="' + escAttr(a.provider) + '" data-readonly="true">' +
          '<span class="badge ' + esc(a.provider) + '">' + (a.provider === 'google' ? 'G' : 'M') + '</span>' +
          '<div class="info"><div class="line">' + esc(a.email || a.provider) + '</div>' +
          '<div class="meta">' + (feats.join(' · ') || 'No features') + ' · ' + (a.enabled === 0 ? 'Expired' : 'Active') + '</div></div>' +
          '<div class="actions">' +
            '<label class="toggle"><input type="checkbox" data-field="email_enabled" ' + (a.email_enabled ? 'checked' : '') + '> Email</label>' +
            '<label class="toggle"><input type="checkbox" data-field="calendar_enabled" ' + (a.calendar_enabled ? 'checked' : '') + '> Cal</label>' +
            '<button class="btn btn-danger btn-sm btn-oauth-disconnect">Disconnect</button>' +
          '</div></div>';
      }).join('');
      qsa('.account-card', oauthList).forEach(card => {
        const id = card.dataset.oauthId;
        card.querySelectorAll('input[data-field]').forEach(cb => {
          cb.addEventListener('change', async () => {
            const body = {}; body[cb.dataset.field] = cb.checked ? 1 : 0;
            try { await patchJson('/api/oauth/accounts/' + encodeURIComponent(id), body); toast('Updated', 'success'); await refreshAccounts(); }
            catch (e) { toast('Failed: ' + e.message, 'error'); }
          });
        });
        card.querySelector('.btn-oauth-disconnect').addEventListener('click', async () => {
          if (!confirm('Disconnect this account?')) return;
          try { await del('/api/oauth/accounts/' + encodeURIComponent(id)); toast('Disconnected', 'success'); await refreshAccounts(); }
          catch (e) { toast('Failed: ' + e.message, 'error'); }
        });
      });
    }

    const labels = { telegram: 'Telegram', whatsapp: 'WhatsApp', slack: 'Slack' };
    const icons = { telegram: '🔵', whatsapp: '🟢', slack: '🔴' };
    channelsList.innerHTML = ['telegram', 'whatsapp', 'slack'].map(type => {
      const ch = ACCOUNTS.channels.find(c => c.type === type);
      const configured = !!ch?.configured;
      const connected = !!ch?.connected;
      const meta = [];
      if (type === 'telegram' && ch?.chatId) meta.push('chat ' + esc(ch.chatId));
      if (type === 'slack' && ch?.channelId) meta.push('channel ' + esc(ch.channelId));
      if (configured) meta.push(connected ? 'connected' : 'disconnected');
      else meta.push('not configured');
      return '<div class="account-card" data-channel-type="' + escAttr(type) + '">' +
        '<span class="badge">' + (icons[type] || '?') + '</span>' +
        '<div class="info"><div class="line">' + esc(labels[type]) + '</div>' +
        '<div class="meta">' + meta.join(' · ') + '</div></div>' +
        '<div class="actions">' +
          (configured ? '<button class="btn btn-danger btn-sm btn-channel-disconnect" style="margin-right:6px">Disconnect</button>' : '') +
          '<button class="btn btn-ghost btn-sm btn-channel-config">' + (configured ? 'Edit' : 'Connect') + '</button>' +
        '</div></div>';
    }).join('');
    qsa('.account-card', channelsList).forEach(card => {
      const type = card.dataset.channelType;
      card.querySelector('.btn-channel-config').addEventListener('click', () => openChannelDrawer(type));
      const disc = card.querySelector('.btn-channel-disconnect');
      if (disc) disc.addEventListener('click', () => disconnectChannel(type));
    });

    if (!ACCOUNTS.imap.length) {
      imapList.innerHTML = '<div class="account-empty">No IMAP/SMTP accounts.</div>';
    } else {
      imapList.innerHTML = ACCOUNTS.imap.map(a => {
        return '<div class="account-card" data-imap-id="' + escAttr(a.id) + '" data-readonly="' + (a.read_only ? 'true' : 'false') + '" data-name="' + escAttr(a.name) + '" data-email="' + escAttr(a.email) + '" data-imap-host="' + escAttr(a.imap_host) + '" data-imap-port="' + escAttr(a.imap_port || '') + '" data-smtp-host="' + escAttr(a.smtp_host) + '" data-smtp-port="' + escAttr(a.smtp_port || '') + '" data-username="' + escAttr(a.username) + '" data-use-tls="' + (a.use_tls ? 'true' : 'false') + '" data-enabled="' + (a.enabled ? 'true' : 'false') + '" data-password="">' +
          '<span class="badge">@</span>' +
          '<div class="info"><div class="line">' + esc(a.name || a.email) + '</div>' +
          '<div class="meta">' + esc(a.email) + ' · IMAP ' + esc(a.imap_host) + ' · ' + (a.read_only ? 'Read only' : 'Send enabled') + '</div></div>' +
          '<div class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-imap-edit">Edit</button>' +
            '<button class="btn btn-danger btn-sm btn-imap-delete">Delete</button>' +
          '</div></div>';
      }).join('');
      qsa('.account-card', imapList).forEach(card => {
        const id = card.dataset.imapId;
        card.querySelector('.btn-imap-edit').addEventListener('click', () => openImapDrawer(id, card.dataset));
        card.querySelector('.btn-imap-delete').addEventListener('click', async () => {
          if (!confirm('Delete this email account?')) return;
          try { await del('/api/email/accounts/' + encodeURIComponent(id)); toast('Deleted', 'success'); await refreshAccounts(); }
          catch (e) { toast('Failed: ' + e.message, 'error'); }
        });
      });
    }

    if (!ACCOUNTS.keys.length) {
      keyList.innerHTML = '<div class="account-empty">No API keys stored.</div>';
    } else {
      keyList.innerHTML = ACCOUNTS.keys.map(k => {
        return '<div class="account-card">' +
          '<span class="badge">🔑</span>' +
          '<div class="info"><div class="line">' + esc(k.name) + '</div>' +
          '<div class="meta">' + esc(k.type) + ' · ' + esc(k.masked || '••••') + '</div></div>' +
          '<div class="actions"><button class="btn btn-danger btn-sm" data-key-id="' + escAttr(k.id) + '" data-key-name="' + escAttr(k.name) + '" onclick="Warden.deleteApiKey(this.dataset.keyId, this.dataset.keyName)">Delete</button></div>' +
          '</div>';
      }).join('');
    }
  }

  function openChannelDrawer(type) {
    const ch = ACCOUNTS.channels.find(c => c.type === type);
    let html = '';
    if (type === 'telegram') {
      html = '<div class="drawer-form">' +
        '<p class="dim" style="font-size:11px;margin-bottom:10px">1. Message @BotFather on Telegram, send /newbot, and copy the API token. 2. Add the bot to a group or chat and send /chatid to get the chat ID. 3. Paste both below.</p>' +
        '<label>Bot token</label><input type="password" class="input" id="chToken" value="" placeholder="123456:ABC...">' +
        '<label>Chat ID</label><input class="input" id="chChatId" value="' + escAttr(ch?.chatId || '') + '" placeholder="-1001234567890">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" id="btnSaveChannel">Connect</button></div>' +
      '</div>';
    } else if (type === 'slack') {
      html = '<div class="drawer-form">' +
        '<p class="dim" style="font-size:11px;margin-bottom:10px">1. Create a Slack app at api.slack.com/apps. 2. Add scopes: chat:write, channels:history, channels:read, groups:history, groups:read. 3. Install to workspace and copy the Bot User OAuth Token. 4. Invite the bot to a channel.</p>' +
        '<label>Bot token</label><input type="password" class="input" id="chToken" value="" placeholder="xoxb-...">' +
        '<label>Channel ID</label><input class="input" id="chChannelId" value="' + escAttr(ch?.channelId || '') + '" placeholder="C1234567890">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" id="btnSaveChannel">Connect</button></div>' +
      '</div>';
    } else if (type === 'whatsapp') {
      html = '<div class="drawer-form">' +
        '<p class="dim" style="font-size:11px;margin-bottom:10px">Click Connect to generate a QR code. Scan it with WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device.</p>' +
        '<div id="waQrBox" style="text-align:center;padding:12px"><button class="btn btn-primary btn-sm" id="btnWaConnect">Generate QR</button></div>' +
      '</div>';
    }
    openDrawer((type === 'telegram' ? 'Telegram' : type === 'slack' ? 'Slack' : 'WhatsApp') + ' Channel', html);
    if (type === 'whatsapp') {
      $('btnWaConnect').addEventListener('click', () => startWhatsAppQr());
    } else {
      $('btnSaveChannel').addEventListener('click', () => saveChannel(type));
    }
  }

  async function saveChannel(type) {
    const token = $('chToken').value.trim();
    if (!token) { toast('Token required', 'warn'); return; }
    const body = { token };
    if (type === 'telegram') body.chatId = $('chChatId').value.trim();
    if (type === 'slack') body.channelId = $('chChannelId').value.trim();
    try {
      const d = await postJson('/api/channels/' + type, body);
      if (d.ok) { toast(type + ' connected', 'success'); closeDrawer(); await refreshAccounts(); }
      else { toast(type + ' connection failed', 'error'); }
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function startWhatsAppQr() {
    const box = $('waQrBox');
    box.innerHTML = '<div class="dim" style="font-size:12px">Generating QR code...</div>';
    try {
      await postJson('/api/channels/whatsapp', {});
    } catch (e) { toast('Failed: ' + e.message, 'error'); box.innerHTML = '<div class="dim" style="color:var(--danger)">Failed to start WhatsApp.</div>'; return; }
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      if (attempts > 60) { clearInterval(timer); box.innerHTML = '<div class="dim" style="color:var(--danger)">QR expired. Try again.</div>'; return; }
      try {
        const d = await api('/api/channels/whatsapp/qr');
        if (d.connected) { clearInterval(timer); toast('WhatsApp connected', 'success'); closeDrawer(); await refreshAccounts(); return; }
        if (d.failed) { clearInterval(timer); box.innerHTML = '<div class="dim" style="color:var(--danger)">QR expired. Try again.</div><button class="btn btn-primary btn-sm" id="btnWaRetry" style="margin-top:8px">Retry</button>'; $('btnWaRetry').addEventListener('click', startWhatsAppQr); return; }
        if (d.qr) {
          box.innerHTML = '<div style="font-size:12px;margin-bottom:8px">Scan with WhatsApp:</div>' +
            '<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(d.qr) + '" style="border-radius:8px" alt="QR">' +
            '<div style="font-size:10px;margin-top:6px;color:var(--text-faint)">WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device</div>';
        }
      } catch { /* ignore */ }
    }, 2000);
  }

  async function disconnectChannel(type) {
    if (!confirm('Disconnect ' + type + '? This removes the saved token/session.')) return;
    try {
      await del('/api/channels/' + encodeURIComponent(type));
      toast(type + ' disconnected', 'success');
      await refreshAccounts();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  function startOAuthConnect(provider) {
    const name = provider === 'microsoft' ? 'Microsoft' : 'Google';
    const readOnly = !confirm('Allow ' + name + ' send access?\n\nOK = read-only (sending disabled)\nCancel = allow sending');
    const url = '/api/oauth/start?provider=' + encodeURIComponent(provider) + '&userId=owner&read_only=' + readOnly;
    const popup = window.open(url, 'oauth', 'width=500,height=700');
    function onMessage(e) {
      if (e.data && e.data.type === 'oauth-success') {
        window.removeEventListener('message', onMessage);
        toast(name + ' account connected', 'success');
        refreshAccounts();
      }
    }
    window.addEventListener('message', onMessage);
    setTimeout(() => {
      if (!popup || popup.closed) { window.open(url); }
    }, 1000);
  }

  function openImapDrawer(id, dataset) {
    const isNew = !id;
    const d = dataset || {};
    const title = isNew ? 'Add IMAP/SMTP Account' : 'Edit Account';
    const html = '<div class="drawer-form">' +
      '<label>Name</label><input class="input" id="imapName" value="' + escAttr(d.name || '') + '" placeholder="My Email">' +
      '<label>Email</label><input class="input" id="imapEmail" value="' + escAttr(d.email || '') + '" placeholder="me@example.com">' +
      '<label>IMAP host</label><input class="input" id="imapHost" value="' + escAttr(d.imapHost || '') + '" placeholder="imap.example.com">' +
      '<label>IMAP port</label><input class="input" id="imapPort" value="' + escAttr(d.imapPort || '993') + '" placeholder="993">' +
      '<label>SMTP host</label><input class="input" id="imapSmtpHost" value="' + escAttr(d.smtpHost || '') + '" placeholder="smtp.example.com">' +
      '<label>SMTP port</label><input class="input" id="imapSmtpPort" value="' + escAttr(d.smtpPort || '587') + '" placeholder="587">' +
      '<label>Username</label><input class="input" id="imapUsername" value="' + escAttr(d.username || '') + '" placeholder="me@example.com">' +
      (isNew ? '<label>Password</label><input type="password" class="input" id="imapPassword" placeholder="Required for new account">' : '<label>New password (leave blank to keep)</label><input type="password" class="input" id="imapPassword" placeholder="">') +
      '<label><input type="checkbox" id="imapUseTls" ' + (d.useTls !== 'false' ? 'checked' : '') + '> Use TLS</label>' +
      '<label><input type="checkbox" id="imapReadOnly" ' + (d.readOnly !== 'false' ? 'checked' : '') + '> Read only</label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
        (isNew ? '' : '<button class="btn btn-ghost btn-sm" id="btnTestImap">Test</button>') +
        '<button class="btn btn-primary btn-sm" id="btnSaveImap">Save</button>' +
      '</div>' +
      '<div id="imapTestStatus" style="font-size:11px;margin-top:6px"></div>' +
    '</div>';
    openDrawer(title, html);
    $('btnSaveImap').addEventListener('click', () => saveImapAccount(id));
    if (!isNew) $('btnTestImap').addEventListener('click', () => testImapAccount(id));
  }

  async function saveImapAccount(id) {
    const name = $('imapName').value.trim();
    const email = $('imapEmail').value.trim();
    const imap_host = $('imapHost').value.trim();
    const imap_port = parseInt($('imapPort').value, 10) || 993;
    const smtp_host = $('imapSmtpHost').value.trim();
    const smtp_port = parseInt($('imapSmtpPort').value, 10) || 587;
    const username = $('imapUsername').value.trim();
    const password = $('imapPassword').value;
    const use_tls = $('imapUseTls').checked;
    const read_only = $('imapReadOnly').checked;
    if (!name || !email || !imap_host || !smtp_host || !username) { toast('Fill required fields', 'warn'); return; }
    if (!id && !password) { toast('Password required', 'warn'); return; }
    const body = { name, email, imap_host, imap_port, smtp_host, smtp_port, username, use_tls, read_only, user_id: 'owner' };
    if (password) body.password = password;
    try {
      if (id) { await putJson('/api/email/accounts/' + encodeURIComponent(id), body); toast('Account updated', 'success'); }
      else { await postJson('/api/email/accounts', body); toast('Account added', 'success'); }
      closeDrawer(); await refreshAccounts();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function testImapAccount(id) {
    const status = $('imapTestStatus');
    status.textContent = 'Testing...'; status.style.color = '';
    try {
      const d = await postJson('/api/email/test', { accountId: id });
      const imapOk = d.imap && d.imap.ok;
      const smtpOk = d.smtp && d.smtp.ok;
      status.textContent = imapOk && smtpOk ? 'IMAP + SMTP connected' : ('IMAP: ' + (d.imap?.error || 'fail') + ' · SMTP: ' + (d.smtp?.error || 'fail'));
      status.style.color = imapOk && smtpOk ? 'var(--ok)' : 'var(--danger)';
    } catch (e) { status.textContent = 'Test failed: ' + e.message; status.style.color = 'var(--danger)'; }
  }

  function openApiKeyDrawer() {
    openDrawer('Add API Key', '<div class="drawer-form">' +
      '<label>Name / Label</label><input class="input" id="keyName" placeholder="OpenAI">' +
      '<label>Type</label><input class="input" id="keyType" placeholder="openai">' +
      '<label>Base URL (optional)</label><input class="input" id="keyBaseUrl" placeholder="https://api.openai.com/v1">' +
      '<label>Default model (optional)</label><input class="input" id="keyModel" placeholder="gpt-4o">' +
      '<label>Key</label><input type="password" class="input" id="keyValue" placeholder="sk-...">' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" id="btnSaveApiKey">Save</button></div>' +
    '</div>');
    $('btnSaveApiKey').addEventListener('click', saveApiKey);
  }

  async function saveApiKey() {
    const name = $('keyName').value.trim();
    const type = $('keyType').value.trim() || 'custom';
    const value = $('keyValue').value.trim();
    if (!name || !value) { toast('Name and key required', 'warn'); return; }
    try {
      await postJson('/api/api-keys', { name, type, value, baseUrl: $('keyBaseUrl').value.trim(), defaultModel: $('keyModel').value.trim() });
      toast('API key saved', 'success'); closeDrawer(); await refreshAccounts();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function deleteApiKey(id, name) {
    if (!confirm('Delete API key "' + (name || id) + '"?')) return;
    try { await del('/api/api-keys/' + encodeURIComponent(id)); toast('Deleted', 'success'); await refreshAccounts(); }
    catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  // ============================================================= Skills
  const CONTAINER_SKILLS = new Set(['scrub', 'agent-browser', 'pdf-reader', 'ollama', 'compact']);

  async function refreshSkills() {
    const grid = $('skillGrid');
    grid.innerHTML = '<div class="dim mono" style="font-size:11px">Loading…</div>';
    try {
      const d = await api('/api/skills');
      const installed = d.installed || {};
      const user = d.user || {};
      const names = Object.keys(installed).sort();
      const userNames = Object.keys(user).sort();
      if (!names.length && !userNames.length) { grid.innerHTML = '<div class="dim mono" style="font-size:11px">No skills reported.</div>'; return; }
      const userCards = userNames.map(n => {
        const en = user[n].enabled;
        return '<div class="skill-card ' + (en ? 'installed' : '') + '" data-skill-toggle="' + escAttr(n) + '" data-enabled="' + (en ? '1' : '0') + '" title="Click to ' + (en ? 'disable' : 'enable') + '" style="cursor:pointer">' +
          '<span class="dot"></span><span class="name" title="' + escAttr(n) + '">' + esc(n) + '</span>' +
          '<span class="state">' + (en ? 'on' : 'off') + '</span>' +
          '<span class="del" data-skill-del="' + escAttr(n) + '" title="Delete skill">×</span></div>';
      }).join('');
      grid.innerHTML = userCards + names.map(n => {
        const ok = installed[n];
        const canDelete = ok && CONTAINER_SKILLS.has(n);
        const delBtn = canDelete
          ? '<span class="del" data-skill-del="' + escAttr(n) + '" title="Delete container skill">×</span>'
          : '';
        return '<div class="skill-card ' + (ok ? 'installed' : '') + '">' +
          '<span class="dot"></span><span class="name" title="' + escAttr(n) + '">' + esc(n) + '</span>' +
          '<span class="state">' + (ok ? 'on' : 'off') + '</span>' + delBtn + '</div>';
      }).join('');
    } catch (e) {
      grid.innerHTML = '<div class="dim mono" style="font-size:11px">Failed: ' + esc(e.message) + '</div>';
    }
  }

  // ============================================================= MCP servers
  async function refreshMcp() {
    const list = $('mcpList');
    if (!list) return;
    list.innerHTML = '<div class="dim mono" style="font-size:11px">Loading…</div>';
    try {
      const d = await api('/api/mcp-servers');
      const servers = d.servers || [];
      if (!servers.length) {
        list.innerHTML = '<div class="dim mono" style="font-size:11px">No MCP servers configured.</div>';
        return;
      }
      list.innerHTML = servers.map(s => {
        const argsStr = (s.args || []).join(' ');
        const meta = esc(s.command) + (argsStr ? ' ' + esc(argsStr) : '');
        const desc = s.description
          ? '<div class="desc">' + esc(s.description) + '</div>'
          : '';
        return '<div class="mcp-row ' + (s.enabled ? '' : 'disabled') + '">' +
          '<label class="mcp-toggle">' +
            '<input type="checkbox" data-mcp-toggle="' + escAttr(s.name) + '"' + (s.enabled ? ' checked' : '') + '>' +
            '<span class="slider"></span>' +
          '</label>' +
          '<div>' +
            '<div class="name">' + esc(s.name) + '</div>' +
            '<div class="meta" title="' + escAttr(meta) + '">' + meta + '</div>' +
          '</div>' +
          '<span></span>' +
          '<span class="del" data-mcp-del="' + escAttr(s.name) + '" title="Remove server">×</span>' +
          desc +
          '</div>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<div class="dim mono" style="font-size:11px">Failed: ' + esc(e.message) + '</div>';
    }
  }

  async function mcpToggle(name, enabled) {
    try {
      await patchJson('/api/mcp-servers/' + encodeURIComponent(name), { enabled });
      toast('MCP ' + name + ': ' + (enabled ? 'enabled' : 'disabled'), 'info');
      refreshMcp();
    } catch (e) {
      toast('Toggle failed: ' + e.message, 'error');
      refreshMcp();
    }
  }

  async function mcpDelete(name) {
    if (!confirm('Remove MCP server "' + name + '"?')) return;
    try {
      await del('/api/mcp-servers/' + encodeURIComponent(name));
      toast('Removed ' + name, 'info');
      refreshMcp();
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
  }

  async function mcpAddSubmit() {
    const st = $('mcpAddStatus');
    st.textContent = 'saving…'; st.className = 'status mono';
    const name = $('mcpAddName').value.trim();
    const command = $('mcpAddCommand').value.trim();
    const argsRaw = $('mcpAddArgs').value.trim();
    const envRaw = $('mcpAddEnv').value.trim();
    const description = $('mcpAddDesc').value.trim();
    const enabled = $('mcpAddEnabled').checked;
    if (!name || !command) {
      st.textContent = 'name and command required'; st.className = 'status err mono';
      return;
    }
    let env;
    if (envRaw) {
      try { env = JSON.parse(envRaw); }
      catch { st.textContent = 'env must be valid JSON'; st.className = 'status err mono'; return; }
    }
    const args = argsRaw ? argsRaw.split(/\s+/) : [];
    try {
      await postJson('/api/mcp-servers', { name, command, args, env, description, enabled });
      st.textContent = 'added'; st.className = 'status ok mono';
      $('mcpAddName').value = ''; $('mcpAddCommand').value = '';
      $('mcpAddArgs').value = ''; $('mcpAddEnv').value = ''; $('mcpAddDesc').value = '';
      $('mcpAddDetails').open = false;
      refreshMcp();
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.className = 'status err mono';
    }
  }

  async function skillDelete(name) {
    if (!confirm('Delete container skill "' + name + '" (removes SKILL.md)?')) return;
    try {
      await del('/api/skills/' + encodeURIComponent(name));
      toast('Deleted ' + name, 'info');
      refreshSkills();
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
  }

  async function skillAddSubmit() {
    const st = $('skillAddStatus');
    st.textContent = 'saving…'; st.className = 'status mono';
    const name = $('skillAddName').value.trim();
    const description = $('skillAddDesc').value.trim();
    const when_to_use = $('skillAddWhen').value.trim();
    const instructions = $('skillAddInstr').value.trim();
    const example_prompt = $('skillAddExample').value.trim();
    if (!name || !description) {
      st.textContent = 'name and description required'; st.className = 'status err mono';
      return;
    }
    try {
      await postJson('/api/skills', { name, description, when_to_use, instructions, example_prompt });
      st.textContent = 'created'; st.className = 'status ok mono';
      $('skillAddName').value = ''; $('skillAddDesc').value = '';
      $('skillAddWhen').value = ''; $('skillAddInstr').value = ''; $('skillAddExample').value = '';
      $('skillAddDetails').open = false;
      refreshSkills();
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.className = 'status err mono';
    }
  }

  // ============================================================= Activity
  async function refreshActivity() {
    const kv = $('liveStatusKv');
    const al = $('activityList');
    const rl = $('recentActivityList');
    try {
      const status = STATE.cachedStatus || await api('/api/status');
      const groups = status.groups || [];
      const kvRows = [
        ['assistant', status.assistant || '—'],
        ['uptime', fmtUptime(status.uptime)],
        ['activeContainers', status.activeContainers],
        ['runningJobs', status.runningJobs],
        ['scheduledTasks', status.scheduledTasks],
        ['cpu', status.system ? status.system.cpuPercent + '%' : '—'],
        ['mem', status.system ? status.system.memPercent + '%' : '—'],
        ['ollama', status.ollamaEnabled ? 'enabled' : 'disabled'],
        ['model mode', status.defaultModelMode || '—'],
      ];
      kv.innerHTML = kvRows.map(([k, v]) => '<div class="k">' + esc(k) + '</div><div class="v mono">' + esc(v) + '</div>').join('');

      // Active agents
      const active = groups.filter(g => g.active && !g.idle);
      if (!active.length) {
        al.innerHTML = '<div class="task-empty">No agents running.</div>';
      } else {
        al.innerHTML = active.map(g =>
          '<div class="activity-item active"><div class="row1">' +
          '<span class="name">' + esc(g.name || g.jid) + '</span>' +
          '<span class="label">' + esc(g.liveLabel || g.livePhase || '') + '</span>' +
          '<span class="ts">' + fmtTime(g.liveTs) + '</span></div>' +
          (g.liveTools && g.liveTools.length ? '<div class="tools">tools: ' + esc(g.liveTools.join(', ')) + '</div>' : '') +
          '</div>'
        ).join('');
      }

      // Recent activity
      try {
        const ad = await api('/api/activity?limit=20');
        const items = ad.items || [];
        if (!items.length) rl.innerHTML = '<div class="task-empty">No recent activity.</div>';
        else rl.innerHTML = items.map(it =>
          '<div class="activity-item"><div class="row1">' +
          '<span class="name">' + esc(it.title || it.type) + '</span>' +
          '<span class="ts">' + fmtTime(it.timestamp) + '</span></div>' +
          '<div class="tools">' + esc((it.detail || '').slice(0, 200)) + '</div></div>'
        ).join('');
      } catch (e) {
        rl.innerHTML = '<div class="task-empty">activity endpoint unavailable</div>';
      }
    } catch (e) {
      kv.innerHTML = ''; al.innerHTML = '<div class="task-empty">' + esc(e.message) + '</div>'; rl.innerHTML = '';
    }
  }

  // ============================================================= Process logs
  async function refreshProcessLogs() {
    const el = $('processLogsContent');
    if (!el) return;
    el.textContent = 'Loading…';
    try {
      const d = await api('/api/process-logs?lines=200');
      if (!d.ok) { el.textContent = 'Error: ' + (d.error || 'unknown'); return; }
      el.textContent = (d.lines || []).join('\n') || '(no logs)';
      el.scrollTop = el.scrollHeight;
    } catch (e) {
      el.textContent = 'Failed: ' + e.message;
    }
  }

  // ============================================================= Audit
  function openAuditModal() {
    $('auditModal').classList.add('open');
    refreshAuditStatus();
  }
  function closeAuditModal() {
    $('auditModal').classList.remove('open');
    if (STATE.auditPollTimer) { clearInterval(STATE.auditPollTimer); STATE.auditPollTimer = null; }
  }
  async function startAudit() {
    const st = $('auditStatus');
    st.textContent = 'starting…'; st.style.color = 'var(--warn)';
    try {
      const d = await postJson('/api/audit/run', {});
      if (d.ok) {
        STATE.auditRunning = true;
        st.textContent = 'audit running — 15 to 45 minutes'; st.style.color = 'var(--ok)';
        toast('Audit started', 'success');
        if (!STATE.auditPollTimer) STATE.auditPollTimer = setInterval(refreshAuditStatus, 5000);
        refreshAuditStatus();
      } else {
        st.textContent = d.error || 'failed to start'; st.style.color = 'var(--danger)';
      }
    } catch (e) {
      st.textContent = 'failed: ' + e.message; st.style.color = 'var(--danger)';
    }
  }
  async function refreshAuditStatus() {
    const tail = $('auditLogTail');
    try {
      const d = await api('/api/audit/status');
      STATE.auditRunning = !!d.running;
      tail.textContent = d.tail || '(no audit running)';
      tail.scrollTop = tail.scrollHeight;
      const st = $('auditStatus');
      st.textContent = d.running ? 'audit running…' : (d.tail ? 'audit finished' : 'no audit has been run');
      st.style.color = d.running ? 'var(--warn)' : 'var(--text-faint)';
    } catch (e) {
      tail.textContent = 'Failed: ' + e.message;
    }
  }

  // ============================================================= Help modal
  function openHelp() { $('helpModal').classList.add('open'); }
  function closeHelp() { $('helpModal').classList.remove('open'); }

  // ============================================================= Switch user
  function openSwitchUser() {
    renderSenderList();
    $('switchUserModal').classList.add('open');
  }
  function closeSwitchUser() { $('switchUserModal').classList.remove('open'); }
  function renderSenderList() {
    const list = $('userSwitchList');
    list.innerHTML = STATE.senders.map(s =>
      '<div class="urow" data-sender="' + escAttr(s.key) + '">' +
      '<span class="avatar" style="background:' + escAttr(s.color) + '">' + esc(initials(s.name)) + '</span>' +
      '<span class="uname">' + esc(s.name) + '</span>' +
      '<span class="uid">' + esc(s.key) + '</span></div>'
    ).join('');
    qsa('.urow', list).forEach(r => r.addEventListener('click', () => pickSender(r.dataset.sender)));
  }
  function initials(name) { return (name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
  function pickSender(key) {
    const s = STATE.senders.find(x => x.key === key);
    if (!s) return;
    STATE.currentSender = s.name;
    STATE.currentSenderKey = s.key;
    try { localStorage.setItem('jarvis-sender', JSON.stringify(s)); } catch {}
    $('switchUserLabel').textContent = s.name;
    closeSwitchUser();
    toast('Now sending as ' + s.name, 'info');
  }
  function addSender() {
    const name = $('newSenderName').value.trim();
    if (!name) return;
    const key = name.toLowerCase().replace(/\s+/g, '-');
    const palette = ['#5eead4', '#60a5fa', '#c084fc', '#fbbf24', '#f87171', '#4ade80'];
    const s = { key, name, color: palette[STATE.senders.length % palette.length] };
    STATE.senders.push(s);
    try { localStorage.setItem('jarvis-senders', JSON.stringify(STATE.senders)); } catch {}
    $('newSenderName').value = '';
    renderSenderList();
    pickSender(key);
  }

  // ============================================================= First-run wizard
  const WIZARD_STEPS = [
    {
      title: 'Read this first',
      body: `
        <h2 style="color:var(--danger)">READ THIS. IT IS NOT A JOKE.</h2>
        <div class="warn">
          <strong>Warden runs with the same access as your user account on this machine.</strong>
          There is no permission prompt before actions. There is no sandbox. It does not manage backups. It cannot be trusted with secrets it can read from your filesystem.
        </div>
        <p><strong>What it can do:</strong></p>
        <ul>
          <li>Read, modify, or delete any file your user can touch</li>
          <li>Run any command in a shell — including <code>sudo</code> if you're set up for it</li>
          <li>Open browsers, click, type, screenshot, read your clipboard</li>
          <li>Send email, messages, and API calls on your behalf</li>
          <li>Spend money via any account whose credentials it can reach</li>
        </ul>
        <p><strong>Where you should run it:</strong></p>
        <ul>
          <li>A dedicated Linux box you are OK wiping and reprovisioning</li>
          <li>A virtual machine with snapshots and no access to your real accounts</li>
          <li>A cloud VM whose IAM is scoped to nothing you care about</li>
        </ul>
        <p><strong>Where you should NOT run it:</strong></p>
        <ul>
          <li>Your personal laptop with real files and browser sessions</li>
          <li>A work computer — this will violate almost every acceptable-use policy</li>
          <li>Any machine holding data you can't afford to lose</li>
          <li>Any machine with unencrypted SSH keys, cloud credentials, or password vaults</li>
        </ul>
        <p><strong>Always monitor the agent while it is running.</strong> An unattended autonomous agent with shell access is how catastrophes happen.</p>
        <label class="wizard-ack">
          <input type="checkbox" id="wizardAckCheck"
            onchange="document.getElementById('btnWizardNext').disabled = !this.checked">
          I understand the risks and am running Warden on a dedicated box, VM, or throwaway account.
        </label>`,
    },
    {
      title: 'Welcome',
      body: `
        <h2>This is Warden.</h2>
        <p>Warden is a <strong>personal hybrid agent</strong> — one orchestrator model that replies to you, plus a fleet of specialist sub-agents (Atlas, Byte, Dexter, Iris, Artemis, The Council) it can delegate to. It can read files, run code, open browsers, send email, and schedule tasks on your machine.</p>
        <p>There's a learning curve. Warden responds best to <em>actionable requests</em>, not conversation. The next few screens cover the essentials. You can also read the standalone guides:</p>
        <div class="topics">
          <a href="/help/not-a-chatbot.html" target="_blank">Not a chatbot</a>
          <a href="/help/agents.html" target="_blank">The agents</a>
          <a href="/help/council.html" target="_blank">The Council</a>
          <a href="/help/atlas.html" target="_blank">Asking Atlas</a>
          <a href="/help/skills.html" target="_blank">Skills</a>
          <a href="/help/safety.html" target="_blank">Safety</a>
          <a href="/help/settings.html" target="_blank">Settings</a>
          <a href="#" onclick="openHelp();return false;">Open Help modal</a>
        </div>`,
    },
    {
      title: 'The agents',
      body: `
        <h2>One orchestrator, several sub-agents.</h2>
        <p>The orchestrator is the model you're chatting with. When a request falls in a sub-agent's lane, the orchestrator delegates and the sub-agent reports back as a chat message.</p>
        <ul>
          <li><strong>Atlas</strong> — browser + research (URLs, screenshots, fetch HTML).</li>
          <li><strong>Byte</strong> — compute (python3 / bash / node).</li>
          <li><strong>Dexter</strong> — time + scheduling.</li>
          <li><strong>Iris</strong> — email (read; send if enabled).</li>
          <li><strong>Artemis</strong> — read-only auditor / reviewer.</li>
          <li><strong>The Council</strong> — three Artemis seats deliberate in parallel.</li>
        </ul>
        <p>Read the <a href="/help/agents.html" target="_blank">agents deep-dive →</a></p>`,
    },
    {
      title: 'How to ask',
      body: `
        <h2>Be actionable. Be specific.</h2>
        <p>Bad: <code>What's your opinion on cats?</code><br>Good: <code>Read /tmp/cat-facts.txt and pick the funniest one.</code></p>
        <p>One ask per turn is fine. If two things are independent, say so: <code>"Read X AND check Y in parallel."</code></p>
        <p>If a tool fails, Warden says <code>BLOCKED</code> and tells you what's missing. Read the message; don't retry blindly.</p>
        <p>The <strong>verbose bar</strong> above the composer shows what Warden is doing right now (live label + tools list).</p>
        <p>Read the <a href="/help/not-a-chatbot.html" target="_blank">full guide →</a></p>`,
    },
    {
      title: 'Safety',
      body: `
        <h2>Read this. Then read it again.</h2>
        <div class="warn"><strong>Warden can run code, delete files, send email, and push git.</strong> Treat it like a competent but literal-minded contractor.</div>
        <ul>
          <li>Don't run as admin / root.</li>
          <li>Don't give write access to important things (email, prod repos, keys).</li>
          <li>Make backups. Group folders are git-tracked — use <code>/api/files/history</code> to revert.</li>
          <li>Don't run Warden on your only computer or your work computer.</li>
          <li>Run the <strong>audit</strong> button (left rail, bottom) before trusting Warden with anything important.</li>
        </ul>
        <p>Read the <a href="/help/safety.html" target="_blank">safety guide →</a></p>`,
    },
    {
      title: 'Dashboard pages',
      body: `
        <h2>Add or edit dashboard pages safely.</h2>
        <p>The dashboard is a single-page app in <code>public/index.html</code> + <code>public/js/app.js</code> + <code>public/css/style.css</code>. New views and rail buttons go through a beta → live pipeline so broken drafts never hit the live UI.</p>
        <ul>
          <li><strong>Beta:</strong> edits land in <code>public/beta/</code> and preview at <code>http://localhost:3200/beta/</code>.</li>
          <li><strong>Promote:</strong> click Promote in the Add Page drawer after preview passes. Live is backed up first.</li>
          <li><strong>Revert:</strong> if live breaks, click Revert to restore the most recent backup.</li>
        </ul>
        <p>You can also tell Warden <em>"add a dashboard page called X"</em> and it will follow the pipeline for you.</p>
        <p>Read the <a href="/help/dashboard-pages.html" target="_blank">dashboard pages guide →</a></p>`,
    },
  ];

  let wizardStep = 0;
  function showWizardStep(i) {
    wizardStep = i;
    const step = WIZARD_STEPS[i];
    const prog = $('wizardProgress');
    prog.innerHTML = WIZARD_STEPS.map((_, idx) =>
      '<div class="step ' + (idx < i ? 'done' : idx === i ? 'current' : '') + '"></div>'
    ).join('');
    $('wizardStep').innerHTML = step.body;
    $('btnWizardBack').style.display = i === 0 ? 'none' : '';
    $('btnWizardNext').textContent = i === WIZARD_STEPS.length - 1 ? 'Start using Warden' : 'Next';
    // Step 0 is the risk acknowledgment — Next stays disabled until the
    // user checks the confirmation box in the step body.
    $('btnWizardNext').disabled = i === 0;
  }
  function wizardNext() {
    if (wizardStep < WIZARD_STEPS.length - 1) { showWizardStep(wizardStep + 1); return; }
    // Done
    if ($('wizardDontShowInput').checked) {
      try { localStorage.setItem('jarvis-wizard-dismissed', '1'); } catch {}
    }
    $('wizardModal').classList.remove('open');
  }
  function wizardBack() { if (wizardStep > 0) showWizardStep(wizardStep - 1); }

  function maybeShowWizard() {
    let dismissed = false;
    try { dismissed = localStorage.getItem('jarvis-wizard-dismissed') === '1'; } catch {}
    if (!dismissed) {
      showWizardStep(0);
      $('wizardModal').classList.add('open');
    }
  }

  // ============================================================= Theme
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('dockbox-theme', next); } catch {}
  }

  // ============================================================= Notifications (SSE + polling)
  function connectSSE() {
    try {
      if (STATE.sseSource) STATE.sseSource.close();
      STATE.sseSource = new EventSource('/api/notifications');
      STATE.sseSource.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'connected') return;
          handleNotification(data);
        } catch {}
      };
      STATE.sseSource.onerror = () => {
        try { STATE.sseSource.close(); } catch {}
        STATE.sseSource = null;
        if (!STATE.notifPollTimer) {
          STATE.notifPollTimer = setInterval(async () => {
            try {
              const d = await api('/api/notifications/poll');
              const items = d.items || [];
              for (const it of items) {
                handleNotification({ type: 'chat_complete', message: it.preview || '', timestamp: it.timestamp });
              }
            } catch {}
          }, 8000);
        }
      };
    } catch (e) { /* SSE not supported */ }
  }
  function handleNotification(data) {
    if (data.type === 'chat_complete') {
      // Trigger a chat poll so the new bot message shows up
      pollChat();
      pollStatus();
      // Keep a short refresh window alive in case more chunks follow
      STATE.waitingForReply = true;
      startChatPolling();
    } else if (data.type === 'agent_activity') {
      // Update verbose bar opportunistically
      pollStatus();
    } else if (data.message) {
      toast(data.message, data.type === 'alarm' ? 'warn' : 'info');
    }
  }

  // ============================================================= File attachments (best-effort upload)
  function attachFiles() {
    $('fileInput').click();
  }
  async function onFilesChosen(ev) {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    STATE.selectedAttachments = files;
    const badge = $('attachBadge');
    badge.textContent = files.length + ' file' + (files.length > 1 ? 's' : '') + ' attached';
    // Upload immediately to the owner folder so the agent can read them
    for (const f of files) {
      try {
        await uploadFile('/api/files/upload?path=' + encodeURIComponent('owner/attachments'), f);
      } catch (e) {
        toast('Upload failed: ' + e.message, 'error');
      }
    }
  }
  function uploadFile(url, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(file);
    });
  }

  // ============================================================= Wire-up
  function init() {
    // Load senders from localStorage
    try {
      const stored = JSON.parse(localStorage.getItem('jarvis-senders') || '[]');
      if (Array.isArray(stored) && stored.length) STATE.senders = stored;
      const cur = JSON.parse(localStorage.getItem('jarvis-sender') || 'null');
      if (cur) { STATE.currentSender = cur.name; STATE.currentSenderKey = cur.key; }
    } catch {}
    $('switchUserLabel').textContent = STATE.currentSender;

    // Rail nav
    qsa('.rail-btn[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
    $('btnSettings').addEventListener('click', openSettings);
    $('btnAddPage').addEventListener('click', openAddPage);
    $('btnAudit').addEventListener('click', openAuditModal);
    $('btnHelp').addEventListener('click', openHelp);
    $('btnTheme').addEventListener('click', toggleTheme);
    $('btnStop').addEventListener('click', stopAgent);
    $('btnRestart').addEventListener('click', restartServer);
    $('btnSwitchUser').addEventListener('click', openSwitchUser);
    $('btnNewThought').addEventListener('click', newThought);

    // Drawer
    $('btnDrawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);

    // Help modal
    $('btnHelpClose').addEventListener('click', closeHelp);
    $('btnHelpDone').addEventListener('click', closeHelp);

    // Audit modal
    $('btnAuditClose').addEventListener('click', closeAuditModal);
    $('btnAuditStart').addEventListener('click', startAudit);
    $('btnAuditRefresh').addEventListener('click', refreshAuditStatus);

    // Switch user
    $('btnSwitchUserClose').addEventListener('click', closeSwitchUser);
    $('btnAddSender').addEventListener('click', addSender);
    $('newSenderName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSender(); });

    // Wizard
    $('btnWizardClose').addEventListener('click', () => $('wizardModal').classList.remove('open'));
    $('btnWizardNext').addEventListener('click', wizardNext);
    $('btnWizardBack').addEventListener('click', wizardBack);

    // Chat composer
    $('btnSend').addEventListener('click', sendChat);
    const ta = $('chatInput');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    });
    $('btnAttach').addEventListener('click', attachFiles);
    $('fileInput').addEventListener('change', onFilesChosen);

    // Tasks
    $('btnNewTask').addEventListener('click', showTaskForm);
    $('btnCancelTask').addEventListener('click', hideTaskForm);
    $('btnSaveTask').addEventListener('click', saveTask);
    $('btnRefreshTasks').addEventListener('click', refreshTasks);
    $('btnDeleteActiveTasks').addEventListener('click', () => bulkDeleteTasks('active'));
    $('btnDeleteInactiveTasks').addEventListener('click', () => bulkDeleteTasks('inactive'));
    $('btnDeleteAllTasks').addEventListener('click', () => bulkDeleteTasks('all'));
    // Accounts
    $('btnRefreshAccounts').addEventListener('click', refreshAccounts);
    $('btnAddImapAccount').addEventListener('click', () => openImapDrawer());
    $('btnAddApiKey').addEventListener('click', openApiKeyDrawer);
    $('btnRefreshSkills').addEventListener('click', () => { refreshSkills(); refreshMcp(); });
    $('btnRefreshActivity').addEventListener('click', refreshActivity);

    // MCP + Skills mutation controls
    $('btnMcpAdd').addEventListener('click', mcpAddSubmit);
    $('btnMcpAddCancel').addEventListener('click', () => { $('mcpAddDetails').open = false; });
    $('btnSkillAdd').addEventListener('click', skillAddSubmit);
    $('btnSkillAddCancel').addEventListener('click', () => { $('skillAddDetails').open = false; });

    // Delegated handlers for toggle/delete inside the mcp/skill lists
    $('mcpList').addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('input[data-mcp-toggle]')) {
        mcpToggle(t.getAttribute('data-mcp-toggle'), t.checked);
      }
    });
    $('mcpList').addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('[data-mcp-del]')) {
        mcpDelete(t.getAttribute('data-mcp-del'));
      }
    });
    $('skillGrid').addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('[data-skill-del]')) {
        skillDelete(t.getAttribute('data-skill-del'));
        return;
      }
      const card = t && t.closest ? t.closest('[data-skill-toggle]') : null;
      if (card) {
        const name = card.getAttribute('data-skill-toggle');
        const enable = card.getAttribute('data-enabled') !== '1';
        patchJson('/api/skills/' + encodeURIComponent(name), { enabled: enable })
          .then(() => { toast((enable ? 'Enabled ' : 'Disabled ') + name, 'info'); refreshSkills(); })
          .catch((err) => toast('Toggle failed: ' + err.message, 'error'));
      }
    });
    $('btnRefreshLogs').addEventListener('click', refreshProcessLogs);

    // Make openHelp / openAuditModal callable from inline onclick handlers
    window.openHelp = openHelp;
    window.openAuditModal = openAuditModal;
    window.closeAuditModal = closeAuditModal;

    // Initial fetches
    startStatusPolling();
    loadMessages();
    connectSSE();
    startChatPolling();

    maybeShowWizard();
  }

  document.addEventListener('DOMContentLoaded', init);

  // Expose a small surface for debugging
  window.Warden = { STATE, sendChat, pollChat, pollStatus, refreshTasks, refreshSkills, refreshActivity, refreshAccounts, deleteApiKey };
})();