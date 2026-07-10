// Warden User Dashboard

// Auto-inject user session header on all API requests
(function() {
  const _fetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      const session = localStorage.getItem('dockbox-user-session');
      if (session) {
        opts = opts || {};
        opts.headers = opts.headers || {};
        if (opts.headers instanceof Headers) {
          if (!opts.headers.has('X-User-Session')) opts.headers.set('X-User-Session', session);
        } else if (!opts.headers['X-User-Session'] && !opts.headers['x-user-session']) {
          opts.headers['X-User-Session'] = session;
        }
      }
    }
    return _fetch.call(this, url, opts);
  };
})();

var UserDash = (() => {
  // --- Sidebar nav items (all possible) ---
  // Task 12: merged dashboard — 6 tabs (Chat, Tasks, Files, Email, Vault, Settings)
  var NAV_ITEMS = [
    { id: 'chat', label: 'Chat', group: 'communicate', icon: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>' },
    { id: 'automater', label: 'Tasks', group: 'organize', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
    { id: 'email', label: 'Email', group: 'communicate', icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
    { id: 'accounts', label: 'Accounts', group: 'communicate', icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
    { id: 'settings', label: 'Settings', group: 'settings', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>' },
  ];
  function renderNavItem(item) {
    var cls = 'nav-item' + (item.group ? ' nav-group-' + item.group : '');
    return '<a class="' + cls + '" data-view="' + item.id + '" data-tooltip="' + item.label + '">'
      + '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + item.icon + '</svg>'
      + '<span class="nav-label">' + item.label + '</span>'
      + '</a>';
  }

  function renderSidebarNav() {
    var pinned = document.getElementById('navPinned');
    if (!pinned) return;

    pinned.innerHTML = NAV_ITEMS.map(renderNavItem).join('');

    // Re-apply active state
    var cur = document.querySelector('.nav-item[data-view="' + currentView + '"]');
    if (cur) cur.classList.add('active');

    // Bind click handlers
    document.querySelectorAll('#navPinned .nav-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.preventDefault();
        var view = el.getAttribute('data-view');
        if (view) navigateTo(view);
      });
    });
  }

  // --- State ---
  let currentUser = null;
  let currentView = 'chat';
  let currentSession = '';
  let chatLastTimestamp = '';
  let knownMsgIds = new Set();
  let notifCount = 0;
  let pingNotifCount = 0;
  let unreadSessions = {};  // jid → count of unseen bot messages
  let lastSeenTimestamps = JSON.parse(localStorage.getItem('dockbox-last-seen') || '{}');
  let notifications = [];
  let chatInterval = null;
  let chatPolling = false;
  let filePath = '.';
  let sseSource = null;
  let lastNotifType = null;
  let promptAttachedFiles = [];
  let promptBrowserPath = '.';
  let currentPromptTemplate = null;
  let groupsMap = {};  // jid → { name, folder }
  let pendingUser = null;
  let tempSession = null;
  let passwordMode = null; // 'login' or 'setup'
  let isRecording = false;
  let ttsEnabled = true;
  let assistantName = 'Assistant';
  let localAssistantName = '';
  let cachedOllamaModels = [];
    let alarmAudioCtx = null;
    let alarmOscillator = null;
    let alarmRingingId = null;

  // --- Helpers ---

  /** Returns the current user session token for authenticated file API calls */
  function userSession() {
    return localStorage.getItem('dockbox-user-session') || '';
  }

  var cachedUserKeys = [];

  let cachedOllamaFriendlyNames = {};
  let cachedCloudModels = [];

  async function refreshModelDropdowns() {
    try {
      const r = await fetch('/api/ollama/test');
      const d = await r.json();
      if (d.ok && d.models) cachedOllamaModels = d.models;
      if (d && d.friendlyNames && typeof d.friendlyNames === 'object') {
        cachedOllamaFriendlyNames = d.friendlyNames;
      }
      if (d && Array.isArray(d.cloudModels)) {
        cachedCloudModels = d.cloudModels;
      }
    } catch {}
    // Fetch user's API keys for the dropdown
    if (currentUser) {
      try {
        const kr = await fetch('/api/api-keys', { headers: { 'X-User-Session': userSession() } });
        const kd = await kr.json();
        cachedUserKeys = (kd.keys || []).filter(function(k) { return k.is_active; });
      } catch {}
    }
    // Parse per-user model permissions (empty = all allowed)
    let userAllowedModels = [];
    if (currentUser && currentUser.allowed_models) {
      try { userAllowedModels = typeof currentUser.allowed_models === 'string' ? JSON.parse(currentUser.allowed_models) : currentUser.allowed_models; } catch {}
    }
    const modelAllowed = (val) => userAllowedModels.length === 0 || userAllowedModels.includes(val);

    ['modelSelect', 'talkModelSelect', 'heartbeatModelSelect', 'autoModelSelect'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prev = sel.value;
      let html = '';
      // Show all available Ollama models (includes :cloud tags like glm-5.2:cloud)
      if (cachedOllamaModels.length > 0) {
        html += '<option disabled>── Ollama ──</option>';
        for (const m of cachedOllamaModels) {
          const label = cachedOllamaFriendlyNames[m] || m;
          html += '<option value="local:' + esc(m) + '" style="color:#16a34a">' + esc(label) + '</option>';
        }
      }
      // Show user's own API key models (only AI model providers, not service keys like Stripe/GitHub)
      const MODEL_KEY_TYPES = { 'anthropic-api': 'Claude', 'anthropic-oauth': 'Claude', 'openai-api': 'GPT', 'openai-oauth': 'GPT', 'kimi': 'Kimi', 'deepseek': 'DeepSeek', 'groq': 'Groq', 'gemini': 'Gemini', 'mistral': 'Mistral' };
      const modelKeys = cachedUserKeys.filter(k => MODEL_KEY_TYPES[k.key_type]);
      if (modelKeys.length > 0) {
        html += '<option disabled>── Your Keys ──</option>';
        for (const k of modelKeys) {
          var displayLabel = k.label || MODEL_KEY_TYPES[k.key_type];
          html += '<option value="userkey:' + esc(k.id) + '">' + esc(displayLabel) + '</option>';
        }
      }
      sel.innerHTML = html;
      if (sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
      else {
        const saved = localStorage.getItem('dockbox-model') || '';
        if (sel.querySelector('option[value="' + saved + '"]')) sel.value = saved;
      }
      colorModelSelect(sel);
      if (!sel._modelColorBound) {
        sel.addEventListener('change', function() { colorModelSelect(this); });
        sel._modelColorBound = true;
      }
    });
  }

  function colorModelSelect(sel) {
    var v = sel.value || '';
    if (v.startsWith('local:')) {
      sel.style.color = '#16a34a';
    } else {
      sel.style.color = '#ea580c';
    }
  }

  /**
   * Append the user session token as a query param to a /api/files URL.
   * This allows the server to restrict access to the user's allowed folders.
   */
  function fileUrl(base) {
    const sep = base.includes('?') ? '&' : '?';
    return base + sep + 'usersession=' + encodeURIComponent(userSession());
  }

  // esc, escAttr, toast, botModelClass, senderColor, timeAgo/notifTimeAgo,
  // fmtSize/fmtFileSize are provided globally by /js/utils.js (loaded first).

  async function fetchNotifications() {
    if (!currentUser) return;
    try {
      const r = await fetch('/api/notification-list?limit=50');
      const d = await r.json();
      notifications = (d.notifications || []).map(function(n) {
        return { id: n.id, type: n.type, message: n.message, timestamp: n.created_at, read: !!n.read };
      });
      const unreadNotifs = d.unread || 0;
      const unreadChats = Object.values(unreadSessions).reduce(function(a, b) { return a + b; }, 0);
      notifCount = unreadNotifs + unreadChats;
      updateNotifBadge();
      renderNotifDropdown();
    } catch {}
  }

  async function markAllNotifRead() {
    if (!currentUser) return;
    try {
      await fetch('/api/notification-list/read-all', { method: 'PATCH' });
    } catch {}
  }

  function renderNotifDropdown() {
    const list = document.getElementById('notifDropdownList');
    if (!list) return;

    // Build combined items: API notifications + unread chat sessions
    var items = [];

    // Add API notifications
    for (var i = 0; i < notifications.length; i++) {
      var n = notifications[i];
      items.push({ id: n.id, type: n.type, message: n.message, timestamp: n.timestamp, read: n.read });
    }

    // Add unread chat session entries
    var sessions = currentUser ? (currentUser.allowed_sessions || []) : [];
    for (var j = 0; j < sessions.length; j++) {
      var jid = sessions[j];
      var count = unreadSessions[jid] || 0;
      if (count > 0) {
        var name = sessionName(jid);
        items.push({
          id: 'chat-' + jid,
          type: 'chat_unread',
          message: count + ' unread message' + (count > 1 ? 's' : '') + ' in ' + name,
          timestamp: new Date().toISOString(),
          read: false,
          jid: jid
        });
      }
    }

    if (items.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications</div>';
      return;
    }

    list.innerHTML = items.map(function(n) {
      var icons = { ping: '\u{1F514}', work_task: '\u{1F4CB}', chat_complete: '\u{1F4AC}', task: '\u{2705}', chat_unread: '\u{1F4E8}' };
      var icon = icons[n.type] || '\u{1F514}';
      var cls = n.read ? '' : ' unread';
      var ago = notifTimeAgo(n.timestamp);
      var clickAttr = n.jid ? ' data-jid="' + n.jid + '"' : '';
      return '<div class="notif-item' + cls + '" data-id="' + n.id + '"' + clickAttr + '>' +
        '<div class="notif-item-icon ' + (n.type || 'ping') + '">' + icon + '</div>' +
        '<div class="notif-item-body">' +
          '<div class="notif-item-msg">' + esc(n.message) + '</div>' +
          '<div class="notif-item-time">' + ago + '</div>' +
        '</div></div>';
    }).join('');

    // Click on chat unread items to navigate to that session
    list.querySelectorAll('.notif-item[data-jid]').forEach(function(el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function() {
        var jid = el.dataset.jid;
        navigateTo('chat');
        document.getElementById('notifDropdown').classList.add('hidden');
      });
    });
  }

  function toggleNotifDropdown() {
    const dd = document.getElementById('notifDropdown');
    if (!dd) return;
    const wasHidden = dd.classList.contains('hidden');
    dd.classList.toggle('hidden');
    if (wasHidden) renderNotifDropdown();
  }

  // Upload with progress bar
  function uploadWithProgress(url, file) {
    return new Promise((resolve, reject) => {
      const container = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast upload-progress';
      el.innerHTML = '<div class="upload-info"><span class="upload-name">' + esc(file.name) + '</span><span class="upload-pct">0%</span></div><div class="upload-bar"><div class="upload-bar-fill"></div></div>';
      container.appendChild(el);
      const fill = el.querySelector('.upload-bar-fill');
      const pct = el.querySelector('.upload-pct');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      const sess = localStorage.getItem('dockbox-user-session');
      if (sess) xhr.setRequestHeader('X-User-Session', sess);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          fill.style.width = p + '%';
          pct.textContent = p + '%';
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          fill.style.width = '100%';
          pct.textContent = '100%';
          el.classList.add('upload-done');
          setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 200); }, 1200);
          resolve(xhr);
        } else {
          el.classList.add('upload-error');
          pct.textContent = 'Error ' + xhr.status;
          setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 200); }, 2500);
          reject(new Error('Upload failed: ' + xhr.status));
        }
      };
      xhr.onerror = () => {
        el.classList.add('upload-error');
        pct.textContent = 'Failed';
        setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 200); }, 2500);
        reject(new Error('Upload failed'));
      };
      xhr.send(file);
    });
  }

  /** Shimmer placeholder rows shown while a view's first load is in flight */
  function skeletonHtml(lines) {
    var html = '<div class="skeleton-container" aria-hidden="true">';
    for (var i = 0; i < (lines || 4); i++) {
      html += '<div class="skeleton skeleton-line' + (i % 3 === 2 ? ' short' : '') + '"></div>';
    }
    return html + '</div>';
  }

  function getInitials(name) {
    return (name || '?').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function svgRing(percent, size, color) {
    var r = (size - 4) / 2, c = 2 * Math.PI * r;
    var offset = c - (Math.min(100, Math.max(0, percent)) / 100) * c;
    var col = color || 'var(--accent, #6366f1)';
    return '<svg width="'+size+'" height="'+size+'" class="progress-ring" viewBox="0 0 '+size+' '+size+'">'
      + '<circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" fill="none" stroke="var(--border, #333)" stroke-width="3" opacity=".3"/>'
      + '<circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="3" '
      + 'stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+offset.toFixed(1)+'" stroke-linecap="round" '
      + 'transform="rotate(-90 '+(size/2)+' '+(size/2)+')" style="transition:stroke-dashoffset .6s ease"/>'
      + '<text x="50%" y="50%" text-anchor="middle" dy=".35em" fill="var(--text-primary,#fff)" font-size="'+(size/4)+'" font-weight="600">'+Math.round(percent)+'%</text>'
      + '</svg>';
  }

  function renderAvatarGroup(users, max) {
    max = max || 4;
    var html = '<div class="avatar-group">';
    var shown = users.slice(0, max);
    shown.forEach(function(u) {
      var initial = (u.name || '?').charAt(0).toUpperCase();
      var bg = u.color || '#6366f1';
      html += '<div class="avatar-pip" style="background:'+bg+'" title="'+esc(u.name || '')+'">'+initial+'</div>';
    });
    if (users.length > max) {
      html += '<div class="avatar-pip avatar-more">+' + (users.length - max) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function formatMsgTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    if (isToday) return time;
    if (isYesterday) return 'Yesterday ' + time;
    const month = d.toLocaleString([], { month: 'short' });
    return month + ' ' + d.getDate() + ' ' + time;
  }

  function renderMarkdown(text) {
    // Extract [thinking] blocks before escaping so we can render them as collapsible
    const thinkingBlocks = [];
    text = text.replace(/\[thinking\]\n([\s\S]*?)\n\[\/thinking\]\n*/g, function(_, content) {
      thinkingBlocks.push(content.trim());
      return '\x00THINKING_' + (thinkingBlocks.length - 1) + '\x00';
    });
    let html = esc(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="msg-codeblock"><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="msg-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/^(#{1,3}) (.+)$/gm, (_, h, t) => `<strong style="font-size:${1.1 + (4 - h.length) * 0.1}em">${t}</strong>`);
    html = html.replace(/^- (.+)$/gm, '<span class="msg-bullet">&bull; $1</span>');
    // Markdown tables
    html = html.replace(/((?:^\|.+\|$\n?){2,})/gm, function(table) {
      var rows = table.trim().split('\n').filter(function(r) { return r.trim(); });
      if (rows.length < 2) return table;
      var isSep = function(r) { return /^\|[\s\-:|]+\|$/.test(r); };
      var parseRow = function(r) { return r.split('|').slice(1, -1).map(function(c) { return c.trim(); }); };
      var headerRow = parseRow(rows[0]);
      var sepIdx = rows.findIndex(function(r, i) { return i > 0 && isSep(r); });
      if (sepIdx < 0) return table;
      var bodyRows = rows.slice(sepIdx + 1).filter(function(r) { return !isSep(r); });
      var t = '<table class="msg-table"><thead><tr>' + headerRow.map(function(c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>';
      bodyRows.forEach(function(r) { var cells = parseRow(r); t += '<tr>' + cells.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; });
      t += '</tbody></table>';
      return t;
    });
    html = html.replace(/\n/g, '<br>');
    // Restore thinking blocks as collapsible sections
    html = html.replace(/\x00THINKING_(\d+)\x00/g, function(_, idx) {
      var content = esc(thinkingBlocks[parseInt(idx)]).replace(/\n/g, '<br>');
      return '<details class="msg-thinking"><summary>Thinking</summary><div class="msg-thinking-content">' + content + '</div></details>';
    });
    return html;
  }

  function renderAttachments(html, groupFolder) {
    if (!groupFolder) return html;
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    // [Image: path]
    html = html.replace(/\[Image:\s*([^\]]+)\]/g, (_, p) => {
      const serveUrl = '/api/files/serve?path=' + encodeURIComponent(groupFolder + '/' + p.trim()) + '&usersession=' + encodeURIComponent(userSession());
      const fname = p.trim().split('/').pop();
      return `<a href="${serveUrl}" target="_blank" class="chat-img-link"><img src="${serveUrl}" class="chat-img" alt="${esc(p.trim())}" loading="lazy" onerror="this.style.display='none';this.parentElement.innerHTML='&#128206; <span>${esc(fname)}</span> <span style=color:var(--text-secondary,#888);font-size:.75rem>(image not found)</span>';this.parentElement.className='chat-file-link'"></a>`;
    });
    // [File: path]
    html = html.replace(/\[File:\s*([^\]]+)\]/g, (_, p) => {
      const dlUrl = '/api/files/download?path=' + encodeURIComponent(groupFolder + '/' + p.trim()) + '&usersession=' + encodeURIComponent(userSession());
      const fname = p.trim().split('/').pop();
      return `<a href="${dlUrl}" class="chat-file-link" download>&#128206; ${esc(fname)}</a>`;
    });
    return html;
  }

  // --- Home / Overview ---

  async function loadHome() {
    const greeting = document.getElementById('homeGreeting');
    if (greeting && currentUser) {
      const hour = new Date().getHours();
      let greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      greeting.querySelector('.home-title').textContent = greet + ', ' + (currentUser.name || 'there');
    }

    const userId = currentUser?.id;
    if (!userId) return;
    const session = userSession();
    const today = new Date().toISOString().split('T')[0];

    // Skeletons on first load only (lists are empty until populated)
    ['homeSessionsList', 'homeActivityList'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el.childElementCount) el.innerHTML = skeletonHtml(3);
    });

    try {
      const [projListRes, automationsRes] = await Promise.all([
        fetch('/api/projects', { headers: { 'x-user-session': session } }).then(r => r.ok ? r.json() : { projects: [] }),
        fetch('/api/automations', { headers: { 'x-user-session': session } }).then(r => r.ok ? r.json() : []),
      ]);

      const projects = projListRes.projects || [];
      const automations = Array.isArray(automationsRes) ? automationsRes : [];
      const allowed = currentUser.allowed_sessions || [];

      // Fetch full detail for each project (deliverables, blockers, timesheet)
      const projectDetails = await Promise.all(projects.map(p =>
        fetch('/api/projects/' + p.id, { headers: { 'x-user-session': session } })
          .then(r => r.ok ? r.json() : p).catch(() => p)
      ));

      // Count files
      let fileCount = 0;
      try {
        const folders = allowed.map(jid => { const g = groupsMap[jid]; return g ? g.folder : jid; }).filter(Boolean);
        const results = await Promise.all(folders.map(f =>
          fetch(fileUrl('/api/files?path=' + encodeURIComponent(f))).then(r => r.ok ? r.json() : { entries: [] }).catch(() => ({ entries: [] }))
        ));
        for (const r of results) fileCount += (r.entries || []).length;
      } catch {}

      // Stat cards
      const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
      el('statProjects', projects.length);
      el('statFiles', fileCount);
      el('statAutomations', automations.filter(a => a.status === 'active').length);
      el('statMessages', allowed.length);

      // --- Project Progress ---
      const projList = document.getElementById('homeProjectsList');
      if (projList) {
        if (projects.length === 0) {
          projList.innerHTML = '<div class="home-empty-state"><p>No projects yet</p><button class="btn btn-accent btn-sm" onclick="UserDash.navigateTo(\'projects\')">Create one</button></div>';
        } else {
          projList.innerHTML = projectDetails.map(p => {
            const sc = p.status === 'On Track' ? 'on-track' : p.status === 'At Risk' ? 'at-risk' : p.status === 'Blocked' ? 'blocked' : 'default';
            const ringCol = sc === 'on-track' ? '#10b981' : sc === 'at-risk' ? '#f59e0b' : sc === 'blocked' ? '#ef4444' : '#6366f1';
            const dels = p.deliverables || [];
            const done = dels.filter(d => d.done).length;
            return '<div class="home-project-row" onclick="UserDash.navigateTo(\'projects\');setTimeout(()=>UserDash.openProject(\'' + escAttr(p.id) + '\'),100)">'
              + svgRing(p.progress || 0, 40, ringCol)
              + '<div style="flex:1;min-width:0">'
              + '<div class="home-project-info">'
              + '<span class="home-project-name">' + esc(p.name) + '</span>'
              + '<span class="project-status-badge status-' + sc + '" style="font-size:.65rem;padding:1px 6px">' + esc(p.status) + '</span>'
              + '</div>'
              + (dels.length ? '<div class="home-project-dels">' + done + '/' + dels.length + ' deliverables</div>' : '')
              + '</div>'
              + '</div>';
          }).join('');
        }
      }

      // --- Upcoming Deliverables ---
      const delsList = document.getElementById('homeDeliverablesList');
      if (delsList) {
        const allDels = [];
        for (const p of projectDetails) {
          for (const d of (p.deliverables || [])) {
            if (!d.done) allDels.push({ ...d, projectName: p.name, projectId: p.id });
          }
        }
        allDels.sort((a, b) => {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date.localeCompare(b.due_date);
        });
        if (allDels.length === 0) {
          delsList.innerHTML = '<div class="home-empty-state"><p>No pending deliverables</p></div>';
        } else {
          delsList.innerHTML = allDels.slice(0, 8).map(d => {
            const overdue = d.due_date && d.due_date < today;
            const dueStr = d.due_date ? new Date(d.due_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
            return '<div class="home-del-row">'
              + '<div class="home-del-info">'
              + '<span class="home-del-name">' + esc(d.name) + '</span>'
              + '<span class="home-del-project">' + esc(d.projectName) + '</span>'
              + '</div>'
              + (dueStr ? '<span class="home-del-due' + (overdue ? ' overdue' : '') + '">' + esc(dueStr) + '</span>' : '<span class="home-del-due">No date</span>')
              + '</div>';
          }).join('');
        }
      }

      // --- Active Blockers ---
      const blockersList = document.getElementById('homeBlockersList');
      if (blockersList) {
        const allBlockers = [];
        for (const p of projectDetails) {
          for (const b of (p.blockers || [])) {
            allBlockers.push({ ...b, projectName: p.name });
          }
        }
        const sevOrder = { critical: 0, high: 1, medium: 2 };
        allBlockers.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
        if (allBlockers.length === 0) {
          blockersList.innerHTML = '<div class="home-empty-state"><p>No blockers</p></div>';
        } else {
          var truncate = function(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; };
          blockersList.innerHTML = allBlockers.slice(0, 4).map(b =>
            '<div class="home-blocker-row severity-' + esc(b.severity) + '">'
            + '<span class="home-blocker-sev">' + esc(b.severity) + '</span>'
            + '<span class="home-blocker-text" title="' + esc(b.blocker).replace(/"/g, '&quot;') + '">' + esc(truncate(b.blocker, 60)) + '</span>'
            + '<span class="home-blocker-project">' + esc(truncate(b.projectName, 20)) + '</span>'
            + '</div>'
          ).join('') + (allBlockers.length > 4 ? '<div style="font-size:.75rem;color:var(--text-tertiary);padding:4px 0">+' + (allBlockers.length - 4) + ' more</div>' : '');
        }
      }

      // --- Time Logged ---
      const timeSummary = document.getElementById('homeTimeSummary');
      if (timeSummary) {
        let totalHours = 0;
        const byProject = [];
        for (const p of projectDetails) {
          const ts = p.timesheet_summary || { total_hours: 0 };
          totalHours += ts.total_hours || 0;
          if (ts.total_hours > 0) byProject.push({ name: p.name, hours: ts.total_hours });
        }
        byProject.sort((a, b) => b.hours - a.hours);
        if (totalHours === 0) {
          timeSummary.innerHTML = '<div class="home-empty-state"><p>No time logged yet</p></div>';
        } else {
          // Calculate this week's hours (Mon-Sun)
          const now = new Date();
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - mondayOffset);
          weekStart.setHours(0, 0, 0, 0);
          let weekHours = 0;
          for (const p of projectDetails) {
            for (const entry of (p.timesheet || [])) {
              const entryDate = new Date(entry.date + 'T00:00:00');
              if (entryDate >= weekStart) weekHours += (entry.hours || 0);
            }
          }
          timeSummary.innerHTML =
            '<div class="home-time-grid">'
            + '<div class="home-time-stat" style="background:var(--accent-light,rgba(16,185,129,0.1))">'
            + '<div class="home-time-stat-value" style="color:var(--accent,#10b981)">' + (weekHours ? weekHours.toFixed(1) : '0') + 'h</div>'
            + '<div class="home-time-stat-label">This Week</div></div>'
            + '<div class="home-time-stat" style="background:rgba(59,130,246,0.08)">'
            + '<div class="home-time-stat-value" style="color:#3b82f6">' + totalHours.toFixed(1) + 'h</div>'
            + '<div class="home-time-stat-label">All Time</div></div></div>'
            + byProject.slice(0, 5).map(p =>
              '<div class="home-time-row"><span>' + esc(p.name) + '</span><span class="home-time-hours">' + p.hours + 'h</span></div>'
            ).join('');
        }
      }

      // --- Sessions ---
      try {
        const statusRes = await cachedFetch('/api/status', null, 2000);
        const statusData = await statusRes.json();
        const sessionsList = document.getElementById('homeSessionsList');
        if (sessionsList && statusData.groups) {
          const userGroups = statusData.groups.filter(g => allowed.includes(g.jid));
          if (userGroups.length === 0) {
            sessionsList.innerHTML = '<div class="home-empty-state"><p>No sessions</p></div>';
          } else {
            sessionsList.innerHTML = userGroups.map(g => {
              const sc = g.active && !g.idle ? 'active' : g.active && g.idle ? 'idle' : 'offline';
              const sl = g.active && !g.idle ? 'Running' : g.active && g.idle ? 'Idle' : 'Offline';
              return '<div class="home-session-item" onclick="UserDash.navigateTo(\'chat\')">'
                + '<div class="home-session-status ' + sc + '"></div>'
                + '<div class="home-session-info"><div class="home-session-name">' + esc(g.name) + '</div>'
                + '<div class="home-session-detail">' + esc(g.active ? (g.containerName || 'container') : 'No container') + '</div></div>'
                + '<span class="home-session-badge ' + sc + '">' + sl + '</span></div>';
            }).join('');
          }
        }
      } catch {}

      // --- Recent Activity ---
      const activityList = document.getElementById('homeActivityList');
      if (activityList) {
        const activities = [];
        for (const p of projectDetails) {
          const label = esc(p.name).charAt(0).toUpperCase();
          activities.push({
            text: '<strong>' + esc(p.name) + '</strong> — ' + esc(p.status) + ' (' + (p.progress || 0) + '%)',
            color: p.status === 'On Track' ? '#10b981' : p.status === 'At Risk' ? '#f59e0b' : '#ef4444',
            initial: label,
            time: p.updated_at || p.created_at
          });
        }
        automations.forEach(a => {
          if (a.last_run) activities.push({
            text: '<strong>' + esc((a.prompt || '').slice(0, 40)) + '...</strong> ran',
            color: '#8b5cf6', initial: 'A',
            time: a.last_run
          });
        });
        activities.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
        if (activities.length === 0) {
          activityList.innerHTML = '<div class="home-empty-state"><p>No recent activity</p></div>';
        } else {
          activityList.innerHTML = activities.slice(0, 10).map(a =>
            '<div class="home-activity-item">'
            + '<div class="home-activity-avatar" style="background:' + a.color + '">' + (a.initial || '?') + '</div>'
            + '<div class="home-activity-content"><div class="home-activity-text">' + a.text + '</div>'
            + '<div class="home-activity-time">' + timeAgo(a.time) + '</div></div></div>'
          ).join('');
        }
      }

      // --- My Tasks ---
      const homeTasksList = document.getElementById('homeTasksList');
      if (homeTasksList) {
        try {
          const tasksRes = await fetch('/api/work-tasks', { headers: { 'x-user-session': session } });
          const tasksData = tasksRes.ok ? await tasksRes.json() : { tasks: [] };
          const allTasks = (tasksData.tasks || []).filter(t => t.status !== 'done');
          const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
          allTasks.sort((a, b) => {
            if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
            if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
            const pd = (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2);
            if (pd !== 0) return pd;
            if (!a.due_date && !b.due_date) return 0;
            if (!a.due_date) return 1;
            if (!b.due_date) return -1;
            return a.due_date.localeCompare(b.due_date);
          });
          if (allTasks.length === 0) {
            homeTasksList.innerHTML = '<div class="home-empty-state"><p>No open tasks</p></div>';
          } else {
            const priColors = { urgent: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: '#94a3b8' };
            homeTasksList.innerHTML = allTasks.slice(0, 10).map(t => {
              const isAssignedToMe = t.assigned_to === userId;
              const overdue = t.due_date && t.due_date < today;
              const dueStr = t.due_date ? new Date(t.due_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
              const fromLabel = t.project_name ? esc(t.project_name) : (isAssignedToMe && t.created_by_name ? 'from ' + esc(t.created_by_name) : (!isAssignedToMe && t.assigned_to_name ? 'for ' + esc(t.assigned_to_name) : ''));
              const statusNext = t.status === 'todo' ? 'in_progress' : 'done';
              const priColor = priColors[t.priority] || '#3b82f6';
              const checked = t.status === 'done' ? ' checked' : '';
              return '<div class="home-task-row' + (t.status === 'in_progress' ? ' in-progress' : '') + '">'
                + '<input type="checkbox"' + checked + ' style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;flex-shrink:0" onclick="UserDash.updateQuickTaskStatus(\'' + escAttr(t.id) + '\',\'' + statusNext + '\')">'
                + '<div class="home-task-info">'
                + '<span class="home-task-title">' + esc(t.title) + '</span>'
                + (fromLabel ? '<span class="home-task-from">' + fromLabel + '</span>' : '')
                + '</div>'
                + '<div class="home-task-meta">'
                + '<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;background:' + priColor + '18;color:' + priColor + '">' + esc(t.priority) + '</span>'
                + (dueStr ? '<span class="home-del-due' + (overdue ? ' overdue' : '') + '">' + esc(dueStr) + '</span>' : '')
                + '</div>'
                + '</div>';
            }).join('');
          }
        } catch (e) {
          homeTasksList.innerHTML = '<div class="home-empty-state"><p>Failed to load tasks</p></div>';
        }
      }

      // --- Reminders (scheduled/cron tasks) ---
      const homeRemindersList = document.getElementById('homeRemindersList');
      const remindersCount = document.getElementById('remindersCount');
      if (homeRemindersList) {
        try {
          const remRes = await fetch('/api/tasks', { headers: { 'x-user-session': session } });
          const remData = remRes.ok ? await remRes.json() : { tasks: [] };
          const allRem = (remData.tasks || []).filter(t => t.status !== 'paused' && t.status !== 'deleted');
          if (remindersCount) remindersCount.textContent = allRem.length;
          if (allRem.length === 0) {
            homeRemindersList.innerHTML = '<div class="home-empty-state"><p>No active reminders</p></div>';
          } else {
            homeRemindersList.innerHTML = allRem.slice(0, 15).map(t => {
              const next = t.next_run ? new Date(t.next_run).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
              let schedLabel = '';
              if (t.schedule_type === 'cron') schedLabel = 'cron: ' + esc(t.schedule_value || '');
              else if (t.schedule_type === 'interval') {
                const ms = parseInt(t.schedule_value, 10) || 0;
                const mins = Math.round(ms / 60000);
                schedLabel = mins >= 60 ? 'every ' + (mins / 60) + 'h' : 'every ' + mins + 'm';
              } else if (t.schedule_type === 'once') schedLabel = 'once';
              else schedLabel = esc(t.schedule_type || '');
              const statusColor = t.status === 'active' ? '#10b981' : '#6b7280';
              return '<div class="home-task-row">'
                + '<div class="home-task-info" style="flex:1;min-width:0">'
                + '<span class="home-task-title">' + esc(t.prompt || '(no prompt)') + '</span>'
                + '<span class="home-task-from">' + schedLabel + '</span>'
                + '</div>'
                + '<div class="home-task-meta">'
                + '<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;background:' + statusColor + '18;color:' + statusColor + '">' + esc(t.status) + '</span>'
                + (next ? '<span class="home-del-due">next: ' + esc(next) + '</span>' : '')
                + '</div>'
                + '</div>';
            }).join('');
          }
        } catch (e) {
          homeRemindersList.innerHTML = '<div class="home-empty-state"><p>Failed to load reminders</p></div>';
        }
      }

    } catch (err) {
      console.error('Failed to load home stats:', err);
    }
  }

  // --- Navigation ---

  function navigateTo(view) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const navEl = document.querySelector(`[data-view="${view}"]`);
    if (navEl) navEl.classList.add('active');
    const viewEl = document.getElementById('view-' + view);
    if (viewEl) viewEl.classList.add('active');
    currentView = view;
    localStorage.setItem('dockbox-user-view', view);

    if (view === 'home') loadHome();
    if (view === 'chat') { markSessionRead(currentSession); loadChat(); loadIdeas(); syncTypingIndicatorForSession(); refreshModelDropdowns(); }
    if (view === 'projects') loadProjects();
    if (view === 'calendar') loadCalendarEvents();
    if (view === 'automater') { renderAutoTemplates(); loadAutomations(); }
    if (view === 'email') loadEmailView();
    if (view === 'settings') loadSettingsView();
    if (view === 'sms') loadSmsView();
    if (view === 'accounts') loadConnectedAccounts();
    if (view === 'vault') loadVault();
    if (view === 'apikeys') loadUsageDashboard();
    if (view === 'actions') renderActions();
    if (view === 'talk') initTalkView();
    if (view === 'heartbeat') loadHeartbeat();
      if (view === 'alarms') loadAlarms();
    if (view === 'logs') loadLogs();
    if (view !== 'projects') updateRightSidebar(view);
  }

  function updateRightSidebar(view) {
    const title = document.getElementById('rsbTitle');
    const body = document.getElementById('rsbBody');
    if (!title || !body) return;

    const sidebarContent = {
      home: function() {
        title.textContent = 'Quick Start';
        var go = function(emoji, label, view) { return '<button class="rsb-action-btn" onclick="UserDash.navigateTo(\'' + view + '\')">' + emoji + ' ' + label + '</button>'; };
        var say = function(emoji, label, text) { return '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'' + text.replace(/'/g, "\\'") + '\';document.getElementById(\'chatInput\').focus();},100)">' + emoji + ' <strong>' + label + ':</strong> \u201C' + text + '\u201D</div>'; };
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">What Is This?</div>'
          + '<div class="rsb-tip">This is your <strong>AI agent</strong> \u2014 not a chatbot. It can read files, send emails, manage projects, write code, call APIs, and chain hundreds of actions from a single prompt.</div>'
          + '<div class="rsb-tip">Go to <strong>Chat</strong> and give it a task. Be specific about what you want done.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Jump In</div>'
          + go('\u{1F4AC}', 'Chat with Warden', 'chat')
          + go('\u26A1', 'Quick Actions', 'actions')
          + go('\u{1F4C1}', 'Upload files', 'files')
          + go('\u{1F680}', 'Create a project', 'projects')
          + go('\u{1F4C5}', 'Calendar', 'calendar')
          + go('\u23F0', 'Set up automations', 'automater')
          + go('\u{1F4E7}', 'Email', 'email')
          + go('\u{1F511}', 'API Keys & Connections', 'apikeys')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Try Saying...</div>'
          + say('\u{1F4E7}', 'Email', 'Check my email')
          + say('\u2705', 'Task', 'Create a task for Sarah to review the proposal by Friday')
          + say('\u{1F4C4}', 'Document', 'Write a one-page summary of our Q3 results as a PDF')
          + say('\u23F0', 'Automate', 'Schedule a daily briefing at 9am')
          + say('\u{1F680}', 'Project', 'Create a project called Website Redesign with deliverables')
          + say('\u{1F310}', 'Research', 'Research competitors in the CRM space and write a report')
          + say('\u{1F4BB}', 'Code', 'Write a Python script that converts CSV to JSON')
          + say('\u{1F4F1}', 'SMS', 'Send a text to +1234567890 saying I\'ll be late')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Models</div>'
          + '<div class="rsb-tip"><strong>Default</strong> \u2014 Thorough, best for complex tasks.</div>'
          + '<div class="rsb-tip"><strong>Alt</strong> \u2014 Powerful. Overkill for most tasks, great for a second opinion.</div>'
          + '<div class="rsb-tip"><strong>Fast</strong> \u2014 Lightweight. Test if your workflow runs fully offline on your own hardware.</div>'
          + '<div class="rsb-tip">Switch models in Chat using the dropdown next to the input.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Tips</div>'
          + '<div class="rsb-tip"><strong>One prompt per task.</strong> Don\u2019t send follow-ups while it\u2019s working.</div>'
          + '<div class="rsb-tip"><strong>New Thought</strong> \u2014 Click this in Chat to reset context between tasks.</div>'
          + '<div class="rsb-tip"><strong>Be specific.</strong> \u201CMake a PDF report about Q3 sales with charts\u201D beats \u201Cmake a report.\u201D</div>'
          + '<div class="rsb-tip"><strong>It can see images.</strong> Paste or attach a photo and ask about it.</div>'
          + '<div class="rsb-tip"><strong>Add your own API key</strong> in API Keys to use your own quota for heavier workloads.</div>'
          + '</div>';
      },
      projects: function() {
        title.textContent = 'Projects';
        const total = projectsCache.length;
        const onTrack = projectsCache.filter(p => p.status === 'On Track').length;
        const atRisk = projectsCache.filter(p => p.status === 'At Risk').length;
        const blocked = projectsCache.filter(p => p.status === 'Blocked').length;
        const avgProgress = total ? Math.round(projectsCache.reduce((s, p) => s + (p.progress || 0), 0) / total) : 0;
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Overview</div>'
          + '<div class="rsb-stat" title="Total projects across all groups"><span class="rsb-stat-label">Total Projects</span><span class="rsb-stat-value">' + total + '</span></div>'
          + '<div class="rsb-stat" title="On schedule"><span class="rsb-stat-label">On Track</span><span class="rsb-stat-value" style="color:#059669">' + onTrack + '</span></div>'
          + '<div class="rsb-stat" title="Needs attention"><span class="rsb-stat-label">At Risk</span><span class="rsb-stat-value" style="color:#d97706">' + atRisk + '</span></div>'
          + '<div class="rsb-stat" title="Cannot proceed"><span class="rsb-stat-label">Blocked</span><span class="rsb-stat-value" style="color:#dc2626">' + blocked + '</span></div>'
          + '<div class="rsb-mini-progress" title="Average completion across all projects"><span class="rsb-stat-label">Avg Progress</span><div class="rsb-mini-progress-bar"><div class="rsb-mini-progress-fill" style="width:' + avgProgress + '%"></div></div><span class="rsb-mini-progress-text">' + avgProgress + '%</span></div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Active Timers</div><div id="rsbTimers">Loading...</div></div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Recent Time</div><div id="rsbRecentTime">Loading...</div></div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Actions</div>'
          + '<button class="rsb-action-btn" title="Create a new project" onclick="UserDash.openProjectModal()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New Project</button>'
          + '<button class="rsb-action-btn" title="View archived projects" onclick="document.getElementById(\'btnProjectArchive\').click()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg>View Archive</button>'
          + '</div>';
        // Load timers and recent time async
        loadSidebarTimers();
        loadSidebarRecentTime();
      },
      chat: function() {
        title.textContent = 'Chat Help';
        const sessions = currentUser ? (currentUser.allowed_sessions || []) : [];
        const tip = function(emoji, text) { return '<div class="rsb-tip" style="cursor:pointer" onclick="document.getElementById(\'chatInput\').value=\'' + text.replace(/'/g, "\\'") + '\';document.getElementById(\'chatInput\').focus();">' + emoji + ' <strong>\u201C' + text + '\u201D</strong></div>'; };
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">How Chat Works</div>'
          + '<div class="rsb-tip">This is an <strong>agent</strong>, not a chatbot. Give it tasks \u2014 it will read files, call APIs, write code, send emails, and chain actions together.</div>'
          + '<div class="rsb-tip"><strong>One prompt per task.</strong> Don\u2019t send follow-ups while it\u2019s working. Hit stop first if you need to change course.</div>'
          + '<div class="rsb-tip"><strong>New Thought</strong> \u2014 Click this in the chat header when switching topics. It resets the conversation context without losing your files or memory.</div>'
          + '<div class="rsb-tip"><strong>Attach files</strong> by clicking the paperclip or pasting an image. The agent can see images and read documents.</div>'
          + '<div class="rsb-tip"><strong>Voice input</strong> \u2014 Click the microphone to speak instead of typing.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Models</div>'
          + '<div class="rsb-tip"><strong>Default</strong> \u2014 Thorough and detailed. Best for complex tasks.</div>'
          + '<div class="rsb-tip"><strong>Alt</strong> \u2014 Powerful. Overkill for most tasks, great for a second opinion.</div>'
          + '<div class="rsb-tip"><strong>Fast</strong> \u2014 Lightweight. Test if your workflow runs fully offline.</div>'
          + '<div class="rsb-tip">All models are the same assistant with the same tools and memory. Switch with the dropdown next to the input.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Tasks &amp; Projects</div>'
          + tip('\u2705', 'Create a task for Sarah to review the proposal by Friday')
          + tip('\u{1F4CB}', 'Show me all my open tasks')
          + tip('\u{1F680}', 'Create a project called Website Redesign with 3 deliverables')
          + tip('\u23F1\uFE0F', 'Start a timer for the Johnson project')
          + tip('\u{1F4CA}', 'Show project progress for all active projects')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Email &amp; Communication</div>'
          + tip('\u{1F4E7}', 'Check my email')
          + tip('\u2709\uFE0F', 'Send an email to sarah@company.com about the meeting notes')
          + tip('\u{1F4F1}', 'Send a text to +1234567890 saying I\'ll be 10 minutes late')
          + tip('\u{1F4E2}', 'Ping Sarah about the meeting')
          + tip('\u{1F4DD}', 'Draft a reply to the last email from John')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Files &amp; Documents</div>'
          + tip('\u{1F4C4}', 'Write a one-page summary of renewable energy trends as a PDF')
          + tip('\u{1F50D}', 'Find all files modified in the last week')
          + tip('\u{1F4C1}', 'Organize my files into folders by type')
          + tip('\u{1F4F7}', 'Look at the image I just attached')
          + tip('\u{1F4CA}', 'Analyze the spreadsheet data.csv and create charts')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Scheduling &amp; Automations</div>'
          + tip('\u23F0', 'Schedule a daily briefing at 9am')
          + tip('\u{1F514}', 'Remind me to call John in 2 hours')
          + tip('\u{1F504}', 'Set up a weekly report every Monday at 9am')
          + tip('\u{1F4C5}', 'Add a meeting with Sarah tomorrow at 2pm')
          + tip('\u{1F50D}', 'What meetings do I have this week?')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Research &amp; Web</div>'
          + tip('\u{1F310}', 'Research competitors in the CRM space and write a report')
          + tip('\u{1F4F0}', 'Summarize the latest news about AI regulation')
          + tip('\u{1F517}', 'Scrape the pricing page at example.com and put it in a spreadsheet')
          + tip('\u{1F4D6}', 'Read this article and give me the key takeaways')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Code &amp; Building</div>'
          + tip('\u{1F4BB}', 'Write a Python script that converts CSV to JSON')
          + tip('\u{1F6E0}\uFE0F', 'Build a simple dashboard that shows my sales data')
          + tip('\u{1F41B}', 'Debug this error: paste the error message here')
          + tip('\u{1F4E6}', 'Install pandas and matplotlib in my workspace')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">API &amp; Integrations</div>'
          + tip('\u{1F5C2}\uFE0F', 'Pull my latest Stripe invoices')
          + tip('\u{1F4AC}', 'List my GitHub issues for the dockbox repo')
          + tip('\u2601\uFE0F', 'Check my QuickBooks balance')
          + tip('\u{1F527}', 'What API keys do I have connected?')
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Token Tips</div>'
          + '<div class="rsb-tip"><strong>New Thought often.</strong> Long conversations cost more tokens and can confuse the agent. Reset between tasks.</div>'
          + '<div class="rsb-tip"><strong>Be specific.</strong> \u201CMake a PDF report about Q3 sales with charts\u201D works better than \u201Cmake a report.\u201D</div>'
          + '<div class="rsb-tip"><strong>Large files add tokens.</strong> If you attach a big file, the agent reads the whole thing each turn.</div>'
          + '<div class="rsb-tip"><strong>Tools multiply calls.</strong> Each tool the agent uses (Read, Write, API call) is a separate AI request with full context.</div>'
          + '<div class="rsb-tip"><strong>Add your own API key</strong> in the API Keys tab to use your own quota for heavier workloads.</div>'
          + '</div>';
      },
      vault: function() {
        title.textContent = 'Vault';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Privacy <span title="PII scrubbing information" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Scrubbed files have personal data replaced with placeholders">The vault stores scrubbed versions of files with personal information removed.</div>'
          + '<div class="rsb-tip" title="Build a custom dictionary of terms to scrub from your files">Add words to the dictionary to flag them for removal in future scrubs. Select text in the preview to quick-add.</div>'
          + '<div class="rsb-tip" title="Restoring replaces the scrubbed version with the original">Restore files to put back the original unscrubbed version.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Quick Actions</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="document.getElementById(\'btnRestore\')?.click()" title="Click to restore selected files">↩️ <strong>Restore selected files</strong> — Put back original versions</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="document.getElementById(\'btnDeleteScrubbed\')?.click()" title="Permanently delete scrubbed files">🗑️ <strong>Delete scrubbed files</strong> — Free up vault space</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">What Gets Scrubbed?</div>'
          + '<div class="rsb-tip">✓ Names, emails, phone numbers</div>'
          + '<div class="rsb-tip">✓ Addresses, ID numbers</div>'
          + '<div class="rsb-tip">✓ Custom dictionary words</div>'
          + '</div>';
      },
      automater: function() {
        title.textContent = 'Schedules';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">About <span title="Scheduled automation tasks" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Automation prompts run on schedule you set">Scheduled tasks run automatically at the specified time each day.</div>'
          + '<div class="rsb-tip" title="AI can perform any action you can do in chat">The AI receives your prompt and can take actions like sending messages, managing files, or updating tasks.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Quick Start Templates</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Schedule a daily morning briefing at 8:30am that summarizes my tasks and calendar\';document.getElementById(\'chatInput\').focus();},100)" title="Click to create morning briefing automation">🌅 <strong>Morning Briefing</strong> — Daily at 8:30am with tasks + calendar</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Schedule an end of day summary at 5pm that checks what was accomplished\';document.getElementById(\'chatInput\').focus();},100)" title="Click to create EOD summary">🌆 <strong>End of Day</strong> — Daily at 5pm summarizing accomplishments</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Schedule a weekly report every Monday at 9am with project status\';document.getElementById(\'chatInput\').focus();},100)" title="Click to create weekly report">📊 <strong>Weekly Report</strong> — Mondays at 9am with project updates</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Schedule Types</div>'
          + '<div class="rsb-tip">⏰ <strong>Interval</strong> — Every N minutes/hours</div>'
          + '<div class="rsb-tip">📅 <strong>Daily</strong> — At specific time each day</div>'
          + '<div class="rsb-tip">🔄 <strong>Cron</strong> — Complex patterns (M-F at 9am)</div>'
          + '</div>';
      },
      calendar: function() {
        title.textContent = 'Calendar';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Actions <span title="Calendar operations" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<button class="rsb-action-btn" title="Create a new calendar event" onclick="document.getElementById(\'btnCalNewEvent\').click()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New Event</button>'
          + '<button class="rsb-action-btn" title="Import events from .ics file" onclick="document.getElementById(\'btnCalImport\').click()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Import .ics</button>'
          + '<button class="rsb-action-btn" title="Export calendar to .ics file" onclick="document.getElementById(\'btnCalExport\').click()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Export .ics</button>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Tips <span title="Calendar tips" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Connect Google/Outlook in Settings > Connected Accounts">Sync with Google or Outlook calendars for two-way sync.</div>'
          + '<div class="rsb-tip" title="Events can have start time, end time, and reminders">Set reminders on events to get notified before they start.</div>'
          + '<div class="rsb-tip" title="Click any day to see events for that date">Click any date to jump to that day.</div>'
          + '</div>';
      },
      email: function() {
        title.textContent = 'Email';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Info <span title="Email integration details" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="IMAP receives mail, SMTP sends mail">Email accounts connect via IMAP for reading and SMTP for sending.</div>'
          + '<div class="rsb-tip" title="Read Only = AI can read but not send emails">Read Only Mode: AI can read and analyze emails but cannot send. Enable Read Write to allow sending.</div>'
          + '<div class="rsb-tip" title="Check Settings > Connected Accounts for OAuth">Google/Outlook OAuth accounts sync automatically every 15 minutes.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Try Saying...</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Check my email\';document.getElementById(\'chatInput\').focus();},100)" title="Read recent emails">📧 "Check my email" — Read unread messages</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Send an email to john@example.com about the project update\';document.getElementById(\'chatInput\').focus();},100)" title="Compose and send email">✉️ "Send an email to john@example.com..."</div>'
          + '</div>';
      },
      alarms: function() {
        title.textContent = 'Alarms';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Actions <span title="Create and manage alarms" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<button class="rsb-action-btn" title="Create a new alarm" onclick="document.getElementById(\'btn-new-alarm\').click()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New Alarm</button>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Tips <span title="Alarm usage tips" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Alarms play sound + show notification">Set alarms for reminders and deadlines. Alarms play a sound and show a notification when they fire.</div>'
          + '<div class="rsb-tip" title="Daily, Weekdays, or custom days">Repeating alarms fire daily, on weekdays, or on custom days.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Try Saying...</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Set an alarm for 9am called Morning Standup\';document.getElementById(\'chatInput\').focus();},100)" title="Create alarm via chat">⏰ "Set an alarm for 9am called Morning Standup"</div>'
          + '</div>';
      },
      heartbeat: function() {
        title.textContent = 'Heartbeat';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Info <span title="Hourly automated instructions" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Runs every hour automatically">Heartbeat instructions run automatically every hour. The AI reads your instructions and executes them on schedule.</div>'
          + '<div class="rsb-tip" title="Great for monitoring tasks">Use this for ongoing monitoring, like checking email, reviewing TODOs, or updating journal entries.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Example Heartbeats</div>'
          + '<div class="rsb-tip">📬 <strong>Email Monitor</strong> — Check inbox and notify about urgent emails</div>'
          + '<div class="rsb-tip">📋 <strong>TODO Review</strong> — Scan TODO.md and ping about overdue items</div>'
          + '<div class="rsb-tip">📝 <strong>Journal Update</strong> — Append today\'s activity to JOURNAL.md</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Try Saying...</div>'
          + '<div class="rsb-tip" style="cursor:pointer" onclick="UserDash.navigateTo(\'chat\');setTimeout(function(){document.getElementById(\'chatInput\').value=\'Set up a heartbeat that checks my email every hour and notifies me about urgent messages\';document.getElementById(\'chatInput\').focus();},100)" title="Create heartbeat via chat">💓 "Set up a heartbeat that checks my email..."</div>'
          + '</div>';
      },
      accounts: function() {
        title.textContent = 'Connected Accounts';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Info <span title="OAuth account connections" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Google = Calendar + Gmail, Microsoft = Outlook + Exchange">Connect your Google or Microsoft account to sync calendar events and use OAuth-based email.</div>'
          + '<div class="rsb-tip" title="Auto-sync every 15 minutes">Calendar events from connected providers sync automatically every 15 minutes. You can push local events manually.</div>'
          + '<div class="rsb-tip" title="OAuth accounts work alongside regular IMAP accounts">OAuth email accounts appear alongside IMAP accounts in the Email view.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Supported Providers</div>'
          + '<div class="rsb-tip">🔵 <strong>Google</strong> — Gmail, Google Calendar</div>'
          + '<div class="rsb-tip">🟦 <strong>Microsoft</strong> — Outlook, Exchange, Office 365</div>'
          + '</div>';
      },
      actions: function() {
        title.textContent = 'Quick Actions';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Info <span title="Pre-built prompt templates" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="One-click shortcuts for common tasks">Quick actions are pre-built prompts you can customize and send with one click.</div>'
          + '<div class="rsb-tip" title="Files provide context to the AI">Attach files to include them as context in the prompt.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">How to Use</div>'
          + '<div class="rsb-tip">1️⃣ Select an action from the list</div>'
          + '<div class="rsb-tip">2️⃣ Customize the prompt if needed</div>'
          + '<div class="rsb-tip">3️⃣ Attach files for context (optional)</div>'
          + '<div class="rsb-tip">4️⃣ Click Send to run the action</div>'
          + '</div>';
      },
      apikeys: function() {
        title.textContent = 'API Keys';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">API Keys</div>'
          + '<div class="rsb-tip">Add API keys for third-party services. Your assistant can use them to call APIs on your behalf.</div>'
          + '<div class="rsb-tip">Keys are encrypted at rest and never exposed to the assistant directly.</div>'
          + '<div class="rsb-tip">Select a provider from the dropdown or choose "Custom / Other" for any service.</div>'
          + '</div>';
      },
      talk: function() {
        title.textContent = 'Talk';
        body.innerHTML =
          '<div class="rsb-section"><div class="rsb-section-title">Controls <span title="Voice conversation controls" style="cursor:help;color:var(--text-tertiary)">ⓘ</span></div>'
          + '<div class="rsb-tip" title="Click once to start, click again to stop and send">Tap the orb to start speaking. Tap again to stop and send your message.</div>'
          + '<div class="rsb-tip" title="Conversation mode keeps listening after AI responds">Enable "Conversation" mode for continuous back-and-forth without tapping each time.</div>'
          + '<div class="rsb-tip" title="Uses browser speech synthesis for responses">Toggle "Read aloud" to have responses spoken back to you via TTS.</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Model Selection</div>'
          + '<div class="rsb-tip" title="All models are Warden — same assistant, different speeds">All models are <strong>Warden</strong> — same memory, same tools, different personality.</div>'
          + '<div class="rsb-tip" title="Thorough and detailed, best for complex tasks">Default — Thorough and detailed, best for complex tasks</div>'
          + '<div class="rsb-tip" title="Powerful model, great for second opinions">Alt — Powerful. Overkill for most tasks, great for a second opinion</div>'
          + '<div class="rsb-tip" title="Test if your workflow can run fully offline">Fast — Lightweight. Test if your workflow runs on modest hardware</div>'
          + '</div>'
          + '<div class="rsb-divider"></div>'
          + '<div class="rsb-section"><div class="rsb-section-title">Tips</div>'
          + '<div class="rsb-tip" title="Speak clearly for best transcription">Speak clearly and pause briefly between sentences for better transcription.</div>'
          + '<div class="rsb-tip" title="Browser handles audio">Audio is processed locally in your browser. Check mic permissions if transcription fails.</div>'
          + '<div class="rsb-tip" title="View full transcript below">Your conversation history appears in the transcript area below the orb.</div>'
          + '</div>';
      },
    };

    const fn = sidebarContent[view];
    if (fn) fn();
    else {
      title.textContent = 'Info';
      body.innerHTML = '<div class="rsb-section"><p class="rsb-hint">Select a view for contextual help and actions.</p></div>';
    }

    // Append "How Do I...?" FAQ accordion
    var faqs = {
      home: [
        ['Create a quick task?', 'Click the "+ Quick Task" button in the My Tasks card. Fill in the title, optionally assign it to someone, set priority and due date, then click Save.'],
        ['Check my task progress?', 'The My Tasks card shows all tasks assigned to you. In-progress tasks have a highlighted left border. Click the play button to start a task, or the checkmark to complete it.'],
        ['Navigate to a specific section?', 'Click any of the four stat cards at the top (Projects, Files, Automations, Chats) to jump to that section. You can also use the icons in the left sidebar.'],
        ['See my upcoming deadlines?', 'The Upcoming Deliverables card shows pending deliverables sorted by due date. Overdue items appear in red.'],
      ],
      projects: [
        ['Create a new project?', 'Click the "New Project" button. Give it a name, optional description, project code, and due date. It will appear in your project list.'],
        ['Add deliverables to a project?', 'Open a project, go to the Deliverables tab, and click "+ Add". Enter a name and optional due date. Check them off as you complete them — progress updates automatically.'],
        ['Track time on a project?', 'Open a project and click the timer icon to start tracking. Click again to stop. You can also log time manually from the Time tab.'],
        ['Add blockers or priorities?', 'Open a project and use the Blockers or Priorities tabs. Click "+ Add" to create entries with severity or impact levels.'],
      ],
      chat: [
        ['Send a message?', 'Type in the text box and press Enter or click Send. Give it a task, not a question \u2014 be specific about what you want done.'],
        ['Attach a file or image?', 'Click the paperclip icon, drag-and-drop, or paste an image from your clipboard. The agent can see images and read documents.'],
        ['Switch AI models?', 'Use the model dropdown next to the input. Default is thorough, Alt is concise, Fast is for testing offline workflows. All share the same memory and tools.'],
        ['Use voice input?', 'Click the microphone button to speak. Click again to stop \u2014 your speech is transcribed and sent as text.'],
        ['What is New Thought?', 'It clears the conversation context so the agent starts fresh. Your files and memory stay \u2014 just the chat history resets. Use it between tasks.'],
        ['Why is it slow?', 'Long conversations carry more history per message. Click New Thought to reset. Also, complex tasks with many tool calls take longer \u2014 that\u2019s normal.'],
        ['Can it see images?', 'Yes. Attach or paste an image and the agent will read it. It works with JPG, PNG, GIF, and WebP files.'],
        ['Can it send emails?', 'Yes. Say "send an email to sarah@company.com about X" and it will draft and send. Connect your email in Connected Accounts first.'],
        ['Can it write code?', 'Yes. It can write Python, JavaScript, HTML, and more. It can also install packages, run scripts, and build web pages in your workspace.'],
        ['Can it call APIs?', 'Yes. Add your API keys in the API Keys tab. Then say "pull my Stripe invoices" or "list my GitHub issues" \u2014 it handles authentication automatically.'],
        ['Stop a running task?', 'Click the End button on the typing indicator bar, or wait for it to finish. Don\u2019t send new messages while it\u2019s working.'],
        ['What are Quick Actions?', 'Pre-built prompt templates in the Actions tab. Great for common tasks like writing emails, debugging code, or creating projects.'],
      ],
      files: [
        ['Upload files?', 'Click "Upload" or drag and drop files onto the file browser. Files are stored in your workspace.'],
        ['Scrub personal information?', 'Select files and click "Scrub PII" to remove names, emails, phone numbers, and other personal data. Originals are saved in the Vault.'],
        ['Download a file?', 'Click on any file to preview it, then use the download button. Or right-click for direct download.'],
      ],
      vault: [
        ['Restore an original file?', 'Find the scrubbed file in the vault and click "Restore" to replace the scrubbed version with the original.'],
        ['Add words to the dictionary?', 'Select text in the file preview and click "Add to dictionary" — those words will be flagged for removal in future scrubs.'],
      ],
      automater: [
        ['Create a scheduled task?', 'Click "New Automation", write your prompt (what the AI should do), pick a schedule (daily, hourly, cron, or one-time), and save.'],
        ['Pause or resume a task?', 'Click the pause icon on any running automation to stop it temporarily. Click play to resume.'],
        ['Edit an existing automation?', 'Click on the automation to open it, modify the prompt or schedule, then save.'],
      ],
      calendar: [
        ['Create an event?', 'Click "New Event", fill in the title, date, time, and optional description. Assign it to a team member if needed.'],
        ['Import events?', 'Click "Import .ics" to load events from an .ics calendar file.'],
        ['Export my calendar?', 'Click "Export .ics" to download all events as an .ics file you can import into other calendar apps.'],
      ],
      email: [
        ['Read my emails?', 'Your connected email accounts show recent messages. Click any email to read the full content.'],
        ['Send an email?', 'If your account has send permissions, use the compose button to write and send emails through the AI.'],
      ],
      alarms: [
        ['Set an alarm?', 'Click "New Alarm", pick a time, add a label, and choose whether it repeats (daily, weekdays, custom days).'],
        ['Snooze or dismiss?', 'When an alarm fires, you\'ll see buttons to snooze (delays it) or dismiss (stops it).'],
      ],
      heartbeat: [
        ['Set up a heartbeat?', 'Write instructions in the editor — the AI reads and executes them every hour. Enable the toggle and click Save.'],
        ['Choose which model runs it?', 'Use the model dropdown above the editor to pick Default, Alt, or Fast for your heartbeat.'],
      ],
      talk: [
        ['Start a voice conversation?', 'Click the orb to begin speaking. Click again to stop and send. The AI will respond with text (and audio if "Read aloud" is on).'],
        ['Enable continuous mode?', 'Toggle "Conversation" mode so the AI listens again automatically after responding — hands-free back-and-forth.'],
      ],
    };
    var viewFaqs = faqs[view];
    if (viewFaqs && viewFaqs.length) {
      var faqHtml = '<div class="rsb-divider"></div><div class="rsb-section"><div class="rsb-section-title">How Do I...?</div>';
      for (var i = 0; i < viewFaqs.length; i++) {
        faqHtml += '<details class="rsb-faq"><summary class="rsb-faq-q">' + viewFaqs[i][0] + '</summary><div class="rsb-faq-a">' + viewFaqs[i][1] + '</div></details>';
      }
      faqHtml += '</div>';
      body.insertAdjacentHTML('beforeend', faqHtml);
    }
  }

  // --- Sidebar Timer & Time ---

  let sidebarTimerInterval = null;

  async function loadSidebarTimers() {
    const el = document.getElementById('rsbTimers');
    if (!el || !currentUser) return;
    try {
      const r = await fetch('/api/timers', { headers: { 'x-user-session': userSession() } });
      const d = await r.json();
      const timers = d.timers || [];
      if (timers.length === 0) {
        el.innerHTML = '<div class="rsb-hint">No active timers</div>';
        if (sidebarTimerInterval) { clearInterval(sidebarTimerInterval); sidebarTimerInterval = null; }
        return;
      }
      function renderTimers() {
        el.innerHTML = timers.map(function(t) {
          const elapsed = (Date.now() - new Date(t.started_at).getTime()) / 1000;
          const h = Math.floor(elapsed / 3600);
          const m = Math.floor((elapsed % 3600) / 60);
          const s = Math.floor(elapsed % 60);
          const timeStr = (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's';
          return '<div class="rsb-timer-row">'
            + '<div class="rsb-timer-info">'
            + '<div class="rsb-timer-project">' + esc(t.project_name || t.project_id) + '</div>'
            + '<div class="rsb-timer-desc">' + esc(t.description || 'No description') + '</div>'
            + '<div class="rsb-timer-elapsed">' + timeStr + '</div>'
            + '</div>'
            + '<div class="rsb-timer-actions">'
            + '<button class="btn btn-accent btn-sm" onclick="UserDash.stopTimerFromSidebar(\'' + escAttr(t.id) + '\',\'' + escAttr(t.project_id) + '\')" style="padding:3px 8px;font-size:.72rem">Stop</button>'
            + '<button class="btn btn-danger btn-sm" onclick="UserDash.cancelTimer(\'' + escAttr(t.id) + '\')" style="padding:3px 6px;font-size:.72rem">&times;</button>'
            + '</div></div>';
        }).join('');
      }
      renderTimers();
      if (sidebarTimerInterval) clearInterval(sidebarTimerInterval);
      sidebarTimerInterval = setInterval(renderTimers, 1000);
    } catch {
      el.innerHTML = '<div class="rsb-hint">Unable to load timers</div>';
    }
  }

  async function loadSidebarRecentTime() {
    const el = document.getElementById('rsbRecentTime');
    if (!el || !currentUser) return;
    // Aggregate recent time entries across all projects
    try {
      let allEntries = [];
      for (const p of projectsCache) {
        const r = await fetch('/api/projects/' + encodeURIComponent(p.id) + '/timesheet', { headers: { 'x-user-session': userSession() } });
        const d = await r.json();
        (d.entries || []).forEach(function(e) { e._projectName = p.name; });
        allEntries = allEntries.concat(d.entries || []);
      }
      allEntries.sort(function(a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });
      if (allEntries.length === 0) {
        el.innerHTML = '<div class="rsb-hint">No time logged yet</div>';
        return;
      }
      el.innerHTML = allEntries.slice(0, 5).map(function(e) {
        return '<div class="rsb-time-row">'
          + '<div class="rsb-time-info">'
          + '<span class="rsb-time-project">' + esc(e._projectName || '') + '</span>'
          + '<span class="rsb-time-desc">' + esc(e.description || '') + '</span>'
          + '</div>'
          + '<div class="rsb-time-meta">'
          + '<span class="rsb-time-hours">' + e.hours + 'h</span>'
          + '<span class="rsb-time-date">' + esc(e.date) + '</span>'
          + '</div>'
          + '</div>';
      }).join('');
    } catch {
      el.innerHTML = '<div class="rsb-hint">Unable to load time entries</div>';
    }
  }

  async function stopTimerFromSidebar(timerId, projectId) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(projectId) + '/timers/' + encodeURIComponent(timerId) + '/stop', { method: 'POST', headers: { 'x-user-session': userSession() } });
      toast('Timer stopped, time logged', 'success');
      loadSidebarTimers();
      loadSidebarRecentTime();
      if (currentProjectId) openProject(currentProjectId);
    } catch { toast('Failed to stop timer', 'error'); }
  }

  async function cancelTimer(timerId) {
    if (!confirm('Cancel timer without logging time?')) return;
    // Find project for this timer from cache
    try {
      const r = await fetch('/api/timers', { headers: { 'x-user-session': userSession() } });
      const d = await r.json();
      const timer = (d.timers || []).find(function(t) { return t.id === timerId; });
      if (timer) {
        await fetch('/api/projects/' + encodeURIComponent(timer.project_id) + '/timers/' + encodeURIComponent(timerId), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      }
      toast('Timer cancelled', 'info');
      loadSidebarTimers();
    } catch { toast('Failed', 'error'); }
  }

  async function startTimerForProject(projectId) {
    const desc = prompt('What are you working on?');
    if (desc === null) return;
    try {
      await fetch('/api/projects/' + encodeURIComponent(projectId) + '/timers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
        body: JSON.stringify({ description: desc })
      });
      toast('Timer started', 'success');
      loadSidebarTimers();
      if (currentProjectId) openProject(currentProjectId);
      updateRightSidebar('projects');
    } catch { toast('Failed to start timer', 'error'); }
  }

  // --- User Selection ---

  async function loadUserList() {
    try {
      const r = await fetch('/api/users');
      const d = await r.json();
      const grid = document.getElementById('userGrid');
      if (!d.users || d.users.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-tertiary)">No users configured. Visit the admin dashboard to create users.</p>';
        return;
      }
      grid.innerHTML = d.users.map(u => `
        <div onclick="UserDash.selectUser('${escAttr(u.id)}')" style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px 20px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;cursor:pointer;width:140px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <div style="width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:#fff;background:${esc(u.color || '#10b981')}">${esc(getInitials(u.name))}</div>
          <div style="font-size:0.95rem;font-weight:600;color:#1e293b;">${esc(u.name)}</div>
        </div>
      `).join('');
    } catch (e) {
      console.error('loadUserList error:', e);
      document.getElementById('userGrid').innerHTML = '<p style="color:var(--text-tertiary)">Failed to load users.</p>';
    }
  }

  async function selectUser(id) {
    try {
      const r = await fetch('/api/user');
      if (!r.ok) { localStorage.removeItem('dockbox-user-id'); loadUserList(); return; }
      const d = await r.json();
      if (!d.user) { localStorage.removeItem('dockbox-user-id'); loadUserList(); return; }

      pendingUser = d.user;

      if (!d.user.has_password) {
        // First login - get temp session, then force password setup
        const loginR = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({})
        });
        const loginD = await loginR.json();
        tempSession = loginD.session;
        showPasswordModal('setup');
      } else {
        showPasswordModal('login');
      }
    } catch (e) {
      console.error('selectUser error:', e);
      loadUserList();
    }
  }

  function showPasswordModal(mode) {
    passwordMode = mode;
    const modal = document.getElementById('passwordModal');
    modal.style.display = 'block';

    const title = document.getElementById('passwordModalTitle');
    const desc = document.getElementById('passwordModalDesc');
    const confirm = document.getElementById('passwordConfirm');
    const reqs = document.getElementById('passwordRequirements');
    const btn = document.getElementById('passwordSubmitBtn');
    const input = document.getElementById('passwordInput');
    const badge = document.getElementById('passwordUserBadge');

    document.getElementById('passwordError').textContent = '';
    input.value = '';

    // Show user badge
    if (pendingUser) {
      badge.innerHTML = '<span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:' +
        (pendingUser.color || '#6366f1') + ';color:#fff;line-height:40px;text-align:center;font-weight:700;font-size:1.1rem;">' +
        esc(pendingUser.name.charAt(0).toUpperCase()) + '</span><div style="margin-top:6px;font-weight:600;">' + esc(pendingUser.name) + '</div>';
    }

    if (mode === 'setup') {
      title.textContent = 'Create a Password';
      desc.textContent = 'Welcome! Please set a password to secure your account.';
      confirm.style.display = '';
      confirm.value = '';
      reqs.style.display = '';
      btn.textContent = 'Set Password';
      input.placeholder = 'New password';
      input.autocomplete = 'new-password';
    } else {
      title.textContent = 'Enter Password';
      desc.textContent = '';
      confirm.style.display = 'none';
      reqs.style.display = 'none';
      btn.textContent = 'Login';
      input.placeholder = 'Password';
      input.autocomplete = 'current-password';
    }

    setTimeout(() => input.focus(), 100);
  }

  function closePasswordModal() {
    document.getElementById('passwordModal').style.display = 'none';
    pendingUser = null;
    tempSession = null;
    passwordMode = null;
  }

  function validatePassword(pw) {
    if (pw.length < 6) return 'Must be at least 6 characters';
    if (!/[A-Z]/.test(pw)) return 'Must contain an uppercase letter';
    if (!/[0-9]/.test(pw)) return 'Must contain a number';
    if (!/[^A-Za-z0-9]/.test(pw)) return 'Must contain a special character';
    return null;
  }

  async function submitPassword() {
    const pw = document.getElementById('passwordInput').value;
    const errEl = document.getElementById('passwordError');
    errEl.textContent = '';

    if (passwordMode === 'setup') {
      const confirmPw = document.getElementById('passwordConfirm').value;
      const valErr = validatePassword(pw);
      if (valErr) { errEl.textContent = valErr; return; }
      if (pw !== confirmPw) { errEl.textContent = 'Passwords do not match'; return; }

      try {
        const r = await fetch('/api/set-password', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ password: pw, session: tempSession })
        });
        const d = await r.json();
        if (!r.ok) { errEl.textContent = d.error || 'Failed to set password'; return; }

        localStorage.setItem('dockbox-user-id', pendingUser.id);
        localStorage.setItem('dockbox-user-session', d.session);
        currentUser = pendingUser;
        closePasswordModal();
        enterDashboard();
      } catch (e) {
        errEl.textContent = 'Connection error';
      }
    } else {
      // Login mode
      if (!pw) { errEl.textContent = 'Please enter your password'; return; }

      try {
        const r = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ password: pw })
        });
        const d = await r.json();
        if (!r.ok) { errEl.textContent = d.error || 'Invalid password'; return; }

        localStorage.setItem('dockbox-user-id', pendingUser.id);
        localStorage.setItem('dockbox-user-session', d.session);
        currentUser = pendingUser;
        closePasswordModal();
        enterDashboard();
      } catch (e) {
        errEl.textContent = 'Connection error';
      }
    }
  }

  // --- Sidebar container status ---
  let sidebarStatusInterval = null;

  async function refreshSidebarStatus() {
    if (document.hidden) return; // paused while tab is hidden
    const el = document.getElementById('sidebarStatus');
    if (!el) return;
    if (!currentUser || !currentSession) { el.innerHTML = ''; return; }
    let g = null;
    try {
      const r = await cachedFetch('/api/status', null, 2000);
      if (!r.ok) return;
      const d = await r.json();
      g = (d.groups || []).find(x => x.jid === currentSession) || null;
    } catch { return; }
    const name = g ? g.name : (groupsMap[currentSession]?.name || currentSession);
    let cls, label;
    if (g && g.active && !g.idle) { cls = 'running'; label = 'Running'; }
    else if (g && g.active && g.idle) { cls = 'idle'; label = 'Idle'; }
    else { cls = 'stopped'; label = 'Stopped'; }
    // Live verbose label from the agent-runner child — shows what Warden is
    // doing right now (council round, sub-agent, tool, etc.).
    const liveLabel = (g && g.liveLabel) ? g.liveLabel : '';
    const liveTools = (g && g.liveTools && g.liveTools.length) ? g.liveTools : [];
    const tipParts = [name + ': ' + label];
    if (liveLabel) tipParts.push(liveLabel);
    if (liveTools.length) tipParts.push('tools: ' + liveTools.join(', '));
    const tip = esc(tipParts.join(' · '));
    const labelHtml = liveLabel
      ? '<div class="sidebar-status-label" style="font-size:.7rem;color:var(--text-tertiary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">' + esc(liveLabel) + '</div>'
      : '';
    el.innerHTML = '<button class="sidebar-status-item" data-tooltip="' + tip + '" '
      + 'onclick="UserDash.navigateTo(\'chat\')" style="text-align:left">'
      + '<span class="sidebar-status-dot ' + cls + '"></span>'
      + labelHtml
      + '</button>';
    // Poll faster when something is actively running so the user can watch
    // progress in real-time (council rounds, sub-agents, etc.).
    if (g && g.active && !g.idle && liveLabel) {
      if (sidebarStatusInterval) clearInterval(sidebarStatusInterval);
      sidebarStatusInterval = setInterval(refreshSidebarStatus, 2500);
    } else if (g && g.active && !g.idle) {
      if (sidebarStatusInterval) clearInterval(sidebarStatusInterval);
      sidebarStatusInterval = setInterval(refreshSidebarStatus, 5000);
    } else {
      if (sidebarStatusInterval) clearInterval(sidebarStatusInterval);
      sidebarStatusInterval = setInterval(refreshSidebarStatus, 10000);
    }
  }

  function startSidebarStatusPoll() {
    if (sidebarStatusInterval) clearInterval(sidebarStatusInterval);
    refreshSidebarStatus();
    sidebarStatusInterval = setInterval(refreshSidebarStatus, 10000);
  }

  // Verbose bar: shows the live agent-runner status label at the bottom of
  // the chat view so the user can see "The Council: round 2 of 4..." while
  // deliberation is happening. Polls /api/status every 2s while active.
  let verboseBarInterval = null;
  function updateVerboseBar() {
    const bar = document.getElementById('verboseBar');
    const content = document.getElementById('verboseContent');
    if (!bar || !content) return;
    fetch('/api/status').then(r => r.json()).then(d => {
      const g = (d.groups || []).find(x => x.jid === currentSession);
      const label = g && g.liveLabel ? g.liveLabel : '';
      const tools = g && g.liveTools && g.liveTools.length ? g.liveTools : [];
      const active = g && g.active && !g.idle;
      if (label && active) {
        const parts = [label];
        if (tools.length) parts.push('[' + tools.join(', ') + ']');
        content.textContent = parts.join(' · ');
        bar.style.display = 'block';
      } else {
        bar.style.display = 'none';
        content.textContent = '';
      }
      // Tighter poll when active so live updates flow fast
      if (verboseBarInterval) clearInterval(verboseBarInterval);
      verboseBarInterval = setInterval(updateVerboseBar, active ? 2000 : 8000);
    }).catch(() => {});
  }
  function startVerboseBarPoll() {
    if (verboseBarInterval) clearInterval(verboseBarInterval);
    updateVerboseBar();
    verboseBarInterval = setInterval(updateVerboseBar, 4000);
  }

  function stopSidebarStatusPoll() {
    if (sidebarStatusInterval) { clearInterval(sidebarStatusInterval); sidebarStatusInterval = null; }
  }

  async function enterDashboard() {
    const uss = document.getElementById('userSelectScreen');
    if (uss) uss.classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Render sidebar nav FIRST — before any async network calls that could
    // throw and leave the menu empty. This guarantees the user sees the nav
    // even if /api/status, /api/groups, etc. fail.
    try { renderSidebarNav(); } catch (e) { console.error('renderSidebarNav:', e); }

    // Topbar user display
    const topbar = document.getElementById('topbarUser');
    topbar.innerHTML = `
      <div class="user-avatar-sm" style="background:${esc(currentUser.color || '#10b981')}">${esc(getInitials(currentUser.name))}</div>
      <span class="topbar-username">${esc(currentUser.name)}</span>
      <span class="topbar-userid">${esc(currentUser.id)}</span>
    `;

    // Fetch assistant name and Ollama state
    try {
      const r = await cachedFetch('/api/status', null, 2000);
      const d = await r.json();
      if (d.assistant) assistantName = d.assistant;
      if (d.localAssistant) localAssistantName = d.localAssistant;
      await refreshModelDropdowns();
    } catch {}

    // Fetch groups for JID→name mapping
    try {
      const r = await cachedFetch('/api/groups', null, 5000);
      const d = await r.json();
      groupsMap = {};
      (d.groups || []).forEach(g => { groupsMap[g.jid] = g; });
    } catch {}

    // Populate session selects
    populateSessionSelects();

    // Start SSE
    connectSSE();
    startNotifListPolling();

    // Projects loaded on navigateTo
    startUnreadPolling();

    // Sidebar container status (per allowed session)
    startSidebarStatusPoll();
    startVerboseBarPoll();

    // Restore thinking indicator if the current session's container is running
    syncTypingIndicatorForSession();
    // Poll for thinking/activity state every 3s — catches other users' messages and tab switches
    setInterval(syncTypingIndicatorForSession, 3000);

    // Render sidebar nav (pinned + shelf)
    renderSidebarNav();

    // Navigate to saved or default view (chat is more useful than home for a single-user Warden)
    navigateTo(localStorage.getItem('dockbox-user-view') || 'chat');

    // Auto-show setup wizard if workspace hasn't been set up
    try {
      const gFolder = groupsMap[currentSession]?.folder;
      if (gFolder) {
        const r = await fetch(fileUrl('/api/files/stat?path=' + encodeURIComponent(gFolder + '/.setup_complete')));
        if (r.status === 404) {
          setTimeout(() => openSetupWizard(), 500);
        }
      }
    } catch {}

  }

  function switchUser() {
    // Logout session on server
    const session = localStorage.getItem('dockbox-user-session');
    const userId = localStorage.getItem('dockbox-user-id');
    if (session && userId) {
      fetch('/api/logout', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ session })
      }).catch(() => {});
    }
    // Tear down
    if (chatInterval) { clearInterval(chatInterval); chatInterval = null; }
    if (sseSource) { sseSource.close(); sseSource = null; }
    // project polling removed
    stopUnreadPolling();
    stopSidebarStatusPoll();
    currentUser = null;
    currentSession = '';
    chatLastTimestamp = '';
    knownMsgIds.clear();
    notifCount = 0;
    updateNotifBadge();
    localStorage.removeItem('dockbox-user-id');
    localStorage.removeItem('dockbox-user-session');

    window.location.href = '/login';
  }

  function sessionName(jid) {
    const g = groupsMap[jid];
    const name = g ? g.name : jid;
    let prefix = '';
    if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) prefix = '\uD83D\uDFE2 ';
    else if (jid.startsWith('tg:') || jid.startsWith('telegram:')) prefix = '\uD83D\uDD35 ';
    else if (jid.startsWith('slack:')) prefix = '\uD83D\uDD34 ';
    // For web groups, check if a channel is linked (same folder)
    if (jid.startsWith('web:') && g?.folder) {
      const linked = Object.entries(groupsMap).find(([k, v]) =>
        k !== jid && !k.startsWith('web:') && !k.startsWith('system:') && v.folder === g.folder
      );
      if (linked) {
        const lk = linked[0];
        if (lk.includes('@g.us') || lk.includes('@s.whatsapp')) prefix = '\uD83D\uDFE2 ';
        else if (lk.startsWith('tg:')) prefix = '\uD83D\uDD35 ';
        else if (lk.startsWith('slack:')) prefix = '\uD83D\uDD34 ';
      }
    }
    const suffix = (currentUser && currentUser.home_group === jid) ? ' (Home)' : '';
    return prefix + name + suffix;
  }

  function populateSessionSelects() {
    // Single-user Warden: always owner@local.
    const sessions = currentUser?.allowed_sessions?.length ? currentUser.allowed_sessions : ['owner@local'];
    const optionsHtml = sessions.map(s => `<option value="${escAttr(s)}">${esc(sessionName(s))}</option>`).join('');

    const homeGroup = currentUser?.home_group;
    currentSession = (homeGroup && sessions.includes(homeGroup)) ? homeGroup : (sessions[0] || 'owner@local');
  }


  // --- Logs (chat history browser) ---

  var logsCache = {};          // jid → { messages, hasMore, oldestTimestamp, loading }
  var logsCurrentJid = '';

  function loadLogs() {
    if (!currentUser) return;
    var sessions = currentUser.allowed_sessions || [];
    var sel = document.getElementById('logsSessionSelect');
    if (!sel) return;

    var opts = sessions.map(function(s) {
      return '<option value="' + escAttr(s) + '">' + esc(sessionName(s)) + '</option>';
    }).join('');
    sel.innerHTML = opts || '<option value="">No sessions available</option>';

    var defaultJid = (currentSession && sessions.indexOf(currentSession) !== -1) ? currentSession : (sessions[0] || '');
    sel.value = defaultJid;

    sel.onchange = function() { loadLogHistory(sel.value); };

    var searchEl = document.getElementById('logsSearch');
    if (searchEl) {
      var debTimer;
      searchEl.oninput = function() {
        clearTimeout(debTimer);
        debTimer = setTimeout(function() { doLogSearch(logsCurrentJid); }, 200);
      };
    }

    if (defaultJid) loadLogHistory(defaultJid);
  }

  async function loadLogHistory(jid) {
    if (!jid) return;
    logsCurrentJid = jid;

    var listEl = document.getElementById('logsList');
    var countEl = document.getElementById('logsCount');
    if (!listEl) return;

    // If cached, just render
    if (logsCache[jid]) {
      renderLogRows(jid);
      listEl.scrollTop = listEl.scrollHeight;
      return;
    }

    listEl.innerHTML = '<div class="logs-loading">Loading history<span class="logs-loading-dots"></span></div>';
    if (countEl) countEl.textContent = '';

    try {
      var url = '/api/messages?jid=' + encodeURIComponent(jid) + '&limit=200';
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var msgs = (d && d.messages) ? d.messages : [];

      logsCache[jid] = {
        messages: msgs,
        hasMore: msgs.length === 200,
        oldestTimestamp: msgs.length > 0 ? msgs[0].timestamp : '',
        loading: false
      };
    } catch (e) {
      console.error('loadLogHistory error:', e);
      listEl.innerHTML = '<div class="logs-empty">Failed to load history.</div>';
      return;
    }

    renderLogRows(jid);
    listEl.scrollTop = listEl.scrollHeight;

    // Attach scroll listener for loading older messages
    listEl.onscroll = function() {
      if (logsCurrentJid !== jid) return;
      var cache = logsCache[jid];
      if (!cache || cache.loading || !cache.hasMore) return;
      if (listEl.scrollTop < 100) loadOlderLogs(jid);
    };
  }

  async function loadOlderLogs(jid) {
    var cache = logsCache[jid];
    if (!cache || cache.loading || !cache.hasMore || !cache.oldestTimestamp) return;
    cache.loading = true;

    var listEl = document.getElementById('logsList');
    var prevHeight = listEl ? listEl.scrollHeight : 0;

    try {
      var url = '/api/messages?jid=' + encodeURIComponent(jid) + '&limit=200&before=' + encodeURIComponent(cache.oldestTimestamp);
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var msgs = (d && d.messages) ? d.messages : [];

      if (msgs.length === 0) {
        cache.hasMore = false;
        cache.loading = false;
        return;
      }

      cache.messages = msgs.concat(cache.messages);
      cache.oldestTimestamp = msgs[0].timestamp;
      if (msgs.length < 200) cache.hasMore = false;

      if (jid === logsCurrentJid) {
        renderLogRows(jid);
        if (listEl) listEl.scrollTop = listEl.scrollHeight - prevHeight;
      }
    } catch (e) {
      console.error('loadOlderLogs error:', e);
    }
    cache.loading = false;
  }

  async function loadAllRemainingLogs(jid) {
    var cache = logsCache[jid];
    if (!cache || cache.loading || !cache.hasMore) return;
    cache.loading = true;

    var listEl = document.getElementById('logsList');
    var countEl = document.getElementById('logsCount');
    if (countEl) countEl.textContent = 'Loading all messages for search...';

    var MAX_PAGES = 50;
    var page = 0;
    try {
      while (cache.hasMore && page < MAX_PAGES) {
        var url = '/api/messages?jid=' + encodeURIComponent(jid) + '&limit=200&before=' + encodeURIComponent(cache.oldestTimestamp);
        var r = await fetch(url);
        if (!r.ok) break;
        var d = await r.json();
        var msgs = (d && d.messages) ? d.messages : [];
        if (msgs.length === 0) { cache.hasMore = false; break; }
        cache.messages = msgs.concat(cache.messages);
        cache.oldestTimestamp = msgs[0].timestamp;
        if (msgs.length < 200) cache.hasMore = false;
        page++;
      }
    } catch (e) {
      console.error('loadAllRemainingLogs error:', e);
    }
    cache.loading = false;
  }

  async function doLogSearch(jid) {
    var searchEl = document.getElementById('logsSearch');
    var query = searchEl ? searchEl.value.trim() : '';
    var cache = logsCache[jid];
    if (!cache) return;

    // If searching and there are more messages to load, load them all first
    if (query && cache.hasMore) {
      await loadAllRemainingLogs(jid);
    }
    renderLogRows(jid);
  }

  function renderLogRows(jid) {
    var cached = logsCache[jid];
    var listEl = document.getElementById('logsList');
    var countEl = document.getElementById('logsCount');
    var searchEl = document.getElementById('logsSearch');
    if (!listEl || !cached) return;

    var query = (searchEl ? searchEl.value.trim().toLowerCase() : '');
    var msgs = cached.messages;

    var filtered = query
      ? msgs.filter(function(m) {
          return (m.content || '').toLowerCase().indexOf(query) !== -1
            || (m.sender_name || '').toLowerCase().indexOf(query) !== -1;
        })
      : msgs;

    var total = msgs.length;
    var shown = filtered.length;

    if (countEl) {
      var label = query
        ? shown.toLocaleString() + ' of ' + total.toLocaleString() + ' messages'
        : total.toLocaleString() + ' messages' + (cached.hasMore ? ' (scroll up for more)' : '');
      countEl.textContent = label;
    }

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="logs-empty">' + (query ? 'No results for &ldquo;' + esc(query) + '&rdquo;' : 'No messages in this session.') + '</div>';
      return;
    }

    var html = filtered.map(function(m) {
      var isSent = !m.is_bot_message;
      var timeStr = m.timestamp ? new Date(m.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      var sender = esc(m.sender_name || (isSent ? 'You' : 'Bot'));
      var content = esc((m.content || '').slice(0, 800));
      if ((m.content || '').length > 800) content += '<span class="logs-truncated"> &hellip;</span>';
      if (query) {
        var re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        content = content.replace(re, '<mark class="logs-highlight">$1</mark>');
        sender = sender.replace(re, '<mark class="logs-highlight">$1</mark>');
      }
      return '<div class="logs-row ' + (isSent ? 'logs-row--sent' : 'logs-row--received') + '">'
        + '<div class="logs-row-meta"><span class="logs-sender">' + sender + '</span><span class="logs-time">' + esc(timeStr) + '</span></div>'
        + '<div class="logs-row-content">' + content + '</div>'
        + '</div>';
    }).join('');

    listEl.innerHTML = html;
  }

  // --- Chat ---

  let initialChatLoad = false;
  async function loadChat() {
    chatLastTimestamp = '';
    knownMsgIds.clear();
    chatPolling = false; // Reset so pollChat won't skip
    initialChatLoad = true;

    // Skeleton while the first poll is in flight; replaced by messages or the empty state
    document.getElementById('chatMessages').innerHTML =
      '<div id="chatEmptyState" class="chat-skeleton">' + skeletonHtml(5) + '</div>';
    await pollChat();
    initialChatLoad = false;
    if (knownMsgIds.size === 0) {
      const ph = document.getElementById('chatEmptyState');
      if (ph) ph.outerHTML = `
        <div class="chat-empty-state" id="chatEmptyState">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:48px;height:48px;opacity:0.4"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          <p class="empty-title">No messages yet</p>
          <p class="empty-desc">Start a conversation with your assistant.</p>
        </div>`;
    }
    if (!chatInterval) chatInterval = setInterval(pollChat, 3000);
    // Scroll to bottom and focus input
    const chatEl = document.getElementById('chatMessages');
    chatEl.scrollTop = chatEl.scrollHeight;
    document.getElementById('chatInput').focus();
    // Show typing indicator if container is already running
    syncTypingIndicatorForSession();
    // Update trigger toggle for current session
    updateTriggerToggle();
  }

  function updateTriggerToggle() {}

  // Exponential backoff on consecutive poll errors (resets on success, max 30s)
  let chatErrorStreak = 0;
  let chatBackoffUntil = 0;

  async function pollChat() {
    if (document.hidden) return; // paused while tab is hidden
    if (currentView !== 'chat' || chatPolling || !currentSession) return;
    if (Date.now() < chatBackoffUntil) return;
    chatPolling = true;
    try {
      const r = await fetch('/api/messages?jid=' + encodeURIComponent(currentSession) + '&since=' + encodeURIComponent(chatLastTimestamp) + '&limit=100&idea=' + encodeURIComponent(currentIdea));
      const d = await r.json();
      if (d.messages && d.messages.length > 0) {
        const el = document.getElementById('chatMessages');
        const emptyState = document.getElementById('chatEmptyState');
        if (emptyState) emptyState.remove();
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        d.messages.filter(m => !knownMsgIds.has(m.id)).forEach(m => {
          knownMsgIds.add(m.id);
          if (m.is_bot_message && waitingForReply && !initialChatLoad) {
            hideTypingIndicator();
            document.querySelectorAll('.msg.msg-processing').forEach(el => el.classList.remove('msg-processing'));
          }
          if (m.is_bot_message && document.hidden) {
            showNotification({ type: 'chat_complete', message: (m.content || '').slice(0, 120) });
          }
          const isSent = !m.is_bot_message;
          // Reconcile optimistic pending messages: the server copy replaces the placeholder
          if (isSent && pendingMsgs.length) {
            const norm = (m.content || '').trim();
            const pIdx = pendingMsgs.findIndex(p => p.text === norm);
            if (pIdx !== -1) {
              pendingMsgs[pIdx].el.remove();
              pendingMsgs.splice(pIdx, 1);
            }
          }
          const div = document.createElement('div');
          div.className = 'msg ' + (isSent ? 'sent' : 'received') + botModelClass(m) + (isSent && waitingForReply ? ' msg-processing' : '');
          const time = formatMsgTime(m.timestamp);
          const sender = m.is_bot_message ? (m.sender_name || '') : (m.sender_name || m.sender);
          const gFolder = groupsMap[currentSession]?.folder || '';
          let content = renderMarkdown(m.content);
          content = renderAttachments(content, gFolder);
          const speakBtn = m.is_bot_message ? `<button class="msg-speak-btn" onclick="UserDash.speakMessage(this)" data-text="${escAttr(m.content)}" title="Read aloud"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg></button>` : '';
          const nameColor = isSent ? '#fff' : senderColor(sender);
          const senderHtml = sender ? `<span style="color:${nameColor};font-weight:600">${esc(sender)}</span> &middot; ` : '';
          div.innerHTML = `<div class="msg-text">${content}</div><div class="msg-meta">${senderHtml}${time}${speakBtn}</div>`;
          el.appendChild(div);
        });
        chatLastTimestamp = d.messages[d.messages.length - 1].timestamp;
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
      chatErrorStreak = 0;
      chatBackoffUntil = 0;
    } catch (e) {
      console.error('pollChat error:', e);
      chatErrorStreak++;
      chatBackoffUntil = Date.now() + Math.min(3000 * Math.pow(2, chatErrorStreak - 1), 30000);
    }
    chatPolling = false;
  }

  let waitingForReply = false;
  let statusPollInterval = null;

  // Thinking bar management
  var thinkingWords = [];
  function addThinkingLine(text, type = 'text') {
    const bar = document.getElementById('thinkingBar');
    const content = document.getElementById('thinkingContent');
    if (!bar || !content) return;
    bar.style.display = '';
    bar.classList.add('has-content');
    var words = text.split(/\s+/).filter(function(w) { return w; });
    for (var i = 0; i < words.length; i++) thinkingWords.push(words[i]);
    while (thinkingWords.length > 50) thinkingWords.shift();
    content.textContent = thinkingWords.join(' ');
    bar.scrollLeft = bar.scrollWidth;
  }

  function clearThinkingBar() {
    const bar = document.getElementById('thinkingBar');
    const content = document.getElementById('thinkingContent');
    if (bar) {
      bar.style.display = 'none';
      bar.classList.remove('has-content');
    }
    if (content) content.innerHTML = '';
    thinkingWords.length = 0;
  }

  function showTypingIndicator() {
    let el = document.getElementById('typingIndicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'typingIndicator';
      el.className = 'typing-bar';
      const inputArea = document.querySelector('.chat-input-area');
      inputArea.parentNode.insertBefore(el, inputArea);
      el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div><div class="typing-status" id="typingStatusText">Queued</div><button class="typing-stop-btn" onclick="UserDash.stopProcessing()" title="Stop processing">End</button>';
    }
    el.classList.remove('hidden');
    var stopBtn = el.querySelector('.typing-stop-btn');
    if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = 'End'; }
    waitingForReply = true;
    startStatusPoll();
  }

  function startStatusPoll() {
    if (statusPollInterval) clearInterval(statusPollInterval);
    let sawActive = false;
    let lastLogIndex = 0; // track how far we've consumed the activity log
    statusPollInterval = setInterval(async () => {
      if (document.hidden) return; // paused while tab is hidden
      if (!waitingForReply) { clearInterval(statusPollInterval); statusPollInterval = null; return; }
      try {
        const r = await cachedFetch('/api/groups', { headers: { 'X-User-Session': userSession() } }, 1500);
        const d = await r.json();
        const g = (d.groups || []).find(g => g.jid === currentSession);
        const statusEl = document.getElementById('typingStatusText');
        if (!statusEl) return;
        if (g && g.active && !g.idle) {
          sawActive = true;
          const total = 1 + (g.parallelContainers || 0);
          const countLabel = total > 1 ? ` (${total} agents)` : '';
          // Drain all new entries from the activity log
          var log = g.activityLog || [];
          // Update thinking bar from accumulated thinking content — last 50 words
          if (g.thinking) {
            var allWords = g.thinking.split(/\s+/).filter(function(w) { return w; });
            thinkingWords = allWords.slice(-50);
            var bar = document.getElementById('thinkingBar');
            var content = document.getElementById('thinkingContent');
            if (bar && content) {
              content.textContent = thinkingWords.join(' ');
              bar.style.display = '';
              bar.classList.add('has-content');
              bar.scrollLeft = bar.scrollWidth;
            }
          }
          // Only set status from polling if SSE hasn't streamed any words yet
          if (thinkingWords.length === 0) {
            if (g.activity && g.activity.phase === 'private_agent') {
              statusEl.textContent = '\u{1F512} ' + (g.activity.label || 'Running locally') + countLabel;
            } else if (g.activity && g.activity.label) {
              statusEl.textContent = g.activity.label + countLabel;
            } else if (g.activity && g.activity.phase === 'rate_limited') {
              statusEl.textContent = 'Waiting (rate limited)...' + countLabel;
            } else {
              statusEl.textContent = 'Thinking...' + countLabel;
            }
          }
        } else if (g && g.active && g.idle && sawActive) {
          hideTypingIndicator();
          pollChat();
        } else if (!g || !g.active) {
          if (sawActive) {
            hideTypingIndicator();
            pollChat();
          }
        }
      } catch {}
    }, 1200);
  }

  function hideTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.classList.add('hidden');
    const statusEl = document.getElementById('typingStatusText');
    if (statusEl) delete statusEl.dataset.sseUpdated;
    waitingForReply = false;
    hideSuppressUntil = Date.now() + 8000; // don't re-show for 8s after response arrives
    document.querySelectorAll('.msg.msg-processing').forEach(e => e.classList.remove('msg-processing'));
    if (statusPollInterval) { clearInterval(statusPollInterval); statusPollInterval = null; }
    clearThinkingBar();
  }

  // Ensure the typing indicator reflects the current container state for
  // currentSession. Safe to call on tab switch, chat switch, or after refresh.
  async function syncTypingIndicatorForSession() {
    if (document.hidden) return; // paused while tab is hidden
    if (!currentSession) return;
    if (Date.now() < stopSuppressUntil) return; // user just hit End — ignore the dying container
    if (Date.now() < hideSuppressUntil) return; // response just arrived — don't re-show indicator
    try {
      const r = await cachedFetch('/api/groups', { headers: { 'X-User-Session': userSession() } }, 1500);
      const d = await r.json();
      const allGroups = d.groups || [];
      let g = allGroups.find(g => g.jid === currentSession);
      // If current session isn't active, check linked groups (same folder) for activity
      if (g && !g.active && g.folder) {
        const linked = allGroups.find(lg => lg.folder === g.folder && lg.active && !lg.idle);
        if (linked) g = { ...g, active: true, idle: false, thinking: linked.thinking, activity: linked.activity, activityLog: linked.activityLog };
      }
      if (g && g.active && !g.idle) {
        // Show typing indicator even if we didn't send the message
        showTypingIndicator();
        // Restore thinking bar from server state
        if (g.thinking) {
          var allWords = g.thinking.split(/\s+/).filter(function(w) { return w; });
          thinkingWords = allWords.slice(-50);
          var bar = document.getElementById('thinkingBar');
          var content = document.getElementById('thinkingContent');
          if (bar && content) {
            content.textContent = thinkingWords.join(' ');
            bar.style.display = '';
            bar.classList.add('has-content');
            bar.scrollLeft = bar.scrollWidth;
          }
        }
        if (g.activity && g.activity.label) {
          var statusEl = document.getElementById('typingStatusText');
          if (statusEl) {
            if (g.activity.phase === 'private_agent') {
              statusEl.textContent = '\u{1F512} ' + g.activity.label;
            } else {
              statusEl.textContent = g.activity.label;
            }
          }
        }
      } else if (waitingForReply) {
        const el = document.getElementById('typingIndicator');
        if (el) el.classList.remove('hidden');
        if (!statusPollInterval) startStatusPoll();
      }
    } catch {
      if (waitingForReply) {
        const el = document.getElementById('typingIndicator');
        if (el) el.classList.remove('hidden');
        if (!statusPollInterval) startStatusPoll();
      }
    }
  }

  let keepAliveEnabled = localStorage.getItem('dockbox-keepalive') === '1';

  function toggleKeepAlive() {
    keepAliveEnabled = !keepAliveEnabled;
    localStorage.setItem('dockbox-keepalive', keepAliveEnabled ? '1' : '0');
    const btn = document.getElementById('btnKeepAlive');
    const label = document.getElementById('keepAliveLabel');
    if (btn) btn.classList.toggle('active', keepAliveEnabled);
    if (label) label.textContent = keepAliveEnabled ? 'Alive' : 'Keep Alive';
    if (keepAliveEnabled) {
      toast('Container will stay alive', 'success');
      startKeepAlivePing();
    } else {
      toast('Keep alive disabled', 'info');
      stopKeepAlivePing();
    }
  }

  let keepAlivePingTimer = null;
  function startKeepAlivePing() {
    stopKeepAlivePing();
    if (!keepAliveEnabled || !currentSession) return;
    const folder = groupsMap[currentSession]?.folder;
    if (!folder) return;
    keepAlivePingTimer = setInterval(() => {
      if (!keepAliveEnabled) { stopKeepAlivePing(); return; }
      fetch('/api/groups/' + encodeURIComponent(folder) + '/keepalive', {
        method: 'POST',
        headers: { 'X-User-Session': userSession() }
      }).catch(() => {});
    }, 20000); // ping every 20s
  }
  function stopKeepAlivePing() {
    if (keepAlivePingTimer) { clearInterval(keepAlivePingTimer); keepAlivePingTimer = null; }
  }

  // After the user hits End, the dying container can stay "active" for several
  // seconds while docker tears it down. Suppress the typing-indicator resync in
  // that window so a zombie indicator doesn't reappear and invite repeat End
  // clicks (which would kill the NEXT freshly-spawned container).
  let stopSuppressUntil = 0;
  let hideSuppressUntil = 0; // after receiving a response, prevent sync from re-showing indicator

  async function stopProcessing() {
    if (!currentSession) return;
    var stopBtn = document.querySelector('#typingIndicator .typing-stop-btn');
    if (stopBtn) { if (stopBtn.disabled) return; stopBtn.disabled = true; stopBtn.textContent = 'Stopping...'; }
    stopSuppressUntil = Date.now() + 10000;
    if (keepAliveEnabled) {
      // Keep alive mode: just write _close sentinel to stop processing, don't kill container
      try {
        await fetch('/api/chat/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({ jid: currentSession, soft: true })
        });
      } catch {}
      hideTypingIndicator();
      toast('Processing stopped (container kept alive)', 'info');
      return;
    }
    try {
      await fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
        body: JSON.stringify({ jid: currentSession })
      });
    } catch {}
    hideTypingIndicator();
    toast('Processing stopped', 'info');
  }

  // --- Optimistic send: message appears instantly, reconciled by pollChat ---
  let pendingMsgs = []; // [{ el, text }]

  function appendOptimisticMsg(text) {
    const el = document.getElementById('chatMessages');
    if (!el) return null;
    const emptyState = document.getElementById('chatEmptyState');
    if (emptyState) emptyState.remove();
    const div = document.createElement('div');
    div.className = 'msg sent msg-pending';
    const sender = currentUser?.name || 'User';
    div.innerHTML = '<div class="msg-text">' + renderMarkdown(text) + '</div>'
      + '<div class="msg-meta"><span style="color:#fff;font-weight:600">' + esc(sender) + '</span> &middot; <span class="msg-pending-label">Sending\u2026</span></div>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    return div;
  }

  function markMsgFailed(el, text) {
    if (!el) return;
    pendingMsgs = pendingMsgs.filter(p => p.el !== el);
    el.classList.remove('msg-pending');
    el.classList.add('msg-failed');
    const meta = el.querySelector('.msg-meta');
    if (meta) meta.innerHTML = '<span class="msg-failed-label">Not sent</span> <button class="msg-retry-btn" aria-label="Retry sending message">Retry</button>';
    const btn = el.querySelector('.msg-retry-btn');
    if (btn) btn.addEventListener('click', function() { el.remove(); sendChatText(text); });
  }

  async function sendChat() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !currentSession) return;
    input.value = '';
    input.style.height = 'auto';
    await sendChatText(text);
  }

  async function sendChatText(text) {
    if (!text || !currentSession) return;

    const modelSelect = document.getElementById('modelSelect');
    const model = modelSelect ? modelSelect.value : '';
    const thinkingSelect = document.getElementById('thinkingSelect');
    const thinking = thinkingSelect ? thinkingSelect.value : '';

    const pendingEl = appendOptimisticMsg(text);
    if (pendingEl) pendingMsgs.push({ el: pendingEl, text: text });

    try {
      const payload = { text: text, jid: currentSession, sender_name: currentUser?.name || 'User' };
      if (currentIdea) payload.idea = currentIdea;
      if (model) payload.model = model;
      if (thinking) payload.thinking = thinking;
      const r = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      stopSuppressUntil = 0; // new message sent — indicator is legitimate again
      showTypingIndicator();
      await pollChat();
    } catch (e) {
      markMsgFailed(pendingEl, text);
      toast('Failed to send message' + (e && e.message ? ' (' + e.message + ')' : ''), 'error');
    }
  }

  // --- Voice ---

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;

  function showVoiceStatus(text) {
    const el = document.getElementById('voiceStatus');
    const textEl = document.getElementById('voiceStatusText');
    textEl.textContent = text || 'Listening...';
    el.classList.remove('hidden');
  }

  function hideVoiceStatus() {
    document.getElementById('voiceStatus').classList.add('hidden');
  }

  let voiceSilenceTimer = null;
  let voiceFinalText = '';
  let conversationMode = false;
  let conversationWaitingForBot = false;

  function startRecording() {
    if (isRecording || !currentSession) return;
    if (!SpeechRecognition) { toast('Speech recognition not supported in this browser', 'error'); return; }
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;
    voiceFinalText = '';
    const input = document.getElementById('chatInput');
    input.value = '';
    showVoiceStatus('Listening...');
    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      voiceFinalText = final;
      const current = (final + interim).trim();
      input.value = current;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      showVoiceStatus(current ? current : 'Listening...');
      // Check for exit keywords in conversation mode.
      // Only check the FINAL transcript — interim results can briefly equal
      // "stop" exactly while the user is mid-phrase saying "stop doing X",
      // which would exit conversation mode prematurely. The check is exact
      // match (===), so a prompt that merely *contains* "stop" never matches.
      if (conversationMode && final) {
        const lower = final.toLowerCase().trim();
        if (lower === 'stop' || lower === 'goodbye' || lower === 'bye' || lower === 'end conversation' || lower === 'stop listening') {
          clearTimeout(voiceSilenceTimer);
          recognition.stop();
          isRecording = false;
          document.getElementById('voiceBtn').classList.remove('recording');
          document.getElementById('chatInput').value = '';
          exitConversationMode();
          return;
        }
      }
      // Reset silence timer — user is still speaking
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = setTimeout(() => {
        // Silence detected — auto-send
        if (isRecording) stopRecording();
      }, 1800);
    };
    recognition.onerror = (e) => {
      console.error('Speech recognition error:', e.error);
      clearTimeout(voiceSilenceTimer);
      if (e.error !== 'aborted') toast('Voice error: ' + e.error, 'error');
      isRecording = false;
      document.getElementById('voiceBtn').classList.remove('recording');
      if (conversationMode && e.error === 'no-speech') {
        // In conversation mode, retry listening on no-speech
        showVoiceStatus('Listening...');
        setTimeout(() => { if (conversationMode) startRecording(); }, 500);
      } else {
        hideVoiceStatus();
        if (conversationMode && e.error !== 'aborted') exitConversationMode();
      }
    };
    recognition.onend = () => {
      clearTimeout(voiceSilenceTimer);
      // If still marked as recording, the browser stopped on its own (silence/timeout)
      // Auto-send whatever we have
      if (isRecording) {
        isRecording = false;
        document.getElementById('voiceBtn').classList.remove('recording');
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (text) {
          if (!conversationMode) hideVoiceStatus();
          document.getElementById('voiceBtn').classList.add('processing');
          sendVoiceText(text).then(() => {
            input.value = '';
            input.style.height = 'auto';
            document.getElementById('voiceBtn').classList.remove('processing');
          });
        } else if (!conversationMode) {
          hideVoiceStatus();
        } else {
          // In conversation mode but no text — listen again
          setTimeout(() => { if (conversationMode) startRecording(); }, 500);
        }
      }
    };
    recognition.start();
    isRecording = true;
    document.getElementById('voiceBtn').classList.add('recording');
  }

  function stopRecording() {
    if (!isRecording || !recognition) return;
    clearTimeout(voiceSilenceTimer);
    recognition.stop();
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');
    // Send whatever was transcribed
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (text) {
      if (!conversationMode) hideVoiceStatus();
      document.getElementById('voiceBtn').classList.add('processing');
      sendVoiceText(text).then(() => {
        input.value = '';
        input.style.height = 'auto';
        document.getElementById('voiceBtn').classList.remove('processing');
      });
    } else {
      hideVoiceStatus();
    }
  }

  function toggleRecording() {
    if (conversationMode) {
      // Exit conversation mode
      exitConversationMode();
      return;
    }
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function enterConversationMode() {
    conversationMode = true;
    const btn = document.getElementById('voiceBtn');
    btn.classList.add('conversation-mode');
    btn.title = 'Tap to end conversation';
    showVoiceStatus('Conversation mode — listening...');
    toast('Conversation mode started', 'info', 2000);
    startRecording();
  }

  function exitConversationMode() {
    conversationMode = false;
    conversationWaitingForBot = false;
    speechSynthesis.cancel();
    const btn = document.getElementById('voiceBtn');
    btn.classList.remove('conversation-mode');
    btn.title = 'Tap to talk · Long press for conversation mode';
    if (isRecording) {
      clearTimeout(voiceSilenceTimer);
      recognition.stop();
      isRecording = false;
      btn.classList.remove('recording');
    }
    hideVoiceStatus();
    toast('Conversation ended', 'info', 2000);
  }

  async function sendVoiceText(text) {
    try {
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, jid: currentSession, sender_name: currentUser?.name || 'User' })
      });
      toast('Voice: ' + text.slice(0, 60), 'info', 2500);
      if (conversationMode) {
        conversationWaitingForBot = true;
        showVoiceStatus('Waiting for response...');
        // Poll until we get a bot reply
        await waitForBotReply();
        conversationWaitingForBot = false;
      } else {
        await pollChat();
      }
    } catch (e) {
      console.error('sendVoiceText error:', e);
      toast('Voice send failed', 'error');
      conversationWaitingForBot = false;
    }
  }

  async function waitForBotReply() {
    // Poll for new messages until we get a bot message
    const maxWait = 120000; // 2 min max
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (!conversationMode) return; // user exited conversation mode
      try {
        const r = await fetch('/api/messages?jid=' + encodeURIComponent(currentSession) + '&since=' + encodeURIComponent(chatLastTimestamp) + '&limit=100&idea=' + encodeURIComponent(currentIdea));
        const d = await r.json();
        if (d.messages && d.messages.length > 0) {
          const newMsgs = d.messages.filter(m => !knownMsgIds.has(m.id));
          const botMsg = newMsgs.find(m => m.is_bot_message);
          // Render all new messages into the chat
          const el = document.getElementById('chatMessages');
          const emptyState = document.getElementById('chatEmptyState');
          if (emptyState) emptyState.remove();
          newMsgs.forEach(m => {
            knownMsgIds.add(m.id);
            if (m.is_bot_message && waitingForReply) hideTypingIndicator();
            const isSent = !m.is_bot_message;
            const div = document.createElement('div');
            div.className = 'msg ' + (isSent ? 'sent' : 'received') + botModelClass(m);
            const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const sender = m.is_bot_message ? (m.sender_name || '') : (m.sender_name || m.sender);
            const gFolder = groupsMap[currentSession]?.folder || '';
            let content = renderMarkdown(m.content);
            content = renderAttachments(content, gFolder);
            const speakBtn = m.is_bot_message ? `<button class="msg-speak-btn" onclick="UserDash.speakMessage(this)" data-text="${escAttr(m.content)}" title="Read aloud"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg></button>` : '';
            const nameColor = isSent ? '#fff' : senderColor(sender);
            const senderHtml = sender ? `<span style="color:${nameColor};font-weight:600">${esc(sender)}</span> &middot; ` : '';
            div.innerHTML = `<div class="msg-text">${content}</div><div class="msg-meta">${senderHtml}${time}${speakBtn}</div>`;
            el.appendChild(div);
          });
          chatLastTimestamp = d.messages[d.messages.length - 1].timestamp;
          el.scrollTop = el.scrollHeight;

          if (botMsg) {
            // Auto-speak the bot reply and re-listen when done
            conversationSpeak(botMsg.content);
            return;
          }
        }
      } catch (e) { console.error('waitForBotReply poll error:', e); }
      await new Promise(r => setTimeout(r, 1500));
    }
    // Timed out waiting
    if (conversationMode) {
      showVoiceStatus('No response — tap mic to continue');
    }
  }

  function conversationSpeak(text) {
    if (!('speechSynthesis' in window) || !conversationMode) {
      // Can't speak — just re-listen
      if (conversationMode) startRecording();
      return;
    }
    speechSynthesis.cancel();
    const clean = text.replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`[^`]+`/g, match => match.slice(1, -1))
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^#{1,3}\s/gm, '')
      .replace(/^- /gm, '');
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.0;
    showVoiceStatus('Speaking...');
    utterance.onend = () => {
      if (conversationMode) {
        // Short pause then listen again
        setTimeout(() => {
          if (conversationMode) startRecording();
        }, 600);
      }
    };
    utterance.onerror = () => {
      if (conversationMode) {
        setTimeout(() => {
          if (conversationMode) startRecording();
        }, 600);
      }
    };
    speechSynthesis.speak(utterance);
  }

  function speakText(text, btn) {
    if (!('speechSynthesis' in window)) return;
    // Stop any current speech
    speechSynthesis.cancel();
    // Strip markdown for cleaner speech
    const clean = text.replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`[^`]+`/g, match => match.slice(1, -1))
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^#{1,3}\s/gm, '')
      .replace(/^- /gm, '');
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.0;
    if (btn) {
      btn.classList.add('speaking');
      utterance.onend = () => btn.classList.remove('speaking');
      utterance.onerror = () => btn.classList.remove('speaking');
    }
    speechSynthesis.speak(utterance);
  }

  function switchChatSession(jid) {
    currentSession = jid;
    hideTypingIndicator();
    markSessionRead(jid);
    loadChat();
    loadIdeas();
    syncTypingIndicatorForSession();
    refreshSidebarStatus();
    try { resetPaneForSession(); } catch { /* split-pane not initialized yet */ }
  }

  // --- Ideas (Scoped Workspaces) ---
  let currentIdea = '';

  function getIdeaKey() {
    return 'dockbox-idea-' + currentSession;
  }

  async function loadIdeas() {
    const folder = groupsMap[currentSession]?.folder;
    if (!folder) return;
    try {
      const r = await fetch('/api/groups/' + encodeURIComponent(folder) + '/ideas', {
        headers: { 'X-User-Session': userSession() }
      });
      const d = await r.json();
      const sel = document.getElementById('ideaSelect');
      if (!sel) return;
      sel.innerHTML = '<option value="">Root</option>' +
        (d.ideas || []).map(function(i) {
          return '<option value="' + escAttr(i) + '">' + esc(i) + '</option>';
        }).join('');
      currentIdea = localStorage.getItem(getIdeaKey()) || '';
      sel.value = currentIdea;
      var delBtn = document.getElementById('btnDeleteIdea');
      if (delBtn) delBtn.style.display = currentIdea ? '' : 'none';
    } catch {}
  }

  async function switchIdea(name) {
    currentIdea = name;
    if (name) {
      localStorage.setItem(getIdeaKey(), name);
    } else {
      localStorage.removeItem(getIdeaKey());
    }
    // Kill the current container so next message spawns fresh with correct scope
    if (currentSession) {
      try {
        await fetch('/api/chat/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({ jid: currentSession })
        });
      } catch {}
      hideTypingIndicator();
    }
    toast(name ? 'Switched to idea: ' + name : 'Switched to Root', 'info');
    var delBtn = document.getElementById('btnDeleteIdea');
    if (delBtn) delBtn.style.display = name ? '' : 'none';
    // Reload the chat scoped to the new idea — clears the view and re-fetches only this
    // thought's messages (loadChat resets chatLastTimestamp and refetches with currentIdea),
    // so switching ideas behaves like opening a fresh chat.
    loadChat();
  }

  async function deleteCurrentIdea() {
    if (!currentIdea) return;
    deleteIdea(currentIdea);
  }

  async function createIdea() {
    const name = prompt('Name for the new idea:');
    if (!name || !name.trim()) return;
    const folder = groupsMap[currentSession]?.folder;
    if (!folder) return;
    try {
      const r = await fetch('/api/groups/' + encodeURIComponent(folder) + '/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
        body: JSON.stringify({ name: name.trim() })
      });
      bustCache('/api/groups');
      const d = await r.json();
      if (d.ok) {
        toast('Idea created: ' + name.trim(), 'success');
        await loadIdeas();
        switchIdea(d.name);
        document.getElementById('ideaSelect').value = d.name;
      } else {
        toast(d.error || ('Failed to create idea (HTTP ' + r.status + ')'), 'error');
      }
    } catch (e) {
      toast('Failed to create idea' + (e && e.message ? ' (' + e.message + ')' : ''), 'error');
    }
  }

  async function deleteIdea(name) {
    if (!confirm('Delete idea "' + name + '" and all its files?')) return;
    const folder = groupsMap[currentSession]?.folder;
    if (!folder) return;
    try {
      await fetch('/api/groups/' + encodeURIComponent(folder) + '/ideas/' + encodeURIComponent(name), {
        method: 'DELETE',
        headers: { 'X-User-Session': userSession() }
      });
      bustCache('/api/groups');
      toast('Idea deleted', 'info');
      if (currentIdea === name) switchIdea('');
      await loadIdeas();
    } catch {
      toast('Failed to delete idea', 'error');
    }
  }

  // --- Files ---

  let fileSelection = new Set();  // selected file/dir names (relative to current dir)
  let fileClipboard = null;       // { mode: 'cut'|'copy', paths: ['full/path', ...] }

  async function loadFiles(p) {
    if (p !== undefined) filePath = p;
    fileSelection.clear();
    updateFileToolbar();

    // At root, show session folders (auto-enter if only one)
    if (filePath === '.') {
      const sessions = currentUser ? (currentUser.allowed_sessions || []) : [];
      if (sessions.length === 1) {
        const g = groupsMap[sessions[0]];
        filePath = g ? g.folder : sessions[0];
        renderBreadcrumbs();
      } else {
        renderBreadcrumbs();
        const el = document.getElementById('fileList');
        if (sessions.length === 0) {
          el.innerHTML = '<div class="empty-state"><p class="empty-title">No sessions available</p></div>';
          return;
        }
        el.className = 'file-list';
        el.innerHTML = sessions.map(s => {
          const g = groupsMap[s];
          const folder = g ? g.folder : s;
          const displayName = g ? g.name : s;
          return `<div class="file-row is-dir" onclick="UserDash.loadFiles('${escAttr(folder)}')">`
            + '<div class="file-icon folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></div>'
            + `<div class="file-info"><div class="file-name">${esc(displayName)}</div></div></div>`;
        }).join('');
        return;
      }
    }

    const listEl = document.getElementById('fileList');
    if (listEl && !listEl.childElementCount) listEl.innerHTML = skeletonHtml(6);
    try {
      const r = await fetch(fileUrl('/api/files?path=' + encodeURIComponent(filePath)));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      renderBreadcrumbs();
      renderFileList(d.entries || []);
    } catch (e) {
      document.getElementById('fileList').innerHTML = '<div class="empty-state"><p class="empty-title">Unable to load files' + (e && e.message ? ' (' + esc(e.message) + ')' : '') + '</p></div>';
    }
  }

  function renderBreadcrumbs() {
    const el = document.getElementById('breadcrumbs');
    const parts = filePath === '.' ? [] : filePath.split('/').filter(Boolean);
    let html = `<span class="breadcrumb-item" onclick="UserDash.loadFiles('.')">Sessions</span>`;
    let acc = '';
    parts.forEach((p, i) => {
      acc += (acc ? '/' : '') + p;
      html += `<span class="breadcrumb-sep">/</span>`;
      if (i === parts.length - 1) {
        html += `<span class="breadcrumb-current">${esc(p)}</span>`;
      } else {
        const navPath = acc;
        html += `<span class="breadcrumb-item" onclick="UserDash.loadFiles('${escAttr(navPath)}')">${esc(p)}</span>`;
      }
    });
    el.innerHTML = html;
  }

  function getFileIconInfo(name, type) {
    if (type === 'dir') return { cls: 'folder', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' };
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return { cls: 'pdf', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' };
    if (['doc','docx','txt','md','rtf'].includes(ext)) return { cls: 'doc', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="10" y1="9" x2="8" y2="9"/></svg>' };
    if (['csv','xls','xlsx','numbers','ods'].includes(ext)) return { cls: 'sheet', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>' };
    if (['png','jpg','jpeg','gif','webp','svg','ico','bmp','tiff'].includes(ext)) return { cls: 'img', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' };
    if (['js','ts','jsx','tsx','py','html','css','json','sh','go','rs','java','cpp','c','rb','php'].includes(ext)) return { cls: 'code', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' };
    if (['zip','tar','gz','rar','7z','bz2'].includes(ext)) return { cls: 'zip', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>' };
    if (['mp3','wav','flac','aac','ogg','m4a'].includes(ext)) return { cls: 'audio', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' };
    if (['mp4','mov','avi','mkv','webm'].includes(ext)) return { cls: 'video', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>' };
    return { cls: 'file', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' };
  }

  function renderFileList(entries) {
    const el = document.getElementById('fileList');
    el.className = 'file-list';
    if (!entries || entries.length === 0) {
      el.innerHTML = '<div class="empty-state"><p class="empty-title">This folder is empty</p></div>';
      return;
    }
    const sorted = entries.slice().sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    el.innerHTML = sorted.map(e => {
      const isDir = e.type === 'dir';
      const childPath = filePath === '.' ? e.name : filePath + '/' + e.name;
      const icon = getFileIconInfo(e.name, e.type);
      const size = isDir ? '' : fmtFileSize(e.size);
      const date = e.mtime ? new Date(e.mtime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const meta = [size, date].filter(Boolean).join(' · ');
      const onclick = isDir
        ? `UserDash.loadFiles('${escAttr(childPath)}')`
        : `UserDash.previewFile('${escAttr(childPath)}')`;
      return `<div class="file-row${isDir ? ' is-dir' : ''}" data-name="${escAttr(e.name)}" data-path="${escAttr(childPath)}" data-isdir="${isDir}" onclick="${onclick}">`
        + `<div class="file-icon ${icon.cls}">${icon.svg}</div>`
        + `<div class="file-info"><div class="file-name">${esc(e.name)}${e.scrubbed ? ' <span class="badge-scrubbed">scrubbed</span>' : ''}</div>`
        + (meta ? `<div class="file-meta">${meta}</div>` : '')
        + `</div>`
        + `<div class="file-actions-row">`
        + (isDir ? '' : `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); UserDash.downloadFile('${escAttr(childPath)}')">Download</button>`)
        + `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); UserDash.renameFile('${escAttr(childPath)}')">Rename</button>`
        + `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); UserDash.deleteFile('${escAttr(childPath)}')">Delete</button>`
        + `</div></div>`;
    }).join('');
  }

  function toggleFileSelect(name) {
    if (fileSelection.has(name)) fileSelection.delete(name);
    else fileSelection.add(name);
    updateFileSelectionUI();
  }

  function updateFileSelectionUI() {
    document.querySelectorAll('#fileList .file-row').forEach(row => {
      const name = row.dataset.name;
      const cb = row.querySelector('.file-checkbox');
      if (fileSelection.has(name)) {
        row.classList.add('selected');
        if (cb) cb.checked = true;
      } else {
        row.classList.remove('selected');
        if (cb) cb.checked = false;
      }
    });
    document.querySelectorAll('#fileList .file-row').forEach(tile => {
      const name = tile.dataset.name;
      if (name) tile.classList.toggle('selected', fileSelection.has(name));
    });
    // Update select all button label
    const tiles = document.querySelectorAll('#fileList .file-row[data-name]');
    const selAllBtn = document.getElementById('btnSelectAll');
    if (selAllBtn) selAllBtn.textContent = (fileSelection.size > 0 && fileSelection.size === tiles.length) ? 'Deselect All' : 'Select All';
    updateFileToolbar();
  }

  function updateFileToolbar() {
    const hasSelection = fileSelection.size > 0;
    const hasClipboard = fileClipboard !== null;
    const notAtRoot = filePath !== '.';
    document.getElementById('btnFileCut').disabled = !hasSelection || !notAtRoot;
    document.getElementById('btnFileCopy').disabled = !hasSelection || !notAtRoot;
    document.getElementById('btnFilePaste').disabled = !hasClipboard || !notAtRoot;
    document.getElementById('btnFileDownload').disabled = !notAtRoot;
    document.getElementById('btnFileDelete').disabled = !hasSelection || !notAtRoot;
    document.getElementById('btnFileRename').disabled = fileSelection.size !== 1 || !notAtRoot;
    const scrubBtn = document.getElementById('btnScrubSelected');
    if (scrubBtn) {
      if (hasSelection && notAtRoot) {
        scrubBtn.classList.remove('hidden');
        scrubBtn.textContent = 'Scrub ' + fileSelection.size + ' file' + (fileSelection.size > 1 ? 's' : '');
      } else {
        scrubBtn.classList.add('hidden');
      }
    }
  }

  function fileCut() {
    if (fileSelection.size === 0 || filePath === '.') return;
    fileClipboard = { mode: 'cut', paths: [...fileSelection].map(n => filePath + '/' + n) };
    toast('Cut ' + fileSelection.size + ' item(s)', 'info');
    updateFileToolbar();
  }

  function fileCopy() {
    if (fileSelection.size === 0 || filePath === '.') return;
    fileClipboard = { mode: 'copy', paths: [...fileSelection].map(n => filePath + '/' + n) };
    toast('Copied ' + fileSelection.size + ' item(s)', 'info');
    updateFileToolbar();
  }

  async function filePaste() {
    if (!fileClipboard || filePath === '.') return;
    const destDir = filePath;
    try {
      for (const srcPath of fileClipboard.paths) {
        const name = srcPath.split('/').pop();
        const destPath = destDir + '/' + name;
        if (fileClipboard.mode === 'cut') {
          await fetch(fileUrl('/api/files/rename'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: srcPath, to: destPath })
          });
        } else {
          await fetch(fileUrl('/api/files/copy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: srcPath, to: destPath })
          });
        }
      }
      toast('Pasted ' + fileClipboard.paths.length + ' item(s)', 'success');
      if (fileClipboard.mode === 'cut') fileClipboard = null;
      loadFiles();
    } catch {
      toast('Paste failed', 'error');
    }
  }

  async function fileDelete() {
    if (fileSelection.size === 0 || filePath === '.') return;
    const count = fileSelection.size;
    if (!confirm('Delete ' + count + ' item(s)?')) return;
    try {
      for (const name of fileSelection) {
        const delPath = filePath + '/' + name;
        await fetch(fileUrl('/api/files?path=' + encodeURIComponent(delPath)), { method: 'DELETE' });
      }
      toast('Deleted ' + count + ' item(s)', 'success');
      fileSelection.clear();
      loadFiles();
    } catch {
      toast('Delete failed', 'error');
    }
  }

  async function fileNewFolder() {
    if (filePath === '.') { toast('Navigate into a session folder first', 'warning'); return; }
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    const cleanName = name.trim().replace(/[/\\]/g, '');
    if (!cleanName) { toast('Invalid folder name', 'warning'); return; }
    try {
      await fetch(fileUrl('/api/files/mkdir'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath + '/' + cleanName })
      });
      toast('Folder created', 'success');
      loadFiles();
    } catch {
      toast('Failed to create folder', 'error');
    }
  }

  function fileSelectAll() {
    if (filePath === '.') return;
    const tiles = document.querySelectorAll('#fileList .file-row[data-name]');
    if (fileSelection.size === tiles.length && tiles.length > 0) {
      // Toggle off — deselect all
      fileSelection.clear();
    } else {
      tiles.forEach(t => fileSelection.add(t.dataset.name));
    }
    updateFileSelectionUI();
  }

  async function fileRename() {
    if (fileSelection.size !== 1 || filePath === '.') return;
    const oldName = [...fileSelection][0];
    const newName = prompt('Rename to:', oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    const cleanName = newName.trim().replace(/[/\\]/g, '');
    try {
      await fetch(fileUrl('/api/files/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: filePath + '/' + oldName, to: filePath + '/' + cleanName })
      });
      toast('Renamed', 'success');
      fileSelection.clear();
      loadFiles();
    } catch {
      toast('Rename failed', 'error');
    }
  }

  let previewFilePath = '';

  async function previewFile(filePath_) {
    try {
      const r = await fetch(fileUrl('/api/files/read?path=' + encodeURIComponent(filePath_)));
      const d = await r.json();
      const filename = filePath_.split('/').pop();
      previewFilePath = filePath_;
      document.getElementById('previewTitle').textContent = filename;
      const body = document.getElementById('previewBody');
      if (d.format === 'html' || filename.endsWith('.html') || filename.endsWith('.docx')) {
        body.style.whiteSpace = 'normal';
        // Sanitize HTML to prevent XSS
        const _tmp = document.createElement('div');
        _tmp.innerHTML = d.content || '';
        _tmp.querySelectorAll('script,iframe,object,embed,style,svg,math,link[rel="import"],base,form').forEach(el => el.remove());
        _tmp.querySelectorAll('*').forEach(el => {
          for (const attr of [...el.attributes]) {
            const name = attr.name.toLowerCase();
            const val = attr.value.trim().toLowerCase();
            if (name.startsWith('on') || val.startsWith('javascript:') || val.startsWith('data:text/html') || val.startsWith('vbscript:'))
              el.removeAttribute(attr.name);
          }
        });
        body.innerHTML = _tmp.innerHTML;
      } else if (filename.endsWith('.md')) {
        body.style.whiteSpace = 'normal';
        body.innerHTML = renderMarkdown(d.content || '');
      } else {
        body.style.whiteSpace = 'pre-wrap';
        body.textContent = d.content || '';
      }

      document.getElementById('previewModal').classList.remove('hidden');
    } catch {
      toast('Unable to load file', 'error');
    }
  }

  function closePreview() {
    document.getElementById('previewModal').classList.add('hidden');
    document.getElementById('fileVersions').classList.add('hidden');
    previewFilePath = '';
  }

  async function showFileHistory() {
    if (!previewFilePath) return;
    const panel = document.getElementById('fileVersions');
    panel.innerHTML = 'Loading...';
    panel.classList.remove('hidden');
    try {
      const r = await fetch(fileUrl('/api/files/history?path=' + encodeURIComponent(previewFilePath)));
      const d = await r.json();
      if (!d.versions || d.versions.length === 0) {
        panel.innerHTML = '<div class="dim" style="padding:8px 0">No version history available</div>';
        return;
      }
      panel.innerHTML = d.versions.map(v =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
          <div>
            <span class="dim" style="font-size:12px">${new Date(v.date).toLocaleString()}</span>
            <span style="font-size:13px;margin-left:8px">${esc(v.message)}</span>
          </div>
          <div style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm" onclick="UserDash.viewVersion('${escAttr(v.hash)}')">View</button>
            <button class="btn btn-ghost btn-sm" onclick="UserDash.revertVersion('${escAttr(v.hash)}')">Restore</button>
          </div>
        </div>`
      ).join('');
    } catch {
      panel.innerHTML = '<div class="dim">Failed to load history</div>';
    }
  }

  async function viewVersion(hash) {
    if (!previewFilePath) return;
    try {
      const r = await fetch(fileUrl('/api/files/version?path=' + encodeURIComponent(previewFilePath) + '&hash=' + encodeURIComponent(hash)));
      const d = await r.json();
      const body = document.getElementById('previewBody');
      if (previewFilePath.endsWith('.md')) {
        body.innerHTML = renderMarkdown(d.content || '');
      } else {
        body.textContent = d.content || '';
      }
    } catch {
      toast('Failed to load version', 'error');
    }
  }

  async function revertVersion(hash) {
    if (!previewFilePath) return;
    if (!confirm('Restore this version? Current content will be replaced.')) return;
    try {
      const r = await fetch(fileUrl('/api/files/revert'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: previewFilePath, hash })
      });
      if (r.ok) {
        toast('File restored', 'success');
        previewFile(previewFilePath);
      } else {
        toast('Restore failed', 'error');
      }
    } catch {
      toast('Restore failed', 'error');
    }
  }

  function downloadFile() {
    if (filePath === '.') return;
    if (fileSelection.size === 0) {
      // No selection — download current directory as archive
      window.open(fileUrl('/api/files/download?path=' + encodeURIComponent(filePath)));
    } else {
      for (const name of fileSelection) {
        const p = filePath + '/' + name;
        window.open(fileUrl('/api/files/download?path=' + encodeURIComponent(p)));
      }
    }
  }

  // --- Drag & Drop ---

  function initDragDrop() {
    const filesView = document.getElementById('view-files');
    const overlay = document.getElementById('dropOverlay');
    let dragCounter = 0;

    filesView.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (filePath !== '.') overlay.classList.remove('hidden');
    });

    filesView.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; overlay.classList.add('hidden'); }
    });

    filesView.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    filesView.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.add('hidden');
      if (filePath === '.') {
        toast('Navigate into a session folder first', 'warning');
        return;
      }
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      let uploaded = 0;
      for (const file of files) {
        try {
          await uploadWithProgress(fileUrl('/api/files/upload?path=' + encodeURIComponent(filePath)), file);
          uploaded++;
        } catch {
          // error already shown by uploadWithProgress
        }
      }
      if (uploaded > 0) {
        loadFiles();
        const scrubCheck = document.getElementById('scrubOnUpload');
        if (scrubCheck && scrubCheck.checked) {
          fileSelection = new Set(Array.from(files).map(f => f.name));
          scrubSelected();
        }
      }
    });
  }

  // --- Scrub ---

  function scrubSelected() {
    const paths = Array.from(fileSelection).map(n => filePath + '/' + n);
    if (paths.length === 0) return;
    document.getElementById('scrubModal').classList.remove('hidden');
    const progress = document.getElementById('scrubProgress');
    progress.innerHTML = paths.map((p, i) =>
      '<div class="scrub-step active" id="scrub-step-' + i + '">' + esc(p.split('/').pop()) + ' \u2014 scrubbing...</div>'
    ).join('');
    fetch(fileUrl('/api/vault/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths })
    }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
      (d.results || []).forEach((r, i) => {
        const el = document.getElementById('scrub-step-' + i);
        if (!el) return;
        if (r.error) {
          el.className = 'scrub-step';
          el.textContent = paths[i].split('/').pop() + ' \u2014 ' + r.error;
        } else {
          el.className = 'scrub-step done';
          var label = paths[i].split('/').pop() + ' \u2014 done';
          if (r.ollamaUsed) label += ' (AI enhanced)';
          else if (r.warnings && r.warnings.some(function(w) { return w.includes('Ollama'); })) label += ' (regex only)';
          el.textContent = label;
        }
      });
      var anyOllamaFail = (d.results || []).some(function(r) { return r.warnings && r.warnings.some(function(w) { return w.includes('Ollama') && w.includes('failed'); }); });
      progress.innerHTML += '<div style="margin-top:16px"><button class="btn btn-accent btn-sm" onclick="UserDash.closeScrubModal()">Done</button></div>';
      fileSelection.clear();
      updateFileSelectionUI();
      toast(anyOllamaFail ? 'Scrubbed (Ollama unavailable, regex + name detection only)' : 'Scrubbing complete', anyOllamaFail ? 'warning' : 'success');
    }).catch(() => {
      progress.innerHTML = '<div style="color:var(--color-error)">Scrub failed</div><div style="margin-top:16px"><button class="btn btn-ghost btn-sm" onclick="UserDash.closeScrubModal()">Close</button></div>';
      toast('Scrubbing failed', 'error');
    });
  }

  function scrubAll() {
    fetch(fileUrl('/api/files?path=' + encodeURIComponent(filePath)))
      .then(r => r.json())
      .then(d => {
        const files = (d.entries || []).filter(e => e.type === 'file');
        if (files.length === 0) { toast('No files to scrub', 'info'); return; }
        fileSelection = new Set(files.map(f => f.name));
        scrubSelected();
      });
  }

  function closeScrubModal() {
    document.getElementById('scrubModal').classList.add('hidden');
  }

  // --- Quick Tasks ---

  async function openQuickTask() {
    const modal = document.getElementById('quickTaskModal');
    if (!modal) return;
    // Populate assignee dropdown with group members only
    const sel = document.getElementById('qtAssignee');
    sel.innerHTML = '<option value="">— select person —</option>';
    try {
      const groupJid = currentUser?.home_group || '';
      const r = await fetch('/api/groups/' + encodeURIComponent(groupJid) + '/members');
      const d = await r.json();
      (d.members || []).forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.name + (u.id === currentUser?.id ? ' (me)' : '');
        if (u.id === currentUser?.id) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch {}
    document.getElementById('qtTitle').value = '';
    document.getElementById('qtPriority').value = 'medium';
    document.getElementById('qtDueDate').value = '';
    document.getElementById('qtNotes').value = '';
    document.getElementById('quickTaskModalTitle').textContent = 'Quick Task';
    document.getElementById('btnSaveQuickTask').onclick = saveQuickTask;
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('qtTitle').focus(), 50);
  }

  async function saveQuickTask() {
    const title = document.getElementById('qtTitle').value.trim();
    if (!title) { document.getElementById('qtTitle').focus(); return; }
    const assigned_to = document.getElementById('qtAssignee').value || currentUser?.id;
    const priority = document.getElementById('qtPriority').value;
    const due_date = document.getElementById('qtDueDate').value || null;
    const description = document.getElementById('qtNotes').value.trim() || '';
    const btn = document.getElementById('btnSaveQuickTask');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await fetch('/api/work-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
        body: JSON.stringify({ title, description, priority, assigned_to, due_date }),
      });
      document.getElementById('quickTaskModal').classList.add('hidden');
      loadHome();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Assign Task';
    }
  }

  async function updateQuickTaskStatus(taskId, newStatus) {
    try {
      await fetch('/api/work-tasks/' + encodeURIComponent(taskId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
        body: JSON.stringify({ status: newStatus }),
      });
      loadHome();
    } catch {}
  }

  // --- Projects ---

  let projectsCache = [];
  let currentProjectId = null;
  let currentProjectData = null;
  let currentProjectGroupFilter = '';
  let projectGroupsCache = [];

  async function loadProjectGroups() {
    try {
      const r = await cachedFetch('/api/groups', { headers: { 'X-User-Session': userSession() } }, 5000);
      const d = await r.json();
      const sessions = currentUser ? (currentUser.allowed_sessions || []) : [];
      projectGroupsCache =(d.groups || d || []).filter(function(g) { return sessions.includes(g.jid); });
      const sel = document.getElementById('projectGroupFilter');
      if (sel) {
        sel.innerHTML = '<option value="">All Groups</option>' + projectGroupsCache.map(function(g) {
          return '<option value="' + escAttr(g.jid) + '">' + esc(g.name || g.jid) + '</option>';
        }).join('');
        sel.value = currentProjectGroupFilter;
      }
    } catch(e) { console.error('loadProjectGroups:', e); }
  }

  async function loadProjects() {
    if (!currentUser) return;
    await loadProjectGroups();
    try {
      const r = await fetch('/api/projects', { headers: { 'x-user-session': userSession() } });
      const d = await r.json();
      projectsCache = d.projects || [];
      renderProjectList();
      updateRightSidebar('projects');
    } catch (e) {
      console.error('loadProjects error:', e);
      document.getElementById('projectList').innerHTML = '<div class="empty-state"><p class="empty-title">Unable to load projects</p></div>';
    }
  }

  function getGroupName(jid) {
    var g = projectGroupsCache.find(function(g) { return g.jid === jid; });
    return g ? (g.name || g.jid) : jid;
  }

  function renderProjectList() {
    const el = document.getElementById('projectList');
    const filtered = currentProjectGroupFilter
      ? projectsCache.filter(function(p) { return p.group_jid === currentProjectGroupFilter; })
      : projectsCache;
    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state"><p class="empty-title">No projects yet</p><p class="empty-desc">Create a project to track your work.</p></div>';
      return;
    }
    // Group by group_jid when showing all groups
    const groups = {};
    filtered.forEach(function(p) {
      var k = p.group_jid || 'unknown';
      if (!groups[k]) groups[k] = [];
      groups[k].push(p);
    });
    var html = '';
    var groupKeys = Object.keys(groups);
    var showHeaders = !currentProjectGroupFilter && groupKeys.length > 1;
    groupKeys.forEach(function(gk) {
      if (showHeaders) html += '<div class="project-group-header">' + esc(getGroupName(gk)) + '</div>';
      html += groups[gk].map(function(p) {
        var statusClass = p.status === 'On Track' ? 'on-track' : p.status === 'At Risk' ? 'at-risk' : p.status === 'Blocked' ? 'blocked' : 'default';
        var ringColor = statusClass === 'on-track' ? '#10b981' : statusClass === 'at-risk' ? '#f59e0b' : statusClass === 'blocked' ? '#ef4444' : '#6366f1';
        var dueStr = p.due_date ? new Date(p.due_date + 'T00:00:00').toLocaleDateString() : '';
        var isOverdue = p.due_date && p.due_date < new Date().toISOString().split('T')[0] && p.status !== 'Completed';
        // Collect unique team members from tasks
        var team = [];
        var seenNames = {};
        (p.tasks || []).forEach(function(t) {
          if (t.assigned_to_name && !seenNames[t.assigned_to_name]) {
            seenNames[t.assigned_to_name] = true;
            team.push({ name: t.assigned_to_name, color: t.assigned_to_color || '#666' });
          }
        });
        return '<div class="project-card" onclick="UserDash.openProject(\'' + escAttr(p.id) + '\')">'
          + '<div class="project-card-top">'
          + '<div class="project-card-name">' + esc(p.name) + '</div>'
          + (p.project_code ? '<span class="project-code-badge">' + esc(p.project_code) + '</span>' : '')
          + (!currentProjectGroupFilter ? '<span class="project-group-badge">' + esc(getGroupName(p.group_jid)) + '</span>' : '')
          + '<span class="project-status-badge status-' + statusClass + '">' + esc(p.status) + '</span>'
          + '</div>'
          + (p.description ? '<div class="project-card-desc">' + esc(p.description).substring(0, 120) + '</div>' : '')
          + '<div class="project-card-ring">'
          + svgRing(p.progress || 0, 48, ringColor)
          + '<div class="project-card-ring-info">'
          + (dueStr ? '<span class="project-card-due' + (isOverdue ? ' overdue' : '') + '">' + (isOverdue ? 'Overdue: ' : 'Due: ') + esc(dueStr) + '</span>' : '')
          + (team.length ? '<div class="project-card-avatars">' + renderAvatarGroup(team, 5) + '</div>' : '')
          + '</div>'
          + '</div>'
          + '</div>';
      }).join('');
    });
    el.innerHTML = html;
  }

  let projectGroupMembers = [];

  async function openProject(projectId) {
    currentProjectId = projectId;
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(projectId), { headers: { 'x-user-session': userSession() } });
      currentProjectData = await r.json();
      // Fetch group members for assignee dropdowns
      var groupJid = currentProjectData.group_jid || currentUser?.home_group || '';
      try {
        var mr = await fetch('/api/groups/' + encodeURIComponent(groupJid) + '/members');
        var md = await mr.json();
        projectGroupMembers = md.members || [];
      } catch { projectGroupMembers = []; }
      renderProjectDetail();
    } catch (e) {
      toast('Failed to load project', 'error');
    }
  }

  function renderProjectDetail() {
    const p = currentProjectData;
    if (!p) return;
    document.getElementById('projectListView').classList.add('hidden');
    document.getElementById('projectDetailView').classList.remove('hidden');
    document.getElementById('projectDetailName').textContent = p.name;
    const statusClass = p.status === 'On Track' ? 'on-track' : p.status === 'At Risk' ? 'at-risk' : p.status === 'Blocked' ? 'blocked' : 'default';
    document.getElementById('projectDetailStatus').textContent = p.status;
    document.getElementById('projectDetailStatus').className = 'project-status-badge status-' + statusClass;
    const codeEl = document.getElementById('projectDetailCode');
    codeEl.textContent = p.project_code || '';
    codeEl.style.display = p.project_code ? '' : 'none';
    document.getElementById('projectProgressFill').style.width = (p.progress || 0) + '%';
    document.getElementById('projectProgressText').textContent = (p.progress || 0) + '%';
    // Render overview
    renderProjectOverview();
    renderProjectWorkTasks();
    renderDeliverables();
    renderPriorities();
    renderFinancials();
    renderBlockers();
    renderTimesheet();
    // Activate first tab
    switchProjectTab('overview');
  }

  function switchProjectTab(tab) {
    document.querySelectorAll('.project-tab').forEach(t => t.classList.toggle('active', t.dataset.ptab === tab));
    document.querySelectorAll('.project-tab-content').forEach(c => c.classList.toggle('active', c.id === 'ptab-' + tab));
  }

  function renderProjectOverview() {
    const p = currentProjectData;
    const f = p.financials || {};
    const dels = p.deliverables || [];
    const done = dels.filter(d => d.done).length;
    const tasks = p.tasks || [];
    const tasksDone = tasks.filter(t => t.status === 'done').length;
    const blockers = p.blockers || [];
    const ts = p.timesheet_summary || { total_hours: 0 };
    const dueStr = p.due_date ? new Date(p.due_date + 'T00:00:00').toLocaleDateString() : 'Not set';
    var statusClass = p.status === 'On Track' ? 'on-track' : p.status === 'At Risk' ? 'at-risk' : p.status === 'Blocked' ? 'blocked' : 'default';
    var ringColor = statusClass === 'on-track' ? '#10b981' : statusClass === 'at-risk' ? '#f59e0b' : statusClass === 'blocked' ? '#ef4444' : '#6366f1';
    // Team members
    var team = [];
    var seenNames = {};
    tasks.forEach(function(t) {
      if (t.assigned_to_name && !seenNames[t.assigned_to_name]) {
        seenNames[t.assigned_to_name] = true;
        team.push({ name: t.assigned_to_name, color: t.assigned_to_color || '#666' });
      }
    });
    var budgetPct = f.budget > 0 ? Math.round((f.spent || 0) / f.budget * 100) : 0;
    document.getElementById('projectOverview').innerHTML =
      '<div class="overview-card" style="grid-column:span 2;display:flex;align-items:center;gap:20px">'
      + svgRing(p.progress || 0, 72, ringColor)
      + '<div><div class="overview-label" style="margin-bottom:4px">Overall Progress</div>'
      + '<div style="font-size:.85rem;color:var(--text-secondary)">' + tasksDone + '/' + tasks.length + ' tasks &middot; ' + done + '/' + dels.length + ' deliverables</div>'
      + (team.length ? '<div style="margin-top:6px">' + renderAvatarGroup(team, 6) + '</div>' : '')
      + '</div></div>'
      + '<div class="overview-card"><div class="overview-label">Description</div><div class="overview-value">' + esc(p.description || 'No description') + '</div></div>'
      + '<div class="overview-card"><div class="overview-label">Due Date</div><div class="overview-value">' + esc(dueStr) + '</div></div>'
      + '<div class="overview-card"><div class="overview-label">Blockers</div><div class="overview-value" style="' + (blockers.length ? 'color:var(--danger,#ef4444)' : '') + '">' + blockers.length + ' active</div></div>'
      + '<div class="overview-card"><div class="overview-label">Budget</div><div class="overview-value" style="display:flex;align-items:center;gap:8px">$' + (f.budget || 0).toLocaleString() + (f.budget > 0 ? ' ' + svgRing(budgetPct, 32, budgetPct > 90 ? '#ef4444' : '#3b82f6') : '') + '</div></div>'
      + '<div class="overview-card"><div class="overview-label">Spent</div><div class="overview-value">$' + (f.spent || 0).toLocaleString() + '</div></div>'
      + '<div class="overview-card"><div class="overview-label">Revenue</div><div class="overview-value">$' + (f.revenue || 0).toLocaleString() + '</div></div>'
      + '<div class="overview-card"><div class="overview-label">Time Logged</div><div class="overview-value">' + (ts.total_hours || 0) + 'h</div></div>';
  }

  function renderProjectWorkTasks() {
    var tasks = currentProjectData.tasks || [];
    var el = document.getElementById('projectWorkTasksList');
    if (!el) return;
    if (!tasks.length) {
      el.innerHTML = '<div class="empty-state"><p class="empty-desc">No tasks yet</p></div>';
      return;
    }
    var cols = { todo: [], in_progress: [], done: [] };
    tasks.forEach(function(t) { (cols[t.status] || cols.todo).push(t); });
    function taskCard(t) {
      var prioClass = t.priority === 'urgent' ? 'urgent' : t.priority === 'high' ? 'high' : t.priority === 'low' ? 'low' : 'medium';
      var dueStr = t.due_date ? new Date(t.due_date + 'T00:00:00').toLocaleDateString() : '';
      var overdue = t.due_date && t.status !== 'done' && t.due_date < new Date().toISOString().split('T')[0];
      var assignOpts = '<option value="">Unassigned</option>';
      projectGroupMembers.forEach(function(m) {
        assignOpts += '<option value="' + escAttr(m.id) + '"' + (t.assigned_to === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>';
      });
      return '<div class="wt-card" draggable="true" data-taskid="' + escAttr(t.id) + '" data-status="' + escAttr(t.status) + '">'
        + '<div class="wt-card-top">'
        + '<span class="wt-card-title">' + esc(t.title) + '</span>'
        + '<span class="wt-prio-badge prio-' + prioClass + '">' + esc(t.priority) + '</span>'
        + '</div>'
        + (t.description ? '<div class="wt-card-desc">' + esc(t.description).substring(0, 80) + '</div>' : '')
        + '<div class="wt-card-meta">'
        + '<select class="wt-assign-select" onchange="UserDash.assignProjectWorkTask(\'' + escAttr(t.id) + '\', this.value)" style="font-size:.72rem;padding:2px 4px;border:1px solid var(--border,#333);border-radius:4px;background:var(--bg-secondary,#1a1a2e);color:var(--text-primary,#e0e0e0);max-width:120px">' + assignOpts + '</select>'
        + (dueStr ? '<span class="wt-due' + (overdue ? ' overdue' : '') + '" style="margin-left:auto;' + (overdue ? 'color:var(--danger,#ef4444);font-weight:600' : '') + '">' + esc(dueStr) + '</span>' : '')
        + '</div>'
        + '<div class="wt-card-actions">'
        + '<button class="btn btn-danger btn-sm" onclick="UserDash.deleteProjectWorkTask(\'' + escAttr(t.id) + '\')" style="padding:2px 6px;font-size:.7rem">&times;</button>'
        + '</div></div>';
    }
    var colLabels = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
    var colColors = { todo: '#94a3b8', in_progress: '#f59e0b', done: '#10b981' };
    var html = '<div class="wt-kanban">';
    ['todo', 'in_progress', 'done'].forEach(function(status) {
      html += '<div class="wt-kanban-col" data-col-status="' + status + '">'
        + '<div class="wt-kanban-header"><span style="color:' + colColors[status] + '">' + colLabels[status] + '</span> <span class="wt-kanban-count">' + cols[status].length + '</span></div>'
        + '<div class="wt-kanban-col-body">' + cols[status].map(taskCard).join('') + '</div>'
        + '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
    initKanbanDragDrop(el);
  }

  function initKanbanDragDrop(container) {
    var draggedCard = null;
    var draggedId = null;
    container.addEventListener('dragstart', function(e) {
      var card = e.target.closest('.wt-card[draggable]');
      if (!card) return;
      draggedCard = card;
      draggedId = card.getAttribute('data-taskid');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedId);
    });
    container.addEventListener('dragend', function(e) {
      if (draggedCard) draggedCard.classList.remove('dragging');
      draggedCard = null;
      draggedId = null;
      container.querySelectorAll('.wt-kanban-col').forEach(function(c) { c.classList.remove('drag-over'); });
    });
    container.querySelectorAll('.wt-kanban-col').forEach(function(col) {
      var body = col.querySelector('.wt-kanban-col-body') || col;
      body.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('drag-over');
      });
      body.addEventListener('dragleave', function(e) {
        if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
      });
      body.addEventListener('drop', function(e) {
        e.preventDefault();
        col.classList.remove('drag-over');
        var taskId = e.dataTransfer.getData('text/plain');
        var newStatus = col.getAttribute('data-col-status');
        if (!taskId || !newStatus) return;
        // Optimistic move: append card to this column
        if (draggedCard) {
          draggedCard.classList.remove('dragging');
          body.appendChild(draggedCard);
        }
        // Update counts
        container.querySelectorAll('.wt-kanban-col').forEach(function(c) {
          var cnt = c.querySelector('.wt-kanban-col-body');
          var badge = c.querySelector('.wt-kanban-count');
          if (cnt && badge) badge.textContent = cnt.querySelectorAll('.wt-card').length;
        });
        // Persist via API
        changeWorkTaskStatus(taskId, newStatus);
      });
    });
  }

  async function addProjectWorkTask() {
    if (!currentProjectId) return;
    var title = prompt('Task title:');
    if (!title) return;
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
        body: JSON.stringify({ title: title, created_by: currentUser.id })
      });
      toast('Task added', 'success');
      openProject(currentProjectId);
    } catch { toast('Failed to add task', 'error'); }
  }

  async function changeWorkTaskStatus(taskId, status) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/tasks/' + encodeURIComponent(taskId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
        body: JSON.stringify({ status: status })
      });
      // Update local data and re-render just the kanban — no full page reload
      var tasks = currentProjectData.tasks || [];
      var t = tasks.find(function(x) { return x.id === taskId; });
      if (t) t.status = status;
      renderProjectWorkTasks();
      // Update progress bar: done=1pt, in_progress=0.5pt (matches server logic)
      var dels = currentProjectData.deliverables || [];
      var totalItems = tasks.length + dels.length;
      if (totalItems) {
        var delPoints = dels.filter(function(d) { return d.done; }).length;
        var taskPoints = tasks.reduce(function(sum, x) {
          if (x.status === 'done') return sum + 1;
          if (x.status === 'in_progress') return sum + 0.5;
          return sum;
        }, 0);
        var pct = Math.round((delPoints + taskPoints) / totalItems * 100);
        currentProjectData.progress = pct;
        var fill = document.getElementById('projectProgressFill');
        var txt = document.getElementById('projectProgressText');
        if (fill) fill.style.width = pct + '%';
        if (txt) txt.textContent = pct + '%';
      }
    } catch { toast('Failed to update task', 'error'); }
  }

  async function assignProjectWorkTask(taskId, userId) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/tasks/' + encodeURIComponent(taskId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
        body: JSON.stringify({ assigned_to: userId || null })
      });
      // Re-fetch tasks only, stay on the work-tasks tab
      var r = await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/tasks', { headers: { 'x-user-session': userSession() } });
      var d = await r.json();
      currentProjectData.tasks = d.tasks || d;
      renderProjectWorkTasks();
    } catch { toast('Failed to assign task', 'error'); }
  }

  async function deleteProjectWorkTask(taskId) {
    if (!confirm('Delete this task?')) return;
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/tasks/' + encodeURIComponent(taskId), {
        method: 'DELETE',
        headers: { 'x-user-session': userSession() }
      });
      toast('Task deleted', 'info');
      openProject(currentProjectId);
    } catch { toast('Failed to delete task', 'error'); }
  }

  function renderDeliverables() {
    const dels = currentProjectData.deliverables || [];
    const el = document.getElementById('deliverablesList');
    if (!dels.length) { el.innerHTML = '<div class="empty-state"><p class="empty-desc">No deliverables yet</p></div>'; return; }
    el.innerHTML = dels.map(d => {
      const dueStr = d.due_date ? new Date(d.due_date + 'T00:00:00').toLocaleDateString() : '';
      return '<div class="deliverable-item' + (d.done ? ' done' : '') + '">'
        + '<button class="deliverable-check" onclick="UserDash.toggleDeliverable(\'' + escAttr(d.id) + '\')">' + (d.done ? '&#9745;' : '&#9744;') + '</button>'
        + '<span class="deliverable-name" onclick="UserDash.editDeliverable(\'' + escAttr(d.id) + '\',\'' + escAttr(d.name) + '\',\'' + escAttr(d.due_date || '') + '\')" style="cursor:pointer" title="Click to edit">' + esc(d.name) + '</span>'
        + (dueStr ? '<span class="deliverable-due">' + esc(dueStr) + '</span>' : '')
        + '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();UserDash.editDeliverable(\'' + escAttr(d.id) + '\',\'' + escAttr(d.name) + '\',\'' + escAttr(d.due_date || '') + '\')" style="padding:2px 6px;font-size:0.75rem;margin-left:auto" title="Edit">&#9998;</button>'
        + '<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();UserDash.deleteDeliverable(\'' + escAttr(d.id) + '\')" style="padding:2px 6px;font-size:0.75rem;">&times;</button>'
        + '</div>';
    }).join('');
  }

  function renderPriorities() {
    const pris = currentProjectData.priorities || [];
    const el = document.getElementById('prioritiesList');
    if (!pris.length) { el.innerHTML = '<div class="empty-state"><p class="empty-desc">No priorities yet</p></div>'; return; }
    el.innerHTML = pris.map(p =>
      '<div class="priority-item">'
      + '<span class="priority-rank">#' + p.rank + '</span>'
      + '<span class="priority-text">' + esc(p.item) + '</span>'
      + '<span class="priority-impact impact-' + esc(p.impact) + '">' + esc(p.impact) + '</span>'
      + '<button class="btn btn-danger btn-sm" onclick="UserDash.deletePriority(\'' + escAttr(p.id) + '\')" style="padding:2px 6px;font-size:0.75rem;">&times;</button>'
      + '</div>'
    ).join('');
  }

  function renderFinancials() {
    const f = currentProjectData.financials || {};
    const budgetPct = f.budget ? Math.round((f.spent || 0) / f.budget * 100) : 0;
    const remaining = (f.budget || 0) - (f.spent || 0);
    document.getElementById('financialsContent').innerHTML =
      '<div class="financials-grid">'
      + '<div class="financial-card"><div class="financial-label">Budget</div><div class="financial-value">$' + (f.budget || 0).toLocaleString() + '</div></div>'
      + '<div class="financial-card"><div class="financial-label">Spent</div><div class="financial-value">$' + (f.spent || 0).toLocaleString() + '<span class="financial-pct">' + budgetPct + '%</span></div>'
      + '<div class="financial-bar"><div class="financial-bar-fill' + (budgetPct > 90 ? ' danger' : budgetPct > 70 ? ' warning' : '') + '" style="width:' + Math.min(budgetPct, 100) + '%"></div></div></div>'
      + '<div class="financial-card"><div class="financial-label">Remaining</div><div class="financial-value' + (remaining < 0 ? ' danger-text' : '') + '">$' + remaining.toLocaleString() + '</div></div>'
      + '<div class="financial-card"><div class="financial-label">Revenue</div><div class="financial-value">$' + (f.revenue || 0).toLocaleString() + '</div></div>'
      + '</div>'
      + (f.notes ? '<div class="financial-notes">' + esc(f.notes) + '</div>' : '')
      + '<button class="btn btn-ghost btn-sm" onclick="UserDash.editFinancials()" style="margin-top:12px">Edit Financials</button>';
  }

  function renderBlockers() {
    const blockers = currentProjectData.blockers || [];
    const el = document.getElementById('blockersList');
    if (!blockers.length) { el.innerHTML = '<div class="empty-state"><p class="empty-desc">No blockers</p></div>'; return; }
    el.innerHTML = blockers.map(b =>
      '<div class="blocker-item severity-' + esc(b.severity) + '">'
      + '<span class="blocker-severity">' + esc(b.severity) + '</span>'
      + '<span class="blocker-text">' + esc(b.blocker) + '</span>'
      + '<button class="btn btn-danger btn-sm" onclick="UserDash.deleteBlocker(\'' + escAttr(b.id) + '\')" style="margin-left:auto;padding:2px 6px;font-size:0.75rem;">&times;</button>'
      + '</div>'
    ).join('');
  }

  function renderTimesheet() {
    const summary = currentProjectData.timesheet_summary || { total_hours: 0, by_user: [] };
    const summaryEl = document.getElementById('timesheetSummary');
    summaryEl.innerHTML = '<div class="timesheet-header-row">'
      + '<div class="timesheet-total">Total: <strong>' + summary.total_hours + 'h</strong></div>'
      + '<button class="btn btn-ghost btn-sm" onclick="UserDash.startTimerForProject(\'' + escAttr(currentProjectId) + '\')" style="display:flex;align-items:center;gap:4px">'
      + '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>Start Timer</button>'
      + '</div>'
      + (summary.by_user.length ? '<div class="timesheet-by-user">' + summary.by_user.map(u =>
        '<span class="timesheet-user-chip">' + esc(u.user_name || 'Unknown') + ': ' + u.hours + 'h</span>'
      ).join('') + '</div>' : '')
      + '<div id="timesheetActiveTimers"></div>';
    // Load active timers for this project
    loadProjectTimers();
    // Load entries lazily
    loadTimesheetEntries();
  }

  async function loadProjectTimers() {
    const el = document.getElementById('timesheetActiveTimers');
    if (!el || !currentProjectId) return;
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/timers', { headers: { 'x-user-session': userSession() } });
      const d = await r.json();
      const timers = d.timers || [];
      if (timers.length === 0) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="active-timers-section">'
        + timers.map(function(t) {
          const elapsed = (Date.now() - new Date(t.started_at).getTime()) / 1000;
          const h = Math.floor(elapsed / 3600);
          const m = Math.floor((elapsed % 3600) / 60);
          return '<div class="active-timer-card">'
            + '<div class="active-timer-pulse"></div>'
            + '<div class="active-timer-info">'
            + '<span class="active-timer-desc">' + esc(t.description || 'Timer running') + '</span>'
            + '<span class="active-timer-elapsed">' + (h > 0 ? h + 'h ' : '') + m + 'm</span>'
            + '</div>'
            + '<button class="btn btn-accent btn-sm" onclick="UserDash.stopTimerFromSidebar(\'' + escAttr(t.id) + '\',\'' + escAttr(currentProjectId) + '\')" style="padding:4px 10px;font-size:.78rem">Stop &amp; Log</button>'
            + '</div>';
        }).join('') + '</div>';
    } catch {}
  }

  async function loadTimesheetEntries() {
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/timesheet', { headers: { 'x-user-session': userSession() } });
      const d = await r.json();
      const entries = d.entries || [];
      const el = document.getElementById('timesheetEntries');
      if (!entries.length) { el.innerHTML = '<div class="empty-state"><p class="empty-desc">No time entries yet</p></div>'; return; }
      el.innerHTML = '<table class="timesheet-table"><thead><tr><th>Date</th><th>Hours</th><th>Description</th><th>By</th><th></th></tr></thead><tbody>'
        + entries.map(e =>
          '<tr><td>' + esc(e.date) + '</td><td>' + e.hours + 'h</td><td>' + esc(e.description || '') + '</td><td>' + esc(e.user_name || '') + '</td>'
          + '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="UserDash.editTimeEntry(\'' + escAttr(e.id) + '\',' + e.hours + ',\'' + escAttr(e.date) + '\',\'' + escAttr(e.description || '') + '\')" style="padding:2px 6px;font-size:0.72rem">Edit</button>'
          + '<button class="btn btn-danger btn-sm" onclick="UserDash.deleteTimeEntry(\'' + escAttr(e.id) + '\')" style="padding:2px 6px;font-size:0.72rem">&times;</button></td></tr>'
        ).join('')
        + '</tbody></table>';
    } catch { /* ignore */ }
  }

  function backToProjectList() {
    currentProjectId = null;
    currentProjectData = null;
    document.getElementById('projectDetailView').classList.add('hidden');
    document.getElementById('projectListView').classList.remove('hidden');
  }

  async function openProjectModal(projectId) {
    document.getElementById('projectEditId').value = projectId || '';
    document.getElementById('projectName').value = '';
    document.getElementById('projectDescription').value = '';
    document.getElementById('projectCode').value = '';
    document.getElementById('projectStatus').value = 'On Track';
    document.getElementById('projectDueDate').value = '';
    // Populate group selector
    var gSel = document.getElementById('projectGroupJid');
    if (gSel) {
      gSel.innerHTML = projectGroupsCache.map(function(g) {
        return '<option value="' + escAttr(g.jid) + '">' + esc(g.name || g.jid) + '</option>';
      }).join('');
    }
    if (projectId) {
      document.getElementById('projectModalTitle').textContent = 'Edit Project';
      const p = currentProjectData || projectsCache.find(p => p.id === projectId);
      if (p) {
        document.getElementById('projectName').value = p.name || '';
        document.getElementById('projectDescription').value = p.description || '';
        document.getElementById('projectCode').value = p.project_code || '';
        document.getElementById('projectStatus').value = p.status || 'On Track';
        document.getElementById('projectDueDate').value = p.due_date || '';
        if (gSel) gSel.value = p.group_jid || '';
      }
      // Hide group selector when editing (can't change group)
      if (gSel) gSel.parentElement.style.display = 'none';
    } else {
      document.getElementById('projectModalTitle').textContent = 'New Project';
      if (gSel) {
        gSel.parentElement.style.display = '';
        // Default to current filter group
        if (currentProjectGroupFilter) gSel.value = currentProjectGroupFilter;
      }
    }
    document.getElementById('projectModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('projectName').focus(), 100);
  }

  async function saveProject() {
    const editId = document.getElementById('projectEditId').value;
    const name = document.getElementById('projectName').value.trim();
    if (!name) { toast('Name is required', 'warning'); return; }
    const body = {
      name,
      description: document.getElementById('projectDescription').value.trim(),
      project_code: document.getElementById('projectCode').value.trim(),
      status: document.getElementById('projectStatus').value,
      due_date: document.getElementById('projectDueDate').value || null,
    };
    if (!editId) {
      var gSel = document.getElementById('projectGroupJid');
      body.group_jid = gSel ? gSel.value : '';
      if (!body.group_jid) { toast('Please select a group', 'warning'); return; }
    }
    try {
      const uid = encodeURIComponent(currentUser.id);
      if (editId) {
        await fetch('/api/projects/' + encodeURIComponent(editId), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify(body) });
        toast('Project updated', 'success');
        openProject(editId);
      } else {
        await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify(body) });
        toast('Project created', 'success');
      }
      document.getElementById('projectModal').classList.add('hidden');
      loadProjects();
    } catch { toast('Failed to save project', 'error'); }
  }

  async function doDeleteProject() {
    if (!currentProjectId || !confirm('Delete this project? This cannot be undone.')) return;
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      toast('Project deleted', 'info');
      backToProjectList();
      loadProjects();
    } catch { toast('Failed to delete', 'error'); }
  }

  async function doCompleteProject() {
    if (!currentProjectId || !confirm('Mark this project as completed?')) return;
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/complete', { method: 'POST', headers: { 'x-user-session': userSession() } });
      toast('Project completed', 'success');
      backToProjectList();
      loadProjects();
    } catch { toast('Failed to complete', 'error'); }
  }

  async function doArchiveProject() {
    if (!currentProjectId) return;
    try {
      // Archive = delete from active (the backend handles it)
      const p = currentProjectData;
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: '{}' });
      // Use the archive endpoint via direct field
      const r = await fetch('/api/projects/' + encodeURIComponent(currentProjectId), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      toast('Project archived', 'info');
      backToProjectList();
      loadProjects();
    } catch { toast('Failed to archive', 'error'); }
  }

  async function showProjectArchive() {
    const el = document.getElementById('projectArchiveList');
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) {
      try {
        const r = await fetch('/api/projects/archive', { headers: { 'x-user-session': userSession() } });
        const d = await r.json();
        const archived = d.projects || [];
        if (!archived.length) { el.innerHTML = '<div class="empty-state"><p class="empty-desc">No archived projects</p></div>'; return; }
        el.innerHTML = '<h3 style="margin:16px 0 8px;font-size:0.9rem;color:var(--text-secondary)">Archived Projects</h3>'
          + archived.map(p =>
            '<div class="project-card archived">'
            + '<div class="project-card-top"><span class="project-card-name">' + esc(p.name) + '</span>'
            + '<button class="btn btn-accent btn-sm" onclick="event.stopPropagation();UserDash.restoreProject(\'' + escAttr(p.id) + '\')">Restore</button></div>'
            + '<div class="project-card-meta">' + (p.completed_at ? 'Completed ' + new Date(p.completed_at).toLocaleDateString() : p.archived_at ? 'Archived ' + new Date(p.archived_at).toLocaleDateString() : '') + '</div>'
            + '</div>'
          ).join('');
      } catch { el.innerHTML = '<div class="empty-state"><p>Failed to load archive</p></div>'; }
    }
  }

  async function restoreProjectById(projectId) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(projectId) + '/restore', { method: 'POST', headers: { 'x-user-session': userSession() } });
      toast('Project restored', 'success');
      showProjectArchive();
      loadProjects();
    } catch { toast('Failed to restore', 'error'); }
  }

  // Project sub-item actions
  async function doToggleDeliverable(id) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/deliverables/' + encodeURIComponent(id) + '/toggle', { method: 'PUT', headers: { 'x-user-session': userSession() } });
      openProject(currentProjectId);
    } catch { toast('Failed to update', 'error'); }
  }

  function doEditDeliverable(id, currentName, currentDue) {
    const body = document.getElementById('projectItemModalBody');
    const title = document.getElementById('projectItemModalTitle');
    const saveBtn = document.getElementById('btnSaveProjectItem');
    title.textContent = 'Edit Deliverable';
    body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Name</label><input type="text" class="wt-field-input" id="itemName" value="' + escAttr(currentName) + '"></div>'
      + '<div class="wt-field"><label class="wt-field-label">Due Date</label><input type="date" class="wt-field-input" id="itemDueDate" value="' + escAttr(currentDue) + '"></div>';
    saveBtn.onclick = async function() {
      const name = document.getElementById('itemName').value.trim();
      if (!name) { toast('Name required', 'warning'); return; }
      try {
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/deliverables/' + encodeURIComponent(id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
          body: JSON.stringify({ name, due_date: document.getElementById('itemDueDate').value || null })
        });
        document.getElementById('projectItemModal').classList.add('hidden');
        openProject(currentProjectId);
      } catch { toast('Failed to update', 'error'); }
    };
    document.getElementById('projectItemModal').classList.remove('hidden');
    setTimeout(function() { document.getElementById('itemName').focus(); }, 50);
  }

  async function doDeleteDeliverable(id) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/deliverables/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      openProject(currentProjectId);
    } catch { toast('Failed to delete', 'error'); }
  }

  async function doDeleteBlocker(id) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/blockers/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      openProject(currentProjectId);
    } catch { toast('Failed to delete', 'error'); }
  }

  async function doDeletePriority(id) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/priorities/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      openProject(currentProjectId);
    } catch { toast('Failed to delete', 'error'); }
  }

  async function doDeleteTimeEntry(id) {
    try {
      await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/timesheet/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-user-session': userSession() } });
      openProject(currentProjectId);
    } catch { toast('Failed to delete', 'error'); }
  }

  function editTimeEntry(id, hours, date, description) {
    openProjectItemModal('edit_time');
    // Populate after modal renders
    setTimeout(function() {
      const dateEl = document.getElementById('itemDate');
      const hoursEl = document.getElementById('itemHours');
      const descEl = document.getElementById('itemDesc');
      if (dateEl) dateEl.value = date;
      if (hoursEl) hoursEl.value = hours;
      if (descEl) descEl.value = description;
      document.getElementById('btnSaveProjectItem').onclick = async function() {
        const newHours = parseFloat(document.getElementById('itemHours').value);
        if (!newHours || newHours <= 0) { toast('Hours required', 'warning'); return; }
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/timesheet/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() },
          body: JSON.stringify({ date: document.getElementById('itemDate').value, hours: newHours, description: document.getElementById('itemDesc').value.trim() })
        });
        document.getElementById('projectItemModal').classList.add('hidden');
        toast('Time entry updated', 'success');
        openProject(currentProjectId);
      };
    }, 50);
  }

  function openProjectItemModal(type) {
    const body = document.getElementById('projectItemModalBody');
    const title = document.getElementById('projectItemModalTitle');
    const saveBtn = document.getElementById('btnSaveProjectItem');
    if (type === 'deliverable') {
      title.textContent = 'Add Deliverable';
      body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Name</label><input type="text" class="wt-field-input" id="itemName" placeholder="Deliverable name..."></div>'
        + '<div class="wt-field"><label class="wt-field-label">Due Date</label><input type="date" class="wt-field-input" id="itemDueDate"></div>';
      saveBtn.onclick = async function() {
        const name = document.getElementById('itemName').value.trim();
        if (!name) return;
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/deliverables', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify({ name, due_date: document.getElementById('itemDueDate').value || null }) });
        document.getElementById('projectItemModal').classList.add('hidden');
        openProject(currentProjectId);
      };
    } else if (type === 'blocker') {
      title.textContent = 'Add Blocker';
      body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Blocker</label><input type="text" class="wt-field-input" id="itemName" placeholder="What is blocking progress?"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Severity</label><select class="wt-field-input" id="itemSeverity"><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>';
      saveBtn.onclick = async function() {
        const blocker = document.getElementById('itemName').value.trim();
        if (!blocker) return;
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/blockers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify({ blocker, severity: document.getElementById('itemSeverity').value }) });
        document.getElementById('projectItemModal').classList.add('hidden');
        openProject(currentProjectId);
      };
    } else if (type === 'priority') {
      title.textContent = 'Add Priority';
      body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Priority</label><input type="text" class="wt-field-input" id="itemName" placeholder="Priority item..."></div>'
        + '<div class="wt-field"><label class="wt-field-label">Impact</label><select class="wt-field-input" id="itemImpact"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select></div>';
      saveBtn.onclick = async function() {
        const item = document.getElementById('itemName').value.trim();
        if (!item) return;
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/priorities', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify({ item, impact: document.getElementById('itemImpact').value }) });
        document.getElementById('projectItemModal').classList.add('hidden');
        openProject(currentProjectId);
      };
    } else if (type === 'time') {
      title.textContent = 'Log Time';
      const today = new Date().toISOString().split('T')[0];
      body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Date</label><input type="date" class="wt-field-input" id="itemDate" value="' + today + '"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Hours</label><input type="number" class="wt-field-input" id="itemHours" step="0.25" min="0.25" placeholder="1.5"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Description</label><input type="text" class="wt-field-input" id="itemDesc" placeholder="What did you work on?"></div>';
      saveBtn.onclick = async function() {
        const hours = parseFloat(document.getElementById('itemHours').value);
        if (!hours || hours <= 0) { toast('Hours required', 'warning'); return; }
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/timesheet', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify({ date: document.getElementById('itemDate').value, hours, description: document.getElementById('itemDesc').value.trim() }) });
        document.getElementById('projectItemModal').classList.add('hidden');
        openProject(currentProjectId);
      };
    } else if (type === 'edit_time') {
      title.textContent = 'Edit Time Entry';
      const today = new Date().toISOString().split('T')[0];
      body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Date</label><input type="date" class="wt-field-input" id="itemDate" value="' + today + '"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Hours</label><input type="number" class="wt-field-input" id="itemHours" step="0.25" min="0.25"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Description</label><input type="text" class="wt-field-input" id="itemDesc"></div>';
      // Save handler is set by editTimeEntry after modal opens
    } else if (type === 'financials') {
      title.textContent = 'Edit Financials';
      const f = currentProjectData.financials || {};
      body.innerHTML = '<div class="wt-field"><label class="wt-field-label">Budget</label><input type="number" class="wt-field-input" id="itemBudget" value="' + (f.budget || 0) + '"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Spent</label><input type="number" class="wt-field-input" id="itemSpent" value="' + (f.spent || 0) + '"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Revenue</label><input type="number" class="wt-field-input" id="itemRevenue" value="' + (f.revenue || 0) + '"></div>'
        + '<div class="wt-field"><label class="wt-field-label">Notes</label><textarea class="wt-field-input wt-textarea" id="itemNotes">' + esc(f.notes || '') + '</textarea></div>';
      saveBtn.onclick = async function() {
        await fetch('/api/projects/' + encodeURIComponent(currentProjectId) + '/financials', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-session': userSession() }, body: JSON.stringify({ budget: parseFloat(document.getElementById('itemBudget').value) || 0, spent: parseFloat(document.getElementById('itemSpent').value) || 0, revenue: parseFloat(document.getElementById('itemRevenue').value) || 0, notes: document.getElementById('itemNotes').value.trim() }) });
        document.getElementById('projectItemModal').classList.add('hidden');
        openProject(currentProjectId);
      };
    }
    document.getElementById('projectItemModal').classList.remove('hidden');
    setTimeout(() => { const inp = document.getElementById('itemName') || document.getElementById('itemBudget') || document.getElementById('itemDate'); if (inp) inp.focus(); }, 100);
  }

  // pushTaskNotification removed — projects use inline notifications

  // --- Unread message tracking ---
  let unreadPollInterval = null;

  function startUnreadPolling() {
    if (unreadPollInterval) return;
    pollUnreads();
    unreadPollInterval = setInterval(pollUnreads, 5000);
  }

  function stopUnreadPolling() {
    if (unreadPollInterval) { clearInterval(unreadPollInterval); unreadPollInterval = null; }
  }

  // Resume polling with an immediate refresh when the tab becomes visible again.
  document.addEventListener('visibilitychange', function() {
    if (document.hidden || !currentUser) return;
    chatErrorStreak = 0;
    chatBackoffUntil = 0;
    if (currentView === 'chat') pollChat();
    refreshSidebarStatus();
    pollUnreads();
    fetchNotifications();
    syncTypingIndicatorForSession();
  });

  async function pollUnreads() {
    if (document.hidden) return; // paused while tab is hidden
    if (!currentUser) return;
    const sessions = currentUser.allowed_sessions || [];
    const now = new Date().toISOString();
    // Initialize any session we've never seen to "now" so we don't count old messages
    let changed = false;
    for (const jid of sessions) {
      if (!lastSeenTimestamps[jid]) {
        lastSeenTimestamps[jid] = now;
        changed = true;
      }
    }
    if (changed) localStorage.setItem('dockbox-last-seen', JSON.stringify(lastSeenTimestamps));

    let totalUnread = 0;
    for (const jid of sessions) {
      if (jid === currentSession && currentView === 'chat') continue;
      const since = lastSeenTimestamps[jid];
      try {
        const r = await fetch('/api/messages?jid=' + encodeURIComponent(jid) + '&since=' + encodeURIComponent(since) + '&limit=50');
        const d = await r.json();
        const botMsgs = (d.messages || []).filter(m => m.is_bot_message);
        unreadSessions[jid] = botMsgs.length;
        totalUnread += botMsgs.length;
      } catch {}
    }
    notifCount = totalUnread + pingNotifCount;
    updateNotifBadge();
    updateSessionUnreadDots();
  }

  function markSessionRead(jid) {
    lastSeenTimestamps[jid] = new Date().toISOString();
    localStorage.setItem('dockbox-last-seen', JSON.stringify(lastSeenTimestamps));
    unreadSessions[jid] = 0;
  }

  function updateSessionUnreadDots() {}

  // Old work task functions removed — replaced by project management above

  // --- Automations ---

  const AUTO_TEMPLATES = [
    // Daily
    { icon: '☀️', label: 'Morning briefing (8am)', time: '08:00', action: 'Send me a morning update: what I need to do today, anything overdue, and messages I haven\'t replied to.' },
    { icon: '🌙', label: 'End-of-day summary (5pm)', time: '17:00', action: 'Wrap up my day: what got done, what\'s still open, and suggest what to focus on tomorrow.' },
    { icon: '⚠️', label: 'Overdue task alert (9am)', time: '09:00', action: 'Check for any tasks that are overdue or due today and remind me about them.' },
    { icon: '📧', label: 'Missed message check (10am)', time: '10:00', action: 'Look through the last 24 hours of messages and tell me if there\'s anything I haven\'t responded to.' },

    // Weekly
    { icon: '📊', label: 'Weekly report (Fri 4pm)', time: '16:00', action: 'Write my weekly summary: what I accomplished, what\'s in progress, any problems, and plans for next week.' },
    { icon: '📅', label: 'Week preview (Mon 8am)', time: '08:00', action: 'Show me everything due this week, day by day. Flag anything that might be late.' },
    { icon: '🤝', label: 'Follow-up reminders (Mon 9am)', time: '09:00', action: 'Check who I haven\'t contacted in over a week and suggest follow-up messages for each person.' },
    { icon: '📰', label: 'News update (Mon 8am)', time: '08:00', action: 'Search for the latest news in [your industry] and send me a summary of the top stories.' },

    // Monthly
    { icon: '💸', label: 'Monthly expenses (1st)', time: '09:00', action: 'Add up all expenses from this month by category and compare to last month.' },
    { icon: '📈', label: 'Monthly review (1st)', time: '10:00', action: 'Review what I accomplished this month, how many tasks I completed, and where I can improve.' },
    { icon: '🎯', label: 'Old task cleanup (15th)', time: '09:00', action: 'Find any tasks that haven\'t been touched in 30+ days and ask me what to do with each one.' },
    { icon: '💰', label: 'Unpaid invoice check (1st)', time: '09:00', action: 'Check for any invoices that haven\'t been paid in 30+ days and draft friendly follow-up messages.' },

    // Other
    { icon: '🔍', label: 'Competitor check (Wed)', time: '08:00', action: 'Look up recent news about [competitor names] and tell me anything important.' },
    { icon: '🔔', label: 'Custom reminder', time: '09:00', action: 'Remind me to [what you need to remember].' },
  ];

  function renderAutoTemplates() {
    const grid = document.getElementById('autoTemplatesGrid');
    grid.innerHTML = AUTO_TEMPLATES.map((t, i) =>
      `<button class="auto-template-btn" onclick="UserDash.useAutoTemplate(${i})" title="${escAttr(t.action)}">${t.icon} ${esc(t.label)}</button>`
    ).join('');
  }

  function useAutoTemplate(index) {
    const t = AUTO_TEMPLATES[index];
    document.getElementById('autoForm').classList.remove('hidden');
    document.getElementById('autoActionInput').value = t.action;
    if (t.time) document.getElementById('autoTimeInput').value = t.time;
    document.getElementById('autoActionInput').focus();
  }

  async function loadAutomations() {
    if (!currentUser) return;
    try {
      const userR = await fetch('/api/automations');
      const userData = await userR.json();
      const userTasks = (userData.tasks || []).map(t => ({ ...t, _source: 'user' }));
      const cronTasks = (userData.scheduledTasks || []).map(t => ({
        id: t.id,
        action: t.prompt,
        time: t.schedule_value,
        enabled: t.status === 'active',
        last_run: t.last_run,
        _source: 'cron',
        _scheduleType: t.schedule_type,
        _group: t.group_folder,
        _nextRun: t.next_run,
      }));
      renderAutomations(userTasks, cronTasks);
    } catch (e) {
      console.error('loadAutomations error:', e);
      document.getElementById('autoList').innerHTML = '<div class="empty-state"><p class="empty-title">Unable to load automations</p></div>';
    }
  }

  function cronToHuman(cron) {
    if (!cron || typeof cron !== 'string') return cron || '--';
    var parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return cron;
    var min = parts[0], hour = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Format time
    var time = '';
    if (hour !== '*' && min !== '*') {
      var h = parseInt(hour), m = parseInt(min);
      var ampm = h >= 12 ? 'PM' : 'AM';
      var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      time = h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    } else if (hour !== '*') {
      var h = parseInt(hour);
      var ampm = h >= 12 ? 'PM' : 'AM';
      var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      time = h12 + ':00 ' + ampm;
    }

    // Every N minutes
    if (min.startsWith('*/')) return 'Every ' + min.slice(2) + ' min';
    if (hour.startsWith('*/')) return 'Every ' + hour.slice(2) + ' hours';

    // Specific days of week
    if (dom === '*' && mon === '*' && dow !== '*') {
      var days = dow.split(',').map(function(d) { return dayNames[parseInt(d)] || d; }).join(', ');
      if (dow === '1-5') days = 'Weekdays';
      if (dow === '0,6') days = 'Weekends';
      return time ? days + ' at ' + time : days;
    }

    // Daily
    if (dom === '*' && mon === '*' && dow === '*') {
      return time ? 'Daily at ' + time : 'Daily';
    }

    // Specific day of month
    if (dom !== '*' && mon === '*') {
      return time ? 'Monthly on the ' + dom + ordSuffix(parseInt(dom)) + ' at ' + time : 'Monthly on the ' + dom + ordSuffix(parseInt(dom));
    }

    return time || cron;
  }

  function ordSuffix(n) {
    if (n >= 11 && n <= 13) return 'th';
    switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
  }

  function renderAutomations(userTasks, cronTasks) {
    const el = document.getElementById('autoList');
    cronTasks = cronTasks || [];
    userTasks = userTasks || [];
    if (userTasks.length === 0 && cronTasks.length === 0) {
      el.innerHTML = '<div class="empty-state"><p class="empty-title">No scheduled tasks yet</p><p class="empty-desc">Set up a daily task for your assistant to do automatically.</p></div>';
      return;
    }
    let html = '';

    if (cronTasks.length > 0) {
      html += '<div class="auto-section-label" style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary);margin-bottom:8px;">System Schedules</div>';
      html += cronTasks.map(t => {
        const disabledClass = t.enabled ? '' : ' disabled';
        const lastRun = t.last_run ? 'Last: ' + new Date(t.last_run).toLocaleString() : 'Never run';
        const nextRun = t._nextRun ? 'Next: ' + new Date(t._nextRun).toLocaleString() : '';
        const typeLabel = t._scheduleType === 'cron' ? cronToHuman(t.time) : t._scheduleType;
        return `
          <div class="auto-card${disabledClass}" style="border-left:3px solid var(--color-primary)">
            <div class="auto-time" title="${escAttr(t._scheduleType)}">${esc(typeLabel || '--')}</div>
            <div class="auto-action">
              <span class="auto-action-prefix">${esc(t._group || 'system')}:</span> ${esc(t.action)}
              <div class="auto-last-run">${esc(lastRun)}${nextRun ? ' &middot; ' + esc(nextRun) : ''}</div>
            </div>
            <div class="auto-controls">
              <span class="badge" style="font-size:0.7rem;padding:2px 6px;background:var(--color-primary);color:#fff;border-radius:4px;">${esc(t._scheduleType)}</span>
              <label class="toggle">
                <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="UserDash.toggleAutomation('${escAttr(t.id)}', this.checked)">
                <span class="toggle-slider"></span>
              </label>
              <button class="btn btn-danger btn-sm" onclick="UserDash.deleteAutomation('${escAttr(t.id)}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    if (userTasks.length > 0) {
      if (cronTasks.length > 0) {
        html += '<div class="auto-section-label" style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary);margin:16px 0 8px;">Your Automations</div>';
      }
      html += userTasks.map(t => {
        const checked = t.enabled ? 'checked' : '';
        const disabledClass = t.enabled ? '' : ' disabled';
        const lastRun = t.last_run ? 'Last run: ' + new Date(t.last_run).toLocaleString() : 'Never run';
        return `
          <div class="auto-card${disabledClass}">
            <div class="auto-time">${esc(cronToHuman(t.time) || '--:--')}</div>
            <div class="auto-action">
              <span class="auto-action-prefix">DO:</span>${esc(t.action)}
              <div class="auto-last-run">${esc(lastRun)}</div>
            </div>
            <div class="auto-controls">
              <label class="toggle">
                <input type="checkbox" ${checked} onchange="UserDash.toggleAutomation('${escAttr(t.id)}', this.checked)">
                <span class="toggle-slider"></span>
              </label>
              <button class="btn btn-danger btn-sm" onclick="UserDash.deleteAutomation('${escAttr(t.id)}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    el.innerHTML = html;
  }

  function showAutoForm() {
    document.getElementById('autoForm').classList.remove('hidden');
    document.getElementById('autoTimeInput').value = '';
    document.getElementById('autoActionInput').value = '';
    document.getElementById('autoActionInput').focus();
  }

  function hideAutoForm() {
    document.getElementById('autoForm').classList.add('hidden');
  }

  async function createAutomation() {
    const time = document.getElementById('autoTimeInput').value;
    const action = document.getElementById('autoActionInput').value.trim();
    const modelSel = document.getElementById('autoModelSelect');
    const model = modelSel ? modelSel.value : '';
    if (!time || !action) {
      toast('Please set a time and action', 'warning');
      return;
    }
    try {
      await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time, action, model })
      });
      hideAutoForm();
      toast('Automation created', 'success');
      loadAutomations();
    } catch {
      toast('Failed to create automation', 'error');
    }
  }

  async function toggleAutomation(taskId, enabled) {
    try {
      await fetch('/api/automations/' + encodeURIComponent(taskId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
    } catch {
      toast('Failed to update automation', 'error');
      loadAutomations();
    }
  }

  async function deleteAutomation(taskId) {
    if (!confirm('Delete this automation?')) return;
    try {
      await fetch('/api/automations/' + encodeURIComponent(taskId), {
        method: 'DELETE'
      });
      toast('Automation deleted', 'info');
      loadAutomations();
    } catch {
      toast('Failed to delete automation', 'error');
    }
  }

  // --- Calendar ---

  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth();
  let calEvents = [];
  let calSelectedDate = null;
  let calEditingEvent = null;
  let calViewMode = 'month';

  var calSourceFilter = 'all';
  var providerCalendars = {}; // { oauthAccountId: [ {id, name, primary, color}, ... ] }

  async function fetchProviderCalendars() {
    var calAccounts = getCalendarOAuthAccounts();
    for (var i = 0; i < calAccounts.length; i++) {
      var a = calAccounts[i];
      try {
        var r = await fetch('/api/oauth/accounts/' + encodeURIComponent(a.id) + '/calendars', {
          headers: { 'X-User-Session': localStorage.getItem('dockbox-user-session') || '' }
        });
        var d = await r.json();
        if (d.ok && d.calendars) providerCalendars[a.id] = d.calendars;
      } catch {}
    }
  }

  function updateCalSourceFilter() {
    var sel = document.getElementById('calSourceFilter');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '<option value="all">All Calendars</option><option value="local">Local Only</option>';
    var calAccounts = getCalendarOAuthAccounts();
    calAccounts.forEach(function(a) {
      var provLabel = a.provider === 'google' ? 'Google' : 'Outlook';
      var cals = providerCalendars[a.id] || [];
      if (cals.length > 0) {
        // Show each individual calendar
        cals.forEach(function(c) {
          var label = provLabel + ': ' + c.name;
          var val = a.id + '/' + c.id;
          sel.innerHTML += '<option value="' + val + '">' + label + '</option>';
        });
      } else {
        // Fallback: show provider as a whole
        sel.innerHTML += '<option value="' + a.id + '/all">' + provLabel + (a.email ? ' (' + a.email + ')' : '') + '</option>';
      }
    });
    if (current && sel.querySelector('option[value="' + CSS.escape(current) + '"]')) sel.value = current;
    else sel.value = 'all';
    calSourceFilter = sel.value;
  }

  function getFilteredCalEvents() {
    if (calSourceFilter === 'all') return calEvents;
    if (calSourceFilter === 'local') return calEvents.filter(function(e) { return !e.calendar_source || e.calendar_source === 'local'; });
    // Filter by specific provider calendar: "accountId/calendarId"
    var parts = calSourceFilter.split('/');
    var accountId = parts[0];
    var calId = parts.slice(1).join('/'); // calendar IDs can contain slashes
    if (calId === 'all') {
      // All calendars from this account
      var account = oauthAccounts.find(function(a) { return a.id === accountId; });
      if (!account) return calEvents;
      var source = account.provider === 'google' ? 'google' : 'outlook';
      return calEvents.filter(function(e) { return e.calendar_source === source || e.calendar_source === account.provider; });
    }
    // Specific calendar within an account
    return calEvents.filter(function(e) { return e.provider_calendar_id === calId; });
  }

  async function loadCalendarEvents() {
    const start = new Date(calYear, calMonth, 1).toISOString();
    const end = new Date(calYear, calMonth + 1, 0, 23, 59, 59).toISOString();
    try {
      const r = await fetch(`/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      const d = await r.json();
      calEvents = d.events || [];
    } catch {
      calEvents = [];
    }
    // Fetch OAuth accounts for push buttons, source filter, and provider calendars
    await fetchOAuthAccounts();
    await fetchProviderCalendars();
    updateCalSourceFilter();
    updateCalPushAllButton();
    renderCalendar();
  }

  function renderCalendar() {
    const title = document.getElementById('calendarTitle');
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    title.textContent = months[calMonth] + ' ' + calYear;

    if (calViewMode === 'week') {
      renderWeekView();
      return;
    }

    const grid = document.getElementById('calendarGrid');
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const daysInPrev = new Date(calYear, calMonth, 0).getDate();
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

    let html = '<div class="cal-grid">';
    days.forEach(d => { html += '<div class="cal-header-cell">' + d + '</div>'; });

    // Previous month trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = daysInPrev - i;
      html += '<div class="cal-cell other-month"><span class="cal-cell-day">' + day + '</span></div>';
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = calYear + '-' + String(calMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
      const isToday = dateStr === todayStr;
      const isSelected = calSelectedDate === dateStr;
      const cls = 'cal-cell' + (isToday ? ' today' : '') + (isSelected ? ' selected' : '');
      const dayEvents = getFilteredCalEvents().filter(e => e.start_time && e.start_time.slice(0,10) === dateStr);
      html += '<div class="' + cls + '" data-date="' + dateStr + '">';
      html += '<span class="cal-cell-day">' + d + '</span>';
      dayEvents.slice(0, 3).forEach(ev => {
        const bg = ev.color || 'var(--accent)';
        let dotBadge = '';
        if (ev.calendar_source === 'google') dotBadge = providerBadge('google', 12);
        else if (ev.calendar_source === 'outlook' || ev.calendar_source === 'microsoft') dotBadge = providerBadge('microsoft', 12);
        html += '<span class="cal-event-dot" style="background:' + bg + '" data-id="' + ev.id + '">' + dotBadge + esc(ev.title) + '</span>';
      });
      if (dayEvents.length > 3) html += '<span style="font-size:10px;color:var(--text-secondary)">+' + (dayEvents.length - 3) + ' more</span>';
      html += '</div>';
    }

    // Fill remaining cells
    const totalCells = firstDay + daysInMonth;
    const remainder = totalCells % 7;
    if (remainder > 0) {
      for (let i = 1; i <= 7 - remainder; i++) {
        html += '<div class="cal-cell other-month"><span class="cal-cell-day">' + i + '</span></div>';
      }
    }
    html += '</div>';
    grid.innerHTML = html;

    // Click handlers
    grid.querySelectorAll('.cal-cell:not(.other-month)').forEach(cell => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.cal-event-dot')) return;
        const date = cell.dataset.date;
        calSelectedDate = date;
        renderCalendar();
        showDayEvents(date);
      });
    });
    grid.querySelectorAll('.cal-event-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const ev = calEvents.find(x => x.id === dot.dataset.id);
        if (ev) openCalEventModal(ev);
      });
    });

    if (calSelectedDate) showDayEvents(calSelectedDate);
  }

  function renderWeekView() {
    const grid = document.getElementById('calendarGrid');
    const today = new Date();
    // Find the start of the week containing the selected date or today
    const ref = calSelectedDate ? new Date(calSelectedDate + 'T12:00:00') : new Date(calYear, calMonth, today.getDate());
    const startOfWeek = new Date(ref);
    startOfWeek.setDate(ref.getDate() - ref.getDay());

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + i);
      days.push(d);
    }

    const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    let html = '<div class="cal-week-grid">';
    // Header row
    html += '<div class="cal-week-time"></div>';
    days.forEach(d => {
      const ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      const isToday = ds === todayStr;
      html += '<div class="cal-header-cell' + (isToday ? ' today-col' : '') + '">' + dayNames[d.getDay()] + ' ' + d.getDate() + '</div>';
    });

    // Hour rows (8am to 8pm)
    for (let h = 8; h <= 20; h++) {
      const label = h <= 12 ? h + (h < 12 ? 'am' : 'pm') : (h - 12) + 'pm';
      html += '<div class="cal-week-time">' + label + '</div>';
      days.forEach(d => {
        const ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        const isToday = ds === todayStr;
        const hourEvents = getFilteredCalEvents().filter(e => {
          if (!e.start_time || !e.start_time.startsWith(ds)) return false;
          const eh = new Date(e.start_time).getHours();
          return eh === h;
        });
        html += '<div class="cal-week-cell' + (isToday ? ' today-col' : '') + '" data-date="' + ds + '" data-hour="' + h + '">';
        hourEvents.forEach(ev => {
          const bg = ev.color || 'var(--accent)';
          html += '<span class="cal-event-dot" style="background:' + bg + '" data-id="' + ev.id + '">' + esc(ev.title) + '</span>';
        });
        html += '</div>';
      });
    }
    html += '</div>';
    grid.innerHTML = html;

    grid.querySelectorAll('.cal-week-cell').forEach(cell => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.cal-event-dot')) return;
        calSelectedDate = cell.dataset.date;
        const h = cell.dataset.hour;
        openCalEventModal(null, calSelectedDate, parseInt(h));
      });
    });
    grid.querySelectorAll('.cal-event-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const ev = calEvents.find(x => x.id === dot.dataset.id);
        if (ev) openCalEventModal(ev);
      });
    });
  }

  function showDayEvents(dateStr) {
    const panel = document.getElementById('calDayEvents');
    const title = document.getElementById('calDayTitle');
    const list = document.getElementById('calDayEventList');
    const dayEvents = getFilteredCalEvents().filter(e => e.start_time && e.start_time.slice(0,10) === dateStr);

    const d = new Date(dateStr + 'T12:00:00');
    title.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    if (dayEvents.length === 0) {
      list.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:8px 0">No events. Click "+ Event" to create one.</div>';
    } else {
      const calAccounts = getCalendarOAuthAccounts();
      list.innerHTML = dayEvents.map(ev => {
        const time = ev.all_day ? 'All day' : new Date(ev.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const border = ev.color || 'var(--accent)';
        // Provider badge for synced events
        let badge = '';
        if (ev.calendar_source === 'google') badge = providerBadge('google', 16);
        else if (ev.calendar_source === 'outlook' || ev.calendar_source === 'microsoft') badge = providerBadge('microsoft', 16);
        // Push button for local events
        let pushHtml = '';
        if (ev.calendar_source === 'local' && calAccounts.length > 0) {
          if (calAccounts.length === 1) {
            const label = calAccounts[0].provider === 'google' ? 'Push to Google' : 'Push to Outlook';
            pushHtml = '<button class="push-btn" data-event-id="' + escAttr(ev.id) + '" data-acct-id="' + escAttr(calAccounts[0].id) + '">' + label + '</button>';
          } else {
            pushHtml = '<button class="push-btn push-btn-multi" data-event-id="' + escAttr(ev.id) + '">Push...</button>';
          }
        }
        return '<div class="cal-event-card" data-id="' + ev.id + '" style="border-left-color:' + border + '">'
          + '<span class="cal-event-time">' + time + ' ' + badge + '</span>'
          + '<div class="cal-event-info">'
          + '<div class="cal-event-name">' + esc(ev.title) + '</div>'
          + (ev.description ? '<div class="cal-event-desc">' + esc(ev.description) + '</div>' : '')
          + (ev.location ? '<div class="cal-event-loc">' + esc(ev.location) + '</div>' : '')
          + '</div>'
          + pushHtml
          + '</div>';
      }).join('');
    }
    panel.classList.remove('hidden');

    // Bind push buttons
    list.querySelectorAll('.push-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const eventId = btn.dataset.eventId;
        const acctId = btn.dataset.acctId;
        if (acctId) {
          pushCalendarEvent(eventId, acctId);
        } else {
          // Multi-provider dropdown
          const calAccounts = getCalendarOAuthAccounts();
          showPushDropdown(btn, calAccounts, (selectedAcctId) => pushCalendarEvent(eventId, selectedAcctId));
        }
      });
    });

    list.querySelectorAll('.cal-event-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.push-btn')) return;
        const ev = calEvents.find(x => x.id === card.dataset.id);
        if (ev) openCalEventModal(ev);
      });
    });
  }

  function openCalEventModal(event, dateStr, hour) {
    calEditingEvent = event || null;
    document.getElementById('calEventModalTitle').textContent = event ? 'Edit Event' : 'New Event';
    document.getElementById('btnCalEventDelete').classList.toggle('hidden', !event);

    if (event) {
      document.getElementById('calEventTitle').value = event.title || '';
      document.getElementById('calEventDesc').value = event.description || '';
      document.getElementById('calEventLocation').value = event.location || '';
      document.getElementById('calEventColor').value = event.color || '';
      document.getElementById('calEventAllDay').checked = event.all_day === 1;
      document.getElementById('calEventTask').value = event.work_task_id || '';
      if (event.start_time) {
        document.getElementById('calEventStart').value = event.start_time.slice(0, 16);
      }
      if (event.end_time) {
        document.getElementById('calEventEnd').value = event.end_time.slice(0, 16);
      }
    } else {
      document.getElementById('calEventTitle').value = '';
      document.getElementById('calEventDesc').value = '';
      document.getElementById('calEventLocation').value = '';
      document.getElementById('calEventColor').value = '';
      document.getElementById('calEventAllDay').checked = false;
      document.getElementById('calEventTask').value = '';
      const dt = dateStr || calSelectedDate || new Date().toISOString().slice(0, 10);
      const h = hour !== undefined ? String(hour).padStart(2, '0') : '09';
      document.getElementById('calEventStart').value = dt + 'T' + h + ':00';
      document.getElementById('calEventEnd').value = dt + 'T' + String(Math.min(23, parseInt(h) + 1)).padStart(2, '0') + ':00';
    }

    // Populate task dropdown
    populateCalTaskDropdown();
    document.getElementById('calEventModal').classList.remove('hidden');
  }

  async function populateCalTaskDropdown() {
    const sel = document.getElementById('calEventTask');
    const current = sel.value;
    try {
      const r = await fetch('/api/work-tasks');
      const d = await r.json();
      sel.innerHTML = '<option value="">None</option>';
      (d.tasks || []).forEach(t => {
        sel.innerHTML += '<option value="' + t.id + '">' + esc(t.title) + '</option>';
      });
      sel.value = current;
    } catch {}
  }

  async function saveCalendarEvent() {
    const title = document.getElementById('calEventTitle').value.trim();
    if (!title) { toast('Title is required', 'error'); return; }

    const payload = {
      title,
      description: document.getElementById('calEventDesc').value,
      start_time: new Date(document.getElementById('calEventStart').value).toISOString(),
      end_time: document.getElementById('calEventEnd').value ? new Date(document.getElementById('calEventEnd').value).toISOString() : null,
      all_day: document.getElementById('calEventAllDay').checked,
      location: document.getElementById('calEventLocation').value,
      color: document.getElementById('calEventColor').value,
      work_task_id: document.getElementById('calEventTask').value || null,
      created_by: currentUser ? currentUser.id : '',
    };

    try {
      if (calEditingEvent) {
        await fetch('/api/calendar/events/' + calEditingEvent.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Event updated', 'success');
      } else {
        await fetch('/api/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Event created', 'success');
      }
      document.getElementById('calEventModal').classList.add('hidden');
      calEditingEvent = null;
      loadCalendarEvents();
    } catch {
      toast('Failed to save event', 'error');
    }
  }

  async function deleteCalendarEvent_() {
    if (!calEditingEvent || !confirm('Delete this event?')) return;
    try {
      await fetch('/api/calendar/events/' + calEditingEvent.id, { method: 'DELETE' });
      toast('Event deleted', 'success');
      document.getElementById('calEventModal').classList.add('hidden');
      calEditingEvent = null;
      loadCalendarEvents();
    } catch {
      toast('Failed to delete event', 'error');
    }
  }

  let _calendarToken = '';

  // Load per-user calendar token
  async function loadCalendarToken() {
    if (!currentUser) return;
    try {
      const r = await fetch('/api/calendar-token');
      if (r.ok) { const d = await r.json(); _calendarToken = d.token || ''; }
    } catch {}
  }

  function calExport() {
    const userId = currentUser ? currentUser.id : '';
    const tokenParam = _calendarToken ? '?token=' + encodeURIComponent(_calendarToken) : '';
    const userUrl = window.location.origin + '/api/calendar/export.ics' + tokenParam;
    const allUrl = window.location.origin + '/api/calendar/export.ics' + tokenParam;

    const existing = document.getElementById('calExportPanel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.id = 'calExportPanel';
    panel.className = 'cal-export-panel';
    panel.innerHTML = '<div style="font-weight:600;margin-bottom:10px">Subscribe to Calendar</div>'
      + '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Your calendar (Google Cal &rarr; Add by URL):</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:12px"><input type="text" readonly value="' + escAttr(userUrl) + '" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface-raised,#f1f5f9);color:var(--text-primary)" id="calExportUserUrl"><button class="btn btn-accent btn-sm" onclick="navigator.clipboard.writeText(document.getElementById(\'calExportUserUrl\').value);this.textContent=\'Copied!\';setTimeout(()=>this.textContent=\'Copy\',1500)">Copy</button></div>'
      + '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">All events (team-wide):</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:12px"><input type="text" readonly value="' + escAttr(allUrl) + '" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface-raised,#f1f5f9);color:var(--text-primary)" id="calExportAllUrl"><button class="btn btn-accent btn-sm" onclick="navigator.clipboard.writeText(document.getElementById(\'calExportAllUrl\').value);this.textContent=\'Copied!\';setTimeout(()=>this.textContent=\'Copy\',1500)">Copy</button></div>'
      + '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">Calendar token (for external access):</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:12px"><input type="text" value="' + escAttr(_calendarToken) + '" placeholder="Paste or generate a token" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface-raised,#f1f5f9);color:var(--text-primary)" id="calTokenInput"><button class="btn btn-ghost btn-sm" id="calTokenGenBtn">Generate</button><button class="btn btn-accent btn-sm" id="calTokenSaveBtn">Save</button></div>'
      + (!_calendarToken ? '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px">Set a token to enable Google Calendar / Apple Calendar subscriptions.</div>' : '')
      + '<div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" onclick="window.open(\'/api/calendar/export.ics' + escAttr(tokenParam) + '\')">Download .ics</button><button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'calExportPanel\').remove()">Close</button></div>';

    // Generate random token
    panel.querySelector('#calTokenGenBtn').addEventListener('click', function() {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      panel.querySelector('#calTokenInput').value = hex;
    });

    // Save token
    panel.querySelector('#calTokenSaveBtn').addEventListener('click', async function() {
      const token = panel.querySelector('#calTokenInput').value.trim();
      try {
        const r = await fetch('/api/calendar-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token })
        });
        if (r.ok) {
          _calendarToken = token;
          toast('Calendar token saved', 'success');
          panel.remove();
        } else { toast('Failed to save token', 'error'); }
      } catch { toast('Failed to save token', 'error'); }
    });

    const wrap = document.getElementById('btnCalExport').parentElement;
    wrap.style.position = 'relative';
    wrap.appendChild(panel);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function closer(e) {
        if (!panel.contains(e.target) && e.target.id !== 'btnCalExport') {
          panel.remove();
          document.removeEventListener('click', closer);
        }
      });
    }, 0);
  }

  function calImport() {
    document.getElementById('calImportModal').classList.remove('hidden');
  }

  async function handleCalImport(file) {
    if (!file) return;
    const status = document.getElementById('calImportStatus');
    status.textContent = 'Importing...';
    try {
      const text = await file.text();
      const r = await fetch('/api/calendar/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/calendar' },
        body: text,
      });
      const d = await r.json();
      status.textContent = 'Imported ' + (d.imported || 0) + ' events.';
      toast('Imported ' + (d.imported || 0) + ' events', 'success');
      loadCalendarEvents();
    } catch {
      status.textContent = 'Import failed.';
      toast('Import failed', 'error');
    }
  }

  // --- Connected Accounts (OAuth) ---

  let oauthAccounts = [];
  let oauthProviderConfig = { google_configured: false, microsoft_configured: false };
  let oauthPollTimer = null;

  async function loadConnectedAccounts() {
    await fetchOAuthAccounts();
    await fetchOAuthProviderConfig();
    renderConnectedAccounts();
  }

  async function fetchOAuthAccounts() {
    if (!currentUser) return;
    try {
      const r = await fetch('/api/oauth/accounts?userId=' + encodeURIComponent(currentUser.id));
      const d = await r.json();
      oauthAccounts = d.accounts || [];
    } catch {
      oauthAccounts = [];
    }
  }

  async function fetchOAuthProviderConfig() {
    try {
      const r = await fetch('/api/settings');
      const d = await r.json();
      oauthProviderConfig.google_configured = !!d.google_configured;
      oauthProviderConfig.microsoft_configured = !!d.microsoft_configured;
    } catch {}
  }

  function providerBadge(provider, size) {
    size = size || 20;
    if (provider === 'google') {
      return '<span class="provider-badge provider-google" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.6) + 'px">G</span>';
    }
    if (provider === 'microsoft') {
      return '<span class="provider-badge provider-microsoft" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.6) + 'px">M</span>';
    }
    return '';
  }

  async function saveUserEmail() {
    var email = document.getElementById('userEmailField').value.trim();
    if (!email) { toast('Enter an email address', 'warning'); return; }
    try {
      await fetch('/api/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
        body: JSON.stringify({ email: email })
      });
      currentUser.email = email;
      toast('Email updated', 'success');
    } catch { toast('Failed to update email', 'error'); }
  }

  async function renderConnectedAccounts() {
    const list = document.getElementById('connectedAccountsList');
    const actions = document.getElementById('connectedAccountsActions');
    if (!list || !actions) return;

    // Email address section at top of accounts
    var emailHtml = '<div style="margin-bottom:20px">'
      + '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px;color:var(--text-secondary)">Your Email</div>'
      + '<div style="display:flex;gap:8px;align-items:center">'
      + '<input type="email" id="userEmailField" value="' + escAttr(currentUser?.email || '') + '" placeholder="your@email.com" style="flex:1;padding:8px 14px;border:1.5px solid transparent;background:var(--bg);border-radius:100px;font-size:0.85rem;font-family:var(--font);color:var(--text-primary)">'
      + '<button class="btn btn-accent btn-sm" onclick="UserDash.saveUserEmail()">Save</button>'
      + '</div>'
      + '<p style="font-size:0.75rem;color:var(--text-tertiary);margin-top:4px">Used for password reset emails</p>'
      + '</div>';

    if (oauthAccounts.length === 0) {
      list.innerHTML = emailHtml + '<div style="color:var(--text-secondary);font-size:13px;padding:16px 0">No accounts connected yet. Use the buttons above to link a provider.</div>';
    } else {
      list.innerHTML = emailHtml + oauthAccounts.map(acct => {
        const badge = providerBadge(acct.provider, 28);
        const features = [];
        if (acct.calendar_enabled) features.push('Calendar');
        if (acct.email_enabled) features.push('Email');
        const featureStr = features.length ? features.join(' & ') : 'None';
        const syncAgo = acct.last_calendar_sync ? timeAgo(acct.last_calendar_sync) : 'never';
        const disabledNote = acct.enabled === 0 ? '<div class="connected-account-error">Connection expired. Please reconnect.</div>' : '';

        return '<div class="connected-account" data-id="' + escAttr(acct.id) + '">'
          + '<div class="connected-account-header">'
          + badge
          + '<div class="connected-account-info">'
          + '<div class="connected-account-email">' + esc(acct.email || acct.name || acct.provider || 'No email') + '</div>'
          + '<div class="connected-account-features">' + esc(featureStr) + ' &middot; Last sync: ' + esc(syncAgo) + '</div>'
          + '</div>'
          + '</div>'
          + disabledNote
          + '<div class="connected-account-controls">'
          + '<label class="connected-account-toggle"><input type="checkbox" data-field="calendar_enabled" ' + (acct.calendar_enabled ? 'checked' : '') + '> Calendar</label>'
          + '<label class="connected-account-toggle"><input type="checkbox" data-field="email_enabled" ' + (acct.email_enabled ? 'checked' : '') + '> Email</label>'
          + (acct.calendar_enabled && acct.enabled !== 0 ? '<button class="btn btn-ghost btn-sm connected-account-resync" title="Pull latest calendar events now">Resync Calendar</button>' : '')
          + '<button class="btn btn-ghost btn-sm connected-account-disconnect">Disconnect</button>'
          + '</div>'
          + '</div>';
      }).join('');

      // Bind toggle events
      list.querySelectorAll('.connected-account').forEach(card => {
        const id = card.dataset.id;
        card.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.addEventListener('change', () => {
            const field = cb.dataset.field;
            const body = {};
            body[field] = cb.checked ? 1 : 0;
            fetch('/api/oauth/accounts/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            }).then(() => {
              toast('Account updated', 'success');
              fetchOAuthAccounts().then(() => {
                renderConnectedAccounts();
                updateCalPushAllButton();
              });
            }).catch(() => toast('Failed to update', 'error'));
          });
        });
        const resyncBtn = card.querySelector('.connected-account-resync');
        if (resyncBtn) {
          resyncBtn.addEventListener('click', async () => {
            resyncBtn.disabled = true;
            resyncBtn.textContent = 'Syncing...';
            try {
              const r = await fetch('/api/oauth/accounts/' + encodeURIComponent(id) + '/pull-calendar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              if (r.ok) {
                const d = await r.json();
                const parts = [];
                if (d.inserted) parts.push(d.inserted + ' new');
                if (d.updated) parts.push(d.updated + ' updated');
                if (d.removed) parts.push(d.removed + ' removed');
                toast(parts.length ? 'Calendar synced: ' + parts.join(', ') : 'Calendar up to date', 'success');
                loadCalendarEvents();
                fetchOAuthAccounts().then(() => renderConnectedAccounts());
              } else {
                const d = await r.json().catch(() => ({}));
                toast(d.error || 'Sync failed', 'error');
              }
            } catch {
              toast('Sync failed', 'error');
            }
            resyncBtn.disabled = false;
            resyncBtn.textContent = 'Resync Calendar';
          });
        }
        card.querySelector('.connected-account-disconnect').addEventListener('click', () => {
          if (!confirm('Disconnect this account? This will revoke access and remove synced data.')) return;
          fetch('/api/oauth/accounts/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(r => {
              if (r.ok) {
                toast('Account disconnected', 'success');
                fetchOAuthAccounts().then(() => {
                  renderConnectedAccounts();
                  updateCalPushAllButton();
                });
              } else { toast('Failed to disconnect', 'error'); }
            })
            .catch(() => toast('Failed to disconnect', 'error'));
        });
      });
    }

    // Show IMAP/SMTP email accounts below OAuth
    try {
      const userId = currentUser ? currentUser.id : '';
      const er = await fetch('/api/email/accounts?userId=' + encodeURIComponent(userId));
      const ed = await er.json();
      const imapAccounts = (ed.accounts || []).filter(a => !a.oauth_account_id);
      if (imapAccounts.length > 0) {
        let imapHtml = '<div style="margin-top:16px"><div style="font-weight:600;font-size:.85rem;margin-bottom:8px;color:var(--text-secondary)">IMAP/SMTP Accounts</div>';
        imapHtml += imapAccounts.map(a => {
          return '<div class="connected-account">'
            + '<div class="connected-account-header">'
            + '<span class="provider-badge" style="width:28px;height:28px;font-size:17px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff">@</span>'
            + '<div class="connected-account-info">'
            + '<div class="connected-account-email">' + esc(a.email || a.name) + '</div>'
            + '<div class="connected-account-features">IMAP' + (a.read_only ? ' (Read Only)' : ' (Read/Write)') + '</div>'
            + '</div>'
            + '</div>'
            + '<div class="connected-account-controls">'
            + '<button class="btn btn-ghost btn-sm" onclick="UserDash.openEmailAccountModal(\'' + escAttr(a.id) + '\')">Edit</button>'
            + '</div></div>';
        }).join('');
        imapHtml += '</div>';
        list.insertAdjacentHTML('beforeend', imapHtml);
      }
    } catch {}

    // Load user's own channel connections
    try {
      const ucr = await fetch('/api/user/channels', { headers: { 'X-User-Session': userSession() } });
      const ucd = await ucr.json();
      const userChannels = ucd.channels || [];

      let ucHtml = '<div style="margin-top:20px"><div style="font-weight:600;font-size:.85rem;margin-bottom:8px;color:var(--text-secondary)">Your Connections</div>';

      if (userChannels.length > 0) {
        ucHtml += userChannels.map(ch => {
          const icons = { whatsapp: '\uD83D\uDFE2', telegram: '\uD83D\uDD35', slack: '\uD83D\uDD34' };
          const labels = { whatsapp: 'WhatsApp', telegram: 'Telegram', slack: 'Slack' };
          const statusColor = ch.status === 'connected' ? '#059669' : ch.status === 'connecting' ? '#f59e0b' : '#94a3b8';
          const statusText = ch.status === 'connected' ? (ch.phone_number || 'Connected') : ch.status;
          return '<div class="connected-account">'
            + '<div class="connected-account-header">'
            + '<span style="font-size:1.2rem">' + (icons[ch.type] || '?') + '</span>'
            + '<div class="connected-account-info">'
            + '<div class="connected-account-email">' + esc(labels[ch.type] || ch.type) + '</div>'
            + '<div style="font-size:.75rem;color:' + statusColor + '">' + esc(statusText) + '</div>'
            + '</div></div>'
            + '<div style="display:flex;gap:6px">'
            + '<button class="btn btn-ghost btn-sm" onclick="UserDash.reconnectUserChannel(\'' + escAttr(ch.type) + '\')">Reconnect</button>'
            + '<button class="btn btn-danger btn-sm" onclick="UserDash.disconnectUserChannel(\'' + escAttr(ch.type) + '\')">Disconnect</button>'
            + '</div>'
            + '</div>';
        }).join('');
      }


      // Show linked channel chats — find non-web groups sharing the same folder as user's web groups
      const sessions = currentUser?.allowed_sessions || [];
      const userFolders = new Set();
      const folderToGroup = {};
      for (const jid of sessions) {
        if (jid.startsWith('web:') && groupsMap[jid]?.folder) {
          userFolders.add(groupsMap[jid].folder);
          folderToGroup[groupsMap[jid].folder] = groupsMap[jid].name || jid;
        }
      }
      const linkedChats = Object.entries(groupsMap).filter(([jid, g]) =>
        !jid.startsWith('web:') && !jid.startsWith('system:') && g.folder && userFolders.has(g.folder)
      );
      if (linkedChats.length > 0) {
        ucHtml += '<div style="margin-top:14px"><div style="font-weight:500;font-size:.8rem;margin-bottom:6px;color:var(--text-tertiary)">Linked Chats</div>';
        ucHtml += '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">';
        ucHtml += linkedChats.map(([jid, g], idx) => {
          const chatName = g.name || jid;
          const channelType = jid.includes('@g.us') || jid.includes('@s.whatsapp') ? 'WhatsApp' : jid.startsWith('tg:') ? 'Telegram' : jid.startsWith('slack:') ? 'Slack' : 'Channel';
          const channelIcon = channelType === 'WhatsApp' ? '\uD83D\uDFE2' : channelType === 'Telegram' ? '\uD83D\uDD35' : channelType === 'Slack' ? '\uD83D\uDD34' : '\uD83D\uDD17';
          const linkedGroup = folderToGroup[g.folder] || g.folder;
          const border = idx > 0 ? 'border-top:1px solid var(--border);' : '';
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' + border + '">'
            + '<div style="display:flex;align-items:center;gap:10px;min-width:0">'
            + '<span style="font-size:16px;flex-shrink:0">' + channelIcon + '</span>'
            + '<div style="min-width:0">'
            + '<div style="font-size:13px;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(chatName) + '</div>'
            + '<div style="font-size:11px;color:var(--text-tertiary)">' + esc(channelType) + ' \u2192 ' + esc(linkedGroup) + '</div>'
            + '</div></div>'
            + '<button class="btn btn-ghost btn-sm" style="flex-shrink:0;font-size:12px" onclick="UserDash.unlinkWhatsappChat(\'' + escAttr(jid) + '\')">Unlink</button>'
            + '</div>';
        }).join('');
        ucHtml += '</div></div>';
      }

      ucHtml += '</div>';
      list.insertAdjacentHTML('beforeend', ucHtml);
    } catch {}

    // Discovered WhatsApp chats
    try {
      const dr = await fetch('/api/chats/discovered?channel=whatsapp', { headers: { 'X-User-Session': userSession() } });
      const dd = await dr.json();
      const discovered = dd.chats || [];
      let discHtml = '<div style="margin-top:16px" id="discoveredWhatsappSection">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
        + '<div style="font-weight:600;font-size:.85rem;color:var(--text-secondary)">WhatsApp Chats</div>'
        + '<button class="btn btn-ghost btn-sm" id="btnSyncWhatsapp" style="font-size:11px">Sync Chats</button>'
        + '</div>';
      if (discovered.length > 0) {
        discHtml += '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">';
        discHtml += discovered.map((chat, idx) => {
          const name = chat.name || chat.jid;
          const ago = chat.last_message_time ? timeAgo(chat.last_message_time) : '';
          const border = idx > 0 ? 'border-top:1px solid var(--border);' : '';
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' + border + '">'
            + '<div style="display:flex;align-items:center;gap:10px;min-width:0">'
            + '<span style="font-size:16px;flex-shrink:0">&#128241;</span>'
            + '<div style="min-width:0">'
            + '<div style="font-size:13px;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(name) + '</div>'
            + (ago ? '<div style="font-size:11px;color:var(--text-tertiary)">last active: ' + esc(ago) + '</div>' : '')
            + '</div></div>'
            + '<button class="btn btn-accent btn-sm" style="flex-shrink:0;font-size:12px" onclick="UserDash.openLinkDiscoveredChat(\'' + escAttr(chat.jid) + '\', \'' + escAttr(name) + '\')">Link to Group</button>'
            + '</div>';
        }).join('');
        discHtml += '</div>';
      } else {
        discHtml += '<div style="font-size:13px;color:var(--text-tertiary);padding:8px 0">No chats discovered yet. Click "Sync Chats" to scan your WhatsApp groups.</div>';
      }
      discHtml += '</div>';
      list.insertAdjacentHTML('beforeend', discHtml);
      document.getElementById('btnSyncWhatsapp')?.addEventListener('click', async function() {
        this.disabled = true;
        this.textContent = 'Syncing...';
        try {
          await fetch('/api/channels/whatsapp/sync', { method: 'POST', headers: { 'X-User-Session': userSession() } });
          await new Promise(r => setTimeout(r, 3000));
          loadConnectedAccounts();
        } catch { toast('Sync failed', 'error'); this.disabled = false; this.textContent = 'Sync Chats'; }
      });
    } catch {}

    // Discovered Slack channels
    try {
      const sr = await fetch('/api/chats/discovered?channel=slack', { headers: { 'X-User-Session': userSession() } });
      const sd = await sr.json();
      const slackDiscovered = sd.chats || [];
      if (slackDiscovered.length > 0) {
        let slDiscHtml = '<div style="margin-top:16px" id="discoveredSlackSection">'
          + '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px;color:var(--text-secondary)">Discovered Slack Channels</div>'
          + '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">';
        slDiscHtml += slackDiscovered.map((chat, idx) => {
          const name = chat.name || chat.jid;
          const ago = chat.last_message_time ? timeAgo(chat.last_message_time) : '';
          const border = idx > 0 ? 'border-top:1px solid var(--border);' : '';
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' + border + '">'
            + '<div style="display:flex;align-items:center;gap:10px;min-width:0">'
            + '<span style="font-size:16px;flex-shrink:0">&#128172;</span>'
            + '<div style="min-width:0">'
            + '<div style="font-size:13px;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(name) + '</div>'
            + (ago ? '<div style="font-size:11px;color:var(--text-tertiary)">last active: ' + esc(ago) + '</div>' : '')
            + '</div></div>'
            + '<button class="btn btn-accent btn-sm" style="flex-shrink:0;font-size:12px" onclick="UserDash.openLinkDiscoveredChat(\'' + escAttr(chat.jid) + '\', \'' + escAttr(name) + '\')">Link to Group</button>'
            + '</div>';
        }).join('');
        slDiscHtml += '</div></div>';
        list.insertAdjacentHTML('beforeend', slDiscHtml);
      }
    } catch {}

    // Connect buttons — grid at top of accounts page
    let btns = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">';
    btns += '<button class="btn btn-sm" id="btnConnectGoogle" style="display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 16px;background:var(--surface-solid);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;cursor:pointer;transition:all .15s">' + providerBadge('google', 18) + ' Google</button>';
    btns += '<button class="btn btn-sm" id="btnConnectMicrosoft" style="display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 16px;background:var(--surface-solid);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;cursor:pointer;transition:all .15s">' + providerBadge('microsoft', 18) + ' Outlook</button>';
    btns += '<button class="btn btn-sm" id="btnAddImapAccount" style="display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 16px;background:var(--surface-solid);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;cursor:pointer;transition:all .15s">📧 Email (IMAP)</button>';
    btns += '<button class="btn btn-sm" id="btnLinkTelegram" style="display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 16px;background:var(--surface-solid);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;cursor:pointer;transition:all .15s">🔵 Telegram</button>';
    btns += '<button class="btn btn-sm" id="btnLinkSlack" style="display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 16px;background:var(--surface-solid);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;cursor:pointer;transition:all .15s">🔴 Slack</button>';
    btns += '<button class="btn btn-sm" id="btnLinkWhatsapp" style="display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 16px;background:var(--surface-solid);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;cursor:pointer;transition:all .15s">🟢 WhatsApp</button>';
    btns += '</div>';
    actions.innerHTML = btns;

    const gBtn = document.getElementById('btnConnectGoogle');
    if (gBtn) gBtn.addEventListener('click', () => startOAuthConnect('google'));
    const mBtn = document.getElementById('btnConnectMicrosoft');
    if (mBtn) mBtn.addEventListener('click', () => startOAuthConnect('microsoft'));
    const imapBtn = document.getElementById('btnAddImapAccount');
    if (imapBtn) imapBtn.addEventListener('click', () => openEmailAccountModal());
    const tgBtn = document.getElementById('btnLinkTelegram');
    if (tgBtn) tgBtn.addEventListener('click', () => openChannelLinkModal('telegram'));
    const slackBtn = document.getElementById('btnLinkSlack');
    if (slackBtn) slackBtn.addEventListener('click', () => openChannelLinkModal('slack'));
    const waBtn = document.getElementById('btnLinkWhatsapp');
    if (waBtn) waBtn.addEventListener('click', () => openChannelLinkModal('whatsapp'));

  }

  function startOAuthConnect(provider) {
    if (!currentUser) return;

    const providerName = provider === 'microsoft' ? 'Outlook' : capitalize(provider);
    const configured = provider === 'google' ? oauthProviderConfig.google_configured : oauthProviderConfig.microsoft_configured;
    if (!configured) {
      toast(providerName + ' OAuth is not configured. Ask your admin to set it up in Settings.', 'error');
      return;
    }
    const credsSection = '';

    const dialogHtml = `
      <div class="modal-overlay" id="oauthReadOnlyModal" style="z-index:10000">
        <div class="modal" style="max-width:420px">
          <div class="modal-header">
            <h3>Connect ${providerName}</h3>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('oauthReadOnlyModal').remove()">&times;</button>
          </div>
          <div class="modal-body" style="padding:20px">
            <p style="margin-bottom:16px">Connect your ${providerName} account to read emails and calendar events.</p>
            ${credsSection}
            <div class="email-readonly-toggle" style="margin-bottom:16px">
              <label class="wt-field-label">Email Send Mode</label>
              <div class="email-readonly-control">
                <label class="email-readonly-switch">
                  <input type="checkbox" id="oauthReadOnly" checked>
                  <span class="email-readonly-slider"></span>
                </label>
                <span class="email-readonly-status" id="oauthReadOnlyStatus" style="color:var(--accent)">READ ONLY - Sending disabled</span>
              </div>
              <p class="email-readonly-warning" id="oauthReadOnlyWarning" style="display:none;color:var(--danger);font-size:13px;margin-top:8px">
                <strong>Warning:</strong> The AI will be able to send emails from your ${providerName} account.
              </p>
            </div>
          </div>
          <div class="modal-footer" style="justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost" onclick="document.getElementById('oauthReadOnlyModal').remove()">Cancel</button>
            <button class="btn btn-accent" id="oauthConfirmBtn">Connect</button>
          </div>
        </div>
      </div>
    `;

    const div = document.createElement('div');
    div.innerHTML = dialogHtml;
    document.body.appendChild(div.firstElementChild);

    document.getElementById('oauthReadOnly').addEventListener('change', function() {
      const checked = this.checked;
      document.getElementById('oauthReadOnlyStatus').textContent = checked ? 'READ ONLY - Sending disabled' : 'SEND ENABLED - AI can send emails';
      document.getElementById('oauthReadOnlyStatus').style.color = checked ? 'var(--accent)' : 'var(--danger)';
      document.getElementById('oauthReadOnlyWarning').style.display = checked ? 'none' : 'block';
    });

    document.getElementById('oauthConfirmBtn').addEventListener('click', function() {
      const readOnly = document.getElementById('oauthReadOnly').checked;
      document.getElementById('oauthReadOnlyModal').remove();
      doOAuthConnect(provider, readOnly);
    });
  }

  function doOAuthConnect(provider, readOnly) {
    let url = '/api/oauth/start?provider=' + encodeURIComponent(provider) + '&userId=' + encodeURIComponent(currentUser.id) + '&read_only=' + readOnly;
    const popup = window.open(url, 'oauth', 'width=500,height=700');

    // Listen for postMessage from popup
    function onMessage(e) {
      if (e.data && e.data.type === 'oauth-success') {
        window.removeEventListener('message', onMessage);
        clearOAuthPoll();
        toast(capitalize(e.data.provider || provider) + ' account connected', 'success');
        fetchOAuthAccounts().then(() => {
          renderConnectedAccounts();
          updateCalPushAllButton();
        });
      }
    }
    window.addEventListener('message', onMessage);

    // Fallback: poll if popup was blocked
    setTimeout(() => {
      if (!popup || popup.closed) {
        // Popup likely blocked, open in new tab
        window.open(url);
        startOAuthPoll(provider);
      }
    }, 1000);
  }

  function startOAuthPoll(provider) {
    clearOAuthPoll();
    const startCount = oauthAccounts.length;
    let elapsed = 0;
    oauthPollTimer = setInterval(async () => {
      elapsed += 2000;
      if (elapsed > 120000) { clearOAuthPoll(); return; }
      await fetchOAuthAccounts();
      if (oauthAccounts.length > startCount) {
        clearOAuthPoll();
        toast(capitalize(provider) + ' account connected', 'success');
        renderConnectedAccounts();
        updateCalPushAllButton();
      }
    }, 2000);
  }

  function clearOAuthPoll() {
    if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
  }

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // Get connected OAuth accounts that have calendar enabled
  function getCalendarOAuthAccounts() {
    return oauthAccounts.filter(a => a.calendar_enabled && a.enabled !== 0);
  }

  // Push a single calendar event to a provider
  async function pushCalendarEvent(eventId, oauthAccountId) {
    try {
      const r = await fetch('/api/oauth/accounts/' + encodeURIComponent(oauthAccountId) + '/sync-calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds: [eventId] })
      });
      if (r.ok) {
        toast('Event pushed successfully', 'success');
        loadCalendarEvents();
      } else {
        const d = await r.json().catch(() => ({}));
        toast(d.error || 'Failed to push event', 'error');
      }
    } catch {
      toast('Failed to push event', 'error');
    }
  }

  // Push all local events
  async function pushAllLocalEvents(oauthAccountId) {
    try {
      const r = await fetch('/api/oauth/accounts/' + encodeURIComponent(oauthAccountId) + '/sync-calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds: 'all_local' })
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        toast('Pushed ' + (d.count || 'all') + ' local events', 'success');
        loadCalendarEvents();
      } else {
        const d = await r.json().catch(() => ({}));
        toast(d.error || 'Failed to push events', 'error');
      }
    } catch {
      toast('Failed to push events', 'error');
    }
  }

  function updateCalPushAllButton() {
    const btn = document.getElementById('btnCalPushAll');
    if (!btn) return;
    const calAccounts = getCalendarOAuthAccounts();
    if (calAccounts.length === 0) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    btn.textContent = 'Push Calendar';
    btn.onclick = () => {
      // Push to whichever account is selected in the calendar filter, or first account
      var targetAccountId = null;
      if (calSourceFilter && calSourceFilter !== 'all' && calSourceFilter !== 'local') {
        targetAccountId = calSourceFilter.split('/')[0];
      }
      if (!targetAccountId && calAccounts.length === 1) {
        targetAccountId = calAccounts[0].id;
      }
      if (targetAccountId) {
        pushAllLocalEvents(targetAccountId);
      } else {
        // Multiple accounts, none selected — show picker
        showPushDropdown(btn, calAccounts, (acctId) => pushAllLocalEvents(acctId));
      }
    };
  }

  function showPushDropdown(anchor, accounts, onSelect) {
    // Remove any existing dropdown
    const old = document.getElementById('pushDropdown');
    if (old) old.remove();

    const dd = document.createElement('div');
    dd.id = 'pushDropdown';
    dd.className = 'push-dropdown';
    dd.innerHTML = accounts.map(a => {
      const label = a.provider === 'google' ? 'Google' : 'Outlook';
      return '<button class="push-dropdown-item" data-id="' + escAttr(a.id) + '">'
        + providerBadge(a.provider, 16) + ' ' + esc(label) + ' (' + esc(a.email || '') + ')'
        + '</button>';
    }).join('');
    document.body.appendChild(dd);

    const rect = anchor.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.left = rect.left + 'px';

    dd.querySelectorAll('.push-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        onSelect(item.dataset.id);
        dd.remove();
      });
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', handler); }
      });
    }, 0);
  }

  // --- Email ---

  let emailAccounts = [];
  let currentEmailAccountId = '';

  async function loadEmailView() {
    // Hide add button — account management is in Connected Accounts.
    // querySelectorAll so both the Email-tab and Settings-tab copies are hidden; the
    // settings loader re-shows its own.
    document.querySelectorAll('#btnAddEmailAccount').forEach(b => b.style.display = 'none');
    await loadEmailAccounts();
    const saved = localStorage.getItem('dockbox-email-account');
    if (saved && emailAccounts.find(a => a.id === saved)) {
      currentEmailAccountId = saved;
    } else if (emailAccounts.length > 0) {
      currentEmailAccountId = emailAccounts[0].id;
    }
    const sel = document.getElementById('emailAccountSelect');
    if (sel) sel.value = currentEmailAccountId;
    updateEmailSecurityBanner();
    updateComposeButton();

    // Load cached emails from filesystem if available
    await loadCachedEmailsFromFs();

    // Only fetch from server if we don't have cached emails
    if (currentEmailAccountId && !cachedEmailsByFolder['INBOX']) {
      loadEmailInbox();
    }

    // Folder click handlers
    document.querySelectorAll('.email-folder').forEach(f => {
      f.onclick = () => {
        document.querySelectorAll('.email-folder').forEach(x => x.classList.remove('active'));
        f.classList.add('active');
        const folder = f.dataset.folder;
        if (currentEmailAccountId) {
          // Check cache first before fetching
          if (cachedEmailsByFolder[folder]) {
            renderEmailList(cachedEmailsByFolder[folder].emails, folder);
          } else {
            loadEmailInbox(folder);
          }
        }
      };
    });

    // Search handler
    const searchInput = document.getElementById('emailSearchInput');
    if (searchInput) searchInput.oninput = () => filterEmailList(searchInput.value);

    // Close reader
    const closeBtn = document.getElementById('btnCloseReader');
    if (closeBtn) closeBtn.onclick = closeEmailReader;

    // Edit account btn
    const editBtn = document.getElementById('btnEditEmailAccount');
    if (editBtn) editBtn.onclick = () => { if (currentEmailAccountId) openEmailAccountModal(currentEmailAccountId); };

    // Delete account btn
    const delBtn = document.getElementById('btnDeleteEmailAccount');
    if (delBtn) delBtn.onclick = () => { if (currentEmailAccountId) deleteEmailAccountById(currentEmailAccountId); };
  }

  function updateEmailSecurityBanner() {
    const banner = document.getElementById('emailSecurityBanner');
    const text = document.getElementById('emailSecurityText');
    if (!banner || !text) return;
    const acct = emailAccounts.find(a => a.id === currentEmailAccountId);
    if (!acct || acct.read_only) {
      banner.classList.remove('send-enabled');
      text.textContent = 'Read Only Mode \u2014 Cannot send emails. Enable Read Write mode to send.';
    } else {
      banner.classList.add('send-enabled');
      text.textContent = 'Send Mode \u2014 Emails are actually sent. Be careful.';
    }
  }

  async function loadEmailAccounts() {
    try {
      const userId = currentUser ? currentUser.id : '';
      const r = await fetch('/api/email/accounts?userId=' + encodeURIComponent(userId));
      const d = await r.json();
      emailAccounts = d.accounts || [];
      const select = document.getElementById('emailAccountSelect');
      if (emailAccounts.length === 0) {
        select.innerHTML = '<option value="">No accounts configured</option>';
        currentEmailAccountId = '';
      } else {
        select.innerHTML = emailAccounts.map(a => {
          let prefix = '';
          if (a.oauth_account_id) {
            const oa = oauthAccounts.find(o => o.id === a.oauth_account_id);
            if (oa) prefix = (oa.provider === 'google' ? '[G] ' : '[M] ');
          }
          return '<option value="' + escAttr(a.id) + '">' + esc(prefix + a.name) + ' (' + esc(a.email) + ')' + (a.read_only ? ' [READ ONLY]' : ' [READ WRITE]') + '</option>';
        }).join('');
      }
    } catch (e) {
      console.error('loadEmailAccounts error:', e);
    }
  }

  function updateComposeButton() {
    const btn = document.getElementById('btnCompose') || document.getElementById('btnEmailCompose');
    if (!btn) return;
    const account = emailAccounts.find(a => a.id === currentEmailAccountId);
    if (!account || account.read_only) {
      btn.disabled = false;
      btn.title = account ? 'Read Only Mode: Cannot send emails' : 'No account selected';
      btn.style.opacity = '0.5';
    } else {
      btn.disabled = false;
      btn.title = 'Compose email';
      btn.style.opacity = '';
    }
  }

  let cachedEmailsByFolder = {}; // folder -> { emails: [], loaded: count, hasMore: bool }
  let currentEmailFolder = 'INBOX';
  const EMAILS_PER_PAGE = 50;
  let emailCacheLoaded = false;

  async function loadCachedEmailsFromFs() {
    try {
      // Get folder from user's home group
      let groupFolder = null;

      if (currentUser?.home_group) {
        // Look up the folder from groupsMap using home_group JID
        groupFolder = groupsMap[currentUser.home_group]?.folder;
      }

      // Fallback: if user has a home_group but it's not in groupsMap yet
      if (!groupFolder && currentUser?.home_group) {
        // Fetch groups and find the one matching home_group
        try {
          const res = await cachedFetch('/api/groups', null, 5000);
          const data = await res.json();
          const homeGroup = data.groups?.find(g => g.jid === currentUser.home_group);
          if (homeGroup) {
            groupFolder = homeGroup.folder;
            // Also update groupsMap for future use
            groupsMap[homeGroup.jid] = homeGroup;
          }
        } catch (e) {
          console.log('Failed to fetch groups for email cache');
        }
      }

      if (!groupFolder) {
        console.log('No group folder found for email cache');
        return;
      }

      console.log('Loading email cache from folder:', groupFolder);

      // Load the cache file directly
      const cacheRes = await fetch('/api/files/read?path=' + encodeURIComponent(groupFolder + '/email-cache/inbox.json'), {
        headers: { 'x-user-session': userSession() }
      });
      if (!cacheRes.ok) return;

      const result = await cacheRes.json();
      const cacheData = JSON.parse(result.content);
      if (cacheData.emails && Array.isArray(cacheData.emails)) {
        cachedEmailsByFolder['INBOX'] = {
          emails: cacheData.emails,
          loaded: cacheData.emails.length,
          hasMore: cacheData.emails.length >= 50,
          cachedAt: cacheData.fetchedAt
        };
        emailCacheLoaded = true;
        console.log('Loaded', cacheData.emails.length, 'emails from cache (showing while live fetch loads)');

        // Render cached emails immediately as placeholder
        renderEmailList(cachedEmailsByFolder['INBOX'].emails, 'INBOX');

        // Immediately fetch live data to replace the cache
        if (currentEmailAccountId) {
          loadEmailInboxLive('INBOX');
        }
      }
    } catch (e) {
      console.log('No cached emails found:', e);
    }
  }

  // Fetch live emails from API (skips cache entirely)
  async function loadEmailInboxLive(folder) {
    if (!currentEmailAccountId) return;
    const f = folder || 'INBOX';
    try {
      const r = await fetch('/api/email/inbox?accountId=' + encodeURIComponent(currentEmailAccountId) + '&folder=' + encodeURIComponent(f) + '&limit=' + EMAILS_PER_PAGE + '&offset=0', { headers: { 'x-user-session': userSession() } });
      const data = await r.json();
      const newEmails = data.emails || [];
      cachedEmailsByFolder[f] = { emails: newEmails, loaded: newEmails.length, hasMore: newEmails.length >= EMAILS_PER_PAGE };
      const countEl = document.getElementById('emailInboxCount');
      if (countEl && f === 'INBOX') countEl.textContent = newEmails.length > 0 ? newEmails.length : '';
      if (currentEmailFolder === f) renderEmailList(newEmails, f);
      // Hide stale cache status
      const statusEl = document.getElementById('emailCacheStatus');
      if (statusEl) statusEl.style.display = 'none';
    } catch (e) {
      console.error('Live email fetch failed, keeping cached data:', e);
    }
  }

  async function loadEmailInbox(folder, append) {
    if (!currentEmailAccountId) return;
    const inbox = document.getElementById('emailInbox');
    if (!inbox) return;

    const f = folder || 'INBOX';
    currentEmailFolder = f;

    // Show cached data immediately while fetching live
    if (!append && cachedEmailsByFolder[f]) {
      renderEmailList(cachedEmailsByFolder[f].emails, f);
    }

    if (!append && !cachedEmailsByFolder[f]) {
      inbox.innerHTML = '<div class="email-empty-state"><p>Loading...</p></div>';
    }

    try {
      const offset = append ? (cachedEmailsByFolder[f]?.emails.length || 0) : 0;
      const r = await fetch('/api/email/inbox?accountId=' + encodeURIComponent(currentEmailAccountId) + '&folder=' + encodeURIComponent(f) + '&limit=' + EMAILS_PER_PAGE + '&offset=' + offset, { headers: { 'x-user-session': userSession() } });
      const data = await r.json();
      const newEmails = data.emails || [];

      if (append && cachedEmailsByFolder[f]) {
        cachedEmailsByFolder[f].emails.push(...newEmails);
      } else {
        cachedEmailsByFolder[f] = { emails: newEmails, loaded: newEmails.length, hasMore: newEmails.length >= EMAILS_PER_PAGE };
      }

      // Update hasMore flag
      if (cachedEmailsByFolder[f]) {
        cachedEmailsByFolder[f].hasMore = newEmails.length >= EMAILS_PER_PAGE;
      }

      const countEl = document.getElementById('emailInboxCount');
      if (countEl && f === 'INBOX') countEl.textContent = cachedEmailsByFolder[f]?.emails.length > 0 ? cachedEmailsByFolder[f].emails.length : '';

      renderEmailList(cachedEmailsByFolder[f].emails, f);
      // Hide stale cache status once live data loaded
      const statusEl = document.getElementById('emailCacheStatus');
      if (statusEl) statusEl.style.display = 'none';
    } catch (e) {
      console.error('loadEmailInbox error:', e);
      if (!append && !cachedEmailsByFolder[f]) inbox.innerHTML = '<div class="email-empty-state"><p>Failed to load emails</p></div>';
    }
  }

  function loadMoreEmails() {
    loadEmailInbox(currentEmailFolder, true);
  }

  function renderEmailList(emails, folder) {
    const inbox = document.getElementById('emailInbox');
    if (!inbox) return;
    if (emails.length === 0) {
      inbox.innerHTML = '<div class="email-empty-state"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="opacity:0.3"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg><p>No emails found</p></div>';
      return;
    }
    let html = emails.map((em, i) => {
      const from = em.from || 'Unknown';
      const subject = em.subject || '(no subject)';
      const preview = (em.body || '').replace(/<[^>]*>/g, '').slice(0, 100);
      const d = em.date ? new Date(em.date) : null;
      const dateStr = d ? (isToday(d) ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : d.toLocaleDateString([], {month:'short',day:'numeric'})) : '';
      return '<div class="email-row" onclick="UserDash.viewEmailInReader(' + i + ')">'
        + '<div class="email-row-from">' + esc(from) + '</div>'
        + '<div class="email-row-content">'
        + '<div class="email-row-subject">' + esc(subject) + '</div>'
        + '<div class="email-row-preview">' + esc(preview) + '</div>'
        + '</div>'
        + '<div class="email-row-date">' + esc(dateStr) + '</div>'
        + '</div>';
    }).join('');

    // Add "Load More" button if there are more emails
    const folderData = cachedEmailsByFolder[folder || currentEmailFolder];
    if (folderData?.hasMore) {
      html += '<div style="padding:16px;text-align:center">'
        + '<button class="btn btn-ghost" onclick="UserDash.loadMoreEmails()">Load More</button>'
        + '</div>';
    }

    inbox.innerHTML = html;
  }

  function isToday(d) {
    const t = new Date();
    return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
  }

  function filterEmailList(query) {
    const emails = cachedEmailsByFolder[currentEmailFolder]?.emails || [];
    if (!query) { renderEmailList(emails, currentEmailFolder); return; }
    const q = query.toLowerCase();
    const filtered = emails.filter(em =>
      (em.from || '').toLowerCase().includes(q) ||
      (em.subject || '').toLowerCase().includes(q) ||
      (em.body || '').toLowerCase().includes(q)
    );
    renderEmailList(filtered, currentEmailFolder);
  }

  function closeEmailView() {
    document.getElementById('emailViewModal').classList.add('hidden');
  }

  async function viewEmailInReader(index) {
    const emails = cachedEmailsByFolder[currentEmailFolder]?.emails || [];
    if (!emails || !emails[index]) return;
    const em = emails[index];
    const panel = document.getElementById('emailReaderPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    document.getElementById('emailReaderSubject').textContent = em.subject || '(no subject)';
    const d = em.date ? new Date(em.date).toLocaleString() : '';
    document.getElementById('emailReaderMeta').innerHTML = '<div><strong>From:</strong> ' + esc(em.from || '') + '</div><div><strong>To:</strong> ' + esc(em.to || '') + '</div><div><strong>Date:</strong> ' + esc(d) + '</div>';

    // Show loading state
    const bodyEl = document.getElementById('emailReaderBody');
    bodyEl.textContent = 'Loading full message...';

    // Fetch full email if we only have a snippet (no full body)
    if (em.id && (!em.body || em.body.length < 200 || em.snippet)) {
      try {
        const account = emailAccounts.find(a => a.id === currentEmailAccountId);
        if (account) {
          const res = await fetch('/api/email/message?accountId=' + encodeURIComponent(account.id) + '&emailId=' + encodeURIComponent(em.id));
          if (res.ok) {
            const data = await res.json();
            if (data.email) {
              // Update the cached email with full body
              em.body = data.email.body;
              em.to = data.email.to;
            }
          }
        }
      } catch (e) {
        console.error('Failed to fetch full email:', e);
      }
    }

    bodyEl.innerHTML = em.body || '(no content)';
    document.querySelectorAll('.email-row').forEach((r, i) => r.classList.toggle('active', i === index));
  }

  function closeEmailReader() {
    const panel = document.getElementById('emailReaderPanel');
    if (panel) panel.classList.add('hidden');
    document.querySelectorAll('.email-row').forEach(r => r.classList.remove('active'));
  }

  function openChannelLinkModal(type) {
    const labels = { telegram: 'Telegram', slack: 'Slack', whatsapp: 'WhatsApp' };
    const label = labels[type] || type;

    // Build group options from user's allowed sessions
    const sessions = currentUser?.allowed_sessions || [];
    let groupOpts = '<option value="">— Select group —</option>';
    for (const jid of sessions) {
      const g = groupsMap[jid];
      if (g && jid.startsWith('web:')) {
        groupOpts += '<option value="' + escAttr(jid) + '">' + esc(g.name || jid) + '</option>';
      }
    }

    const linkInfo = '<div style="background:var(--surface-solid);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--text-secondary)">'
      + '<strong>What linking does:</strong> Your selected Warden group will be connected to this channel. '
      + 'Messages sent in the external chat (Telegram/Slack/WhatsApp) will be processed by the AI, and responses will be sent back there. '
      + 'All your existing workspace files, projects, and tasks are preserved.'
      + '<br><br><strong>Important:</strong> Each group can only be linked to <strong>one channel at a time</strong>. '
      + 'Linking Telegram will move the group from the web dashboard chat to Telegram. '
      + 'You can still access files, projects, and settings from the dashboard — but chat will happen in the linked channel. '
      + 'You can unlink at any time to return to web-only chat.'
      + '</div>';

    let formContent = '';
    if (type === 'whatsapp') {
      formContent = linkInfo
        + '<div id="waQrContainer" style="text-align:center;padding:20px">'
        + '<div class="rsb-hint">Connecting to WhatsApp...</div></div>';
    } else {
      const tokenLabel = type === 'telegram' ? 'Bot Token (from @BotFather)' : 'Bot Token (from Slack App Settings)';
      const instructions = type === 'telegram'
        ? '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">'
          + '<strong>Setup steps:</strong><br>'
          + '1. Open Telegram and message <strong>@BotFather</strong><br>'
          + '2. Send <code>/newbot</code> and follow the prompts to create your bot<br>'
          + '3. Copy the <strong>API token</strong> BotFather gives you<br>'
          + '4. Message <strong>@BotFather</strong> again → <code>/setprivacy</code> → select your bot → <strong>Disable</strong><br>'
          + '&nbsp;&nbsp;&nbsp;(This lets the bot read all group messages, not just commands)<br>'
          + '5. <strong>Add the bot to your Telegram group</strong> (open group → Add Members → search bot name)<br>'
          + '6. Send any message in the group so the bot can discover it<br>'
          + '7. Paste the token below and select which Warden group to link<br>'
          + '<br><em style="color:var(--text-tertiary)">Note: Privacy mode must be disabled or the bot must be an admin. Without this, the bot only sees commands and replies. Works in groups and private chats, not channels. Rate limit: 20 messages/minute per group.</em></p>'
        : '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">'
          + '<strong>Setup steps:</strong><br>'
          + '1. Go to <strong>api.slack.com/apps</strong> and create a new app<br>'
          + '2. Under <strong>OAuth & Permissions</strong>, add these Bot Token Scopes:<br>'
          + '&nbsp;&nbsp;• <code>chat:write</code>, <code>channels:history</code>, <code>channels:read</code><br>'
          + '&nbsp;&nbsp;• <code>groups:history</code>, <code>groups:read</code> (for private channels)<br>'
          + '3. Install the app to your workspace<br>'
          + '4. Copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>)<br>'
          + '5. <strong>Invite the bot to your Slack channel</strong> (type <code>/invite @botname</code>)<br>'
          + '6. Paste the token below and select which Warden group to link<br>'
          + '<br><em style="color:var(--text-tertiary)">Note: The bot must be invited to the Slack channel (<code>/invite @botname</code>). It cannot read messages from channels it hasn\'t been added to. The token starts with <code>xoxb-</code>.</em></p>';
      formContent = linkInfo + instructions
        + '<div class="wt-field"><label class="wt-field-label">' + tokenLabel + '</label>'
        + '<input class="wt-field-input" id="channelToken" type="password" placeholder="Paste token here" style="width:100%"></div>'
        + (type === 'slack' ? '<div class="wt-field" style="margin-top:12px"><label class="wt-field-label">Slack Channel</label>'
          + '<select class="wt-field-input" id="slackChannelSelect" style="width:100%"><option value="">-- Loading channels... --</option></select>'
          + '<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">Channels the bot has been invited to. <a href="#" id="slackRefreshChannels" style="color:var(--accent)">Refresh</a></div></div>' : '');
    }

    const isWa = type === 'whatsapp';
    const dialogHtml = '<div class="modal-overlay" id="channelLinkModal" style="z-index:10000">'
      + '<div class="modal" style="max-width:440px">'
      + '<div class="modal-header"><h3>' + (isWa ? 'Connect' : 'Link') + ' ' + label + '</h3>'
      + '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'channelLinkModal\').remove()">&times;</button></div>'
      + '<div class="modal-body" style="padding:20px;white-space:normal">'
      + formContent
      + (isWa ? '' : '<div class="wt-field" style="margin-top:12px"><label class="wt-field-label">Link to Group</label>'
        + '<select class="wt-field-input" id="channelGroup" style="width:100%">' + groupOpts + '</select></div>')
      + '</div>'
      + '<div class="modal-footer" style="justify-content:flex-end;gap:8px">'
      + '<button class="btn btn-ghost" onclick="document.getElementById(\'channelLinkModal\').remove()">' + (isWa ? 'Close' : 'Cancel') + '</button>'
      + (isWa ? '' : '<button class="btn btn-accent" id="btnChannelSave">Connect</button>')
      + '</div></div></div>';

    const div = document.createElement('div');
    div.innerHTML = dialogHtml;
    document.body.appendChild(div.firstElementChild);

    // Slack: populate discovered channels dropdown
    if (type === 'slack') {
      const populateSlackChannels = async () => {
        const sel = document.getElementById('slackChannelSelect');
        if (!sel) return;
        try {
          const cr = await fetch('/api/chats/discovered?channel=slack', { headers: { 'X-User-Session': userSession() } });
          const cd = await cr.json();
          const chats = (cd.chats || []).filter(c => c.name);
          let opts = '<option value="">-- Select Slack channel --</option>';
          for (const c of chats) opts += '<option value="' + escAttr(c.jid) + '">' + esc(c.name || c.jid) + '</option>';
          if (chats.length === 0) opts = '<option value="">-- No channels found (invite the bot first) --</option>';
          sel.innerHTML = opts;
        } catch {
          sel.innerHTML = '<option value="">-- Failed to load channels --</option>';
        }
      };
      populateSlackChannels();
      const refreshLink = document.getElementById('slackRefreshChannels');
      if (refreshLink) refreshLink.addEventListener('click', (e) => { e.preventDefault(); populateSlackChannels(); });
    }

    // WhatsApp: trigger connection immediately, then poll for QR
    if (isWa) {
      fetch('/api/user/channels/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() }, body: JSON.stringify({}) }).catch(() => {});
      let qrPoll = setInterval(async () => {
        try {
          const r = await fetch('/api/user/channels/whatsapp/qr', { headers: { 'X-User-Session': userSession() } });
          const d = await r.json();
          const container = document.getElementById('waQrContainer');
          if (!container) { clearInterval(qrPoll); return; }
          if (d.connected || d.status === 'connected') {
            clearInterval(qrPoll);
            // Fetch discovered WhatsApp chats and show linking UI in same modal
            container.innerHTML = '<div style="padding:16px;text-align:center"><div style="color:var(--color-success);font-size:18px;margin-bottom:8px">&#10003; WhatsApp connected!</div><div class="rsb-hint">Loading your WhatsApp chats...</div></div>';
            // Poll for discovered chats (syncGroupMetadata needs a few seconds)
            let chatAttempts = 0;
            const chatPoll = setInterval(async () => {
              chatAttempts++;
              try {
                const cr = await fetch('/api/chats/discovered?channel=whatsapp', { headers: { 'X-User-Session': userSession() } });
                const cd = await cr.json();
                const chats = (cd.chats || []).filter(c => c.name);
                if (chats.length === 0 && chatAttempts < 10) return; // keep polling
                clearInterval(chatPoll);
                if (chats.length === 0) {
                  container.innerHTML = '<div style="padding:16px">'
                    + '<div style="color:var(--color-success);font-size:18px;margin-bottom:12px">&#10003; WhatsApp connected!</div>'
                    + '<div style="font-size:13px;color:var(--text-secondary);line-height:1.6">No WhatsApp groups found yet. Send a message in any WhatsApp group, then click the button below.</div>'
                    + '<button class="btn btn-accent btn-sm" id="waRefreshChats" style="margin-top:12px">Refresh Chats</button></div>';
                  document.getElementById('waRefreshChats')?.addEventListener('click', async () => {
                    container.innerHTML = '<div class="rsb-hint">Syncing WhatsApp groups...</div>';
                    try { await fetch('/api/channels/whatsapp/sync', { method: 'POST', headers: { 'X-User-Session': userSession() } }); } catch {}
                    chatAttempts = 0;
                    const retry = setInterval(async () => { chatAttempts++; try { const rr = await fetch('/api/chats/discovered?channel=whatsapp', { headers: { 'X-User-Session': userSession() } }); const rd = await rr.json(); const rc = (rd.chats || []).filter(c2 => c2.name); if (rc.length === 0 && chatAttempts < 10) return; clearInterval(retry); showWaLinkUI(container, rc, groupOpts); } catch { clearInterval(retry); } }, 2000);
                  });
                  return;
                }
                showWaLinkUI(container, chats, groupOpts);
              } catch { clearInterval(chatPoll); }
            }, 2000);

            function showWaLinkUI(el, chats, gOpts) {
              if (chats.length === 0) { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">No WhatsApp chats discovered yet.</div>'; return; }
              let chatOpts = '<option value="">-- Select WhatsApp chat --</option>';
              for (const c of chats) chatOpts += '<option value="' + escAttr(c.jid) + '">' + esc(c.name || c.jid) + (c.is_group ? ' (group)' : ' (private)') + '</option>';
              el.innerHTML = '<div style="padding:4px 0">'
                + '<div style="color:var(--color-success);font-size:18px;margin-bottom:14px">&#10003; WhatsApp connected!</div>'
                + '<div class="wt-field"><label class="wt-field-label">WhatsApp Chat</label>'
                + '<select class="wt-field-input" id="waDiscoveredChat" style="width:100%">' + chatOpts + '</select></div>'
                + '<div class="wt-field" style="margin-top:10px"><label class="wt-field-label">Link to Warden Group</label>'
                + '<select class="wt-field-input" id="waTargetGroup" style="width:100%">' + gOpts + '</select></div>'
                + '<button class="btn btn-accent" id="waLinkBtn" style="margin-top:14px;width:100%">Link</button></div>';
              document.getElementById('waLinkBtn').addEventListener('click', async () => {
                const chatJid = document.getElementById('waDiscoveredChat').value;
                const groupJid = document.getElementById('waTargetGroup').value;
                if (!chatJid) { toast('Select a WhatsApp chat', 'warning'); return; }
                if (!groupJid) { toast('Select a Warden group', 'warning'); return; }
                try {
                  const lr = await fetch('/api/channels/whatsapp/link', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() }, body: JSON.stringify({ chatJid, groupJid }) });
                  if (!lr.ok) throw new Error();
                  toast('WhatsApp chat linked!', 'success');
                  document.getElementById('channelLinkModal').remove();
                  loadConnectedAccounts();
                } catch { toast('Failed to link', 'error'); }
              });
            }
          } else if (d.failed || d.status === 'failed') {
            container.innerHTML = '<div style="padding:16px"><div style="color:var(--color-danger,#ef4444);margin-bottom:12px">QR code expired</div>'
              + '<button class="btn btn-accent btn-sm" id="waRetryBtn">Try Again</button></div>';
            clearInterval(qrPoll);
            document.getElementById('waRetryBtn')?.addEventListener('click', () => {
              container.innerHTML = '<div class="rsb-hint">Connecting to WhatsApp...</div>';
              fetch('/api/user/channels/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() }, body: JSON.stringify({}) }).catch(() => {});
              qrPoll = setInterval(arguments.callee, 2000);
            });
          } else if (d.qr) {
            container.innerHTML = '<div style="margin-bottom:10px;font-size:13px;color:var(--text-secondary)">Scan with WhatsApp on your phone:</div>'
              + '<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(d.qr) + '" alt="Scan with WhatsApp" style="border-radius:8px">'
              + '<div style="margin-top:10px;font-size:11px;color:var(--text-tertiary)">WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device</div>';
          }
        } catch {}
      }, 2000);
    }

    const saveBtn = document.getElementById('btnChannelSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const groupJid = document.getElementById('channelGroup').value;
        if (!groupJid) { toast('Please select a group', 'warning'); return; }
        const token = document.getElementById('channelToken').value.trim();
        if (!token) { toast('Token is required', 'error'); return; }

        // For Slack: also get the selected Slack channel
        const slackChatJid = type === 'slack' ? (document.getElementById('slackChannelSelect')?.value || '') : '';
        if (type === 'slack' && !slackChatJid) { toast('Please select a Slack channel', 'warning'); return; }

        try {
          // First, save the token and connect the channel
          const r = await fetch('/api/channels/' + type, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
            body: JSON.stringify({ token, groupJid })
          });
          if (!r.ok) throw new Error();

          // For Slack: also link the selected channel to the group
          if (type === 'slack' && slackChatJid) {
            const lr = await fetch('/api/channels/slack/link', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
              body: JSON.stringify({ chatJid: slackChatJid, groupJid: groupJid })
            });
            if (!lr.ok) {
              const ld = await lr.json().catch(() => ({}));
              toast(ld.error || 'Token saved but failed to link Slack channel', 'warning');
            }
          }

          toast(label + ' connected!', 'success');
        } catch { toast('Failed to connect ' + label, 'error'); }
        document.getElementById('channelLinkModal').remove();
        loadConnectedAccounts();
      });
    }
  }

  async function disconnectChannel(type) {
    if (!confirm('Disconnect ' + type + '?')) return;
    try {
      await fetch('/api/channels/' + encodeURIComponent(type), { method: 'DELETE', headers: { 'X-User-Session': userSession() } });
      toast(type + ' disconnected', 'success');
      loadConnectedAccounts();
    } catch { toast('Failed to disconnect', 'error'); }
  }

  function showWhatsAppQrModal() {
    const overlay = document.createElement('div');
    overlay.id = 'waQrModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div onclick="UserDash.closeWaQrModal()" style="position:absolute;inset:0;background:rgba(0,0,0,0.15);"></div>
      <div class="modal-box" style="max-width:400px;text-align:center;padding:32px;backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--surface-solid,#fff);">
        <h3 style="margin-bottom:8px">Connect WhatsApp</h3>
        <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:20px">Scan this QR code with WhatsApp on your phone</p>
        <div id="waQrImage" style="min-height:200px;display:flex;align-items:center;justify-content:center;">
          <div style="color:var(--text-tertiary)">Generating QR code...</div>
        </div>
        <button class="btn btn-ghost" onclick="UserDash.closeWaQrModal()" style="margin-top:16px">Cancel</button>
      </div>
    `;
    overlay.style.display = 'flex';
    document.body.appendChild(overlay);

    // Poll for QR
    var attempts = 0;
    var pollTimer = setInterval(async () => {
      attempts++;
      if (attempts > 30) { // 60 seconds
        clearInterval(pollTimer);
        document.getElementById('waQrImage').innerHTML = '<div style="color:var(--danger)">Timed out. Try again.</div>';
        return;
      }
      try {
        var r = await fetch('/api/user/channels/whatsapp/qr', { headers: { 'X-User-Session': userSession() } });
        var d = await r.json();
        if (d.status === 'connected') {
          clearInterval(pollTimer);
          closeWaQrModal();
          toast('WhatsApp connected!', 'success');
          loadConnectedAccounts();
          return;
        }
        if (d.qr) {
          document.getElementById('waQrImage').innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(d.qr) + '" alt="Scan with WhatsApp" style="width:256px;height:256px;border-radius:12px;">';
        }
      } catch {}
    }, 2000);

    // Store timer so we can clear on close
    overlay.dataset.pollTimer = pollTimer;
  }

  function closeWaQrModal() {
    var modal = document.getElementById('waQrModal');
    if (modal) {
      if (modal.dataset.pollTimer) clearInterval(parseInt(modal.dataset.pollTimer));
      modal.remove();
    }
  }

  async function connectUserChannel(type) {
    if (type === 'whatsapp') {
      try {
        await fetch('/api/user/channels/whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({})
        });
        showWhatsAppQrModal();
      } catch { toast('Failed to start WhatsApp', 'error'); }
    } else if (type === 'telegram') {
      const token = prompt('Enter your Telegram Bot Token:');
      if (!token) return;
      try {
        await fetch('/api/user/channels/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({ token: token.trim() })
        });
        toast('Telegram bot connected', 'success');
        loadConnectedAccounts();
      } catch { toast('Failed to connect Telegram', 'error'); }
    } else if (type === 'slack') {
      const token = prompt('Enter your Slack Bot Token:');
      if (!token) return;
      try {
        await fetch('/api/user/channels/slack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({ token: token.trim() })
        });
        toast('Slack bot connected', 'success');
        loadConnectedAccounts();
      } catch { toast('Failed to connect Slack', 'error'); }
    }
  }

  async function disconnectUserChannel(type) {
    if (!confirm('Disconnect your ' + type + '?')) return;
    try {
      await fetch('/api/user/channels/' + encodeURIComponent(type), {
        method: 'DELETE',
        headers: { 'X-User-Session': userSession() }
      });
      toast(type + ' disconnected', 'success');
      loadConnectedAccounts();
    } catch { toast('Failed to disconnect', 'error'); }
  }

  async function reconnectUserChannel(type) {
    try {
      if (type === 'whatsapp') {
        await fetch('/api/user/channels/whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({})
        });
        showWhatsAppQrModal();
      } else {
        await fetch('/api/user/channels/' + encodeURIComponent(type) + '/reconnect', {
          method: 'POST',
          headers: { 'X-User-Session': userSession() }
        });
        toast(type + ' reconnecting...', 'success');
        loadConnectedAccounts();
      }
    } catch { toast('Failed to reconnect ' + type, 'error'); }
  }

  async function unlinkWhatsappChat(jid) {
    if (!confirm('Unlink this chat?')) return;
    try {
      const channelType = jid.includes('@g.us') || jid.includes('@s.whatsapp') ? 'whatsapp' : jid.startsWith('tg:') ? 'telegram' : jid.startsWith('slack:') ? 'slack' : 'channel';
      await fetch('/api/channels/' + channelType + '/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
        body: JSON.stringify({ chatJid: jid })
      });
      toast('Chat unlinked', 'success');
      loadConnectedAccounts();
    } catch { toast('Failed to unlink', 'error'); }
  }

  function openLinkDiscoveredChat(chatJid, chatName) {
    // Detect channel type from JID prefix
    const channelType = chatJid.startsWith('slack:') ? 'slack'
      : chatJid.startsWith('telegram:') ? 'telegram'
      : 'whatsapp';
    const channelLabel = channelType === 'slack' ? 'Slack' : channelType === 'telegram' ? 'Telegram' : 'WhatsApp';

    // Build group options from user's allowed web sessions
    const sessions = currentUser?.allowed_sessions || [];
    let groupOpts = '<option value="">-- Select a Warden group --</option>';
    for (const jid of sessions) {
      const g = groupsMap[jid];
      if (g && jid.startsWith('web:')) {
        groupOpts += '<option value="' + escAttr(jid) + '">' + esc(g.name || jid) + '</option>';
      }
    }

    const modalHtml = '<div class="modal-overlay" id="linkDiscoveredModal" style="z-index:10000">'
      + '<div class="modal" style="max-width:400px">'
      + '<div class="modal-header">'
      + '<h3>Link ' + channelLabel + ' Chat</h3>'
      + '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'linkDiscoveredModal\').remove()">&times;</button>'
      + '</div>'
      + '<div class="modal-body" style="padding:20px">'
      + '<div style="margin-bottom:14px;font-size:13px;color:var(--text-secondary)">'
      + 'Link <strong>' + esc(chatName) + '</strong> to a Warden group. Messages from this ' + channelLabel + ' chat will be routed to the selected group.'
      + '</div>'
      + '<div class="wt-field">'
      + '<label class="wt-field-label">Warden Group</label>'
      + '<select class="wt-field-input" id="linkDiscoveredGroup" style="width:100%">' + groupOpts + '</select>'
      + '</div>'
      + '</div>'
      + '<div class="modal-footer" style="justify-content:flex-end;gap:8px">'
      + '<button class="btn btn-ghost" onclick="document.getElementById(\'linkDiscoveredModal\').remove()">Cancel</button>'
      + '<button class="btn btn-accent" id="btnLinkDiscoveredSave">Link</button>'
      + '</div></div></div>';

    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);

    document.getElementById('btnLinkDiscoveredSave').addEventListener('click', async () => {
      const groupJid = document.getElementById('linkDiscoveredGroup').value;
      if (!groupJid) { toast('Please select a group', 'warning'); return; }
      const btn = document.getElementById('btnLinkDiscoveredSave');
      btn.disabled = true;
      btn.textContent = 'Linking...';
      try {
        const r = await fetch('/api/channels/' + channelType + '/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
          body: JSON.stringify({ chatJid: chatJid, groupJid: groupJid })
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || 'Failed to link');
        }
        toast(channelLabel + ' chat linked to group!', 'success');
        document.getElementById('linkDiscoveredModal').remove();
        loadConnectedAccounts();
      } catch (e) {
        toast(e.message || 'Failed to link chat', 'error');
        btn.disabled = false;
        btn.textContent = 'Link';
      }
    });
  }

  function openEmailAccountModal(accountId) {
    const isEdit = !!accountId;
    const account = isEdit ? emailAccounts.find(a => a.id === accountId) : null;
    const isOAuth = account?.oauth_account_id != null;

    document.getElementById('emailAccountModalTitle').textContent = isOAuth ? 'Edit OAuth Email Account (Read Only Toggle Only)' : (isEdit ? 'Edit Email Account' : 'Add Email Account');
    document.getElementById('emailAccountEditId').value = accountId || '';
    if (isEdit) {
      if (account) {
        document.getElementById('emailAccountName').value = account.name;
        document.getElementById('emailAccountEmail').value = account.email;
        document.getElementById('emailImapHost').value = account.imap_host || '';
        document.getElementById('emailImapPort').value = account.imap_port || '993';
        document.getElementById('emailSmtpHost').value = account.smtp_host || '';
        document.getElementById('emailSmtpPort').value = account.smtp_port || '587';
        document.getElementById('emailUsername').value = account.username || '';
        document.getElementById('emailPassword').value = '';
        document.getElementById('emailUseTls').checked = !!account.use_tls;
        document.getElementById('emailReadOnly').checked = !!account.read_only;

        // Disable all fields except read_only toggle for OAuth accounts
        const isReadOnly = isOAuth;
        document.getElementById('emailAccountName').disabled = isReadOnly;
        document.getElementById('emailAccountEmail').disabled = isReadOnly;
        document.getElementById('emailImapHost').disabled = isReadOnly;
        document.getElementById('emailImapPort').disabled = isReadOnly;
        document.getElementById('emailSmtpHost').disabled = isReadOnly;
        document.getElementById('emailSmtpPort').disabled = isReadOnly;
        document.getElementById('emailUsername').disabled = isReadOnly;
        document.getElementById('emailPassword').disabled = isReadOnly;
        document.getElementById('emailPassword').parentElement.style.display = isOAuth ? 'none' : 'block';
        document.getElementById('emailUseTls').disabled = isReadOnly;
      }
    } else {
      // Enable all fields for new accounts
      document.getElementById('emailAccountName').disabled = false;
      document.getElementById('emailAccountEmail').disabled = false;
      document.getElementById('emailImapHost').disabled = false;
      document.getElementById('emailImapPort').disabled = false;
      document.getElementById('emailSmtpHost').disabled = false;
      document.getElementById('emailSmtpPort').disabled = false;
      document.getElementById('emailUsername').disabled = false;
      document.getElementById('emailPassword').disabled = false;
      document.getElementById('emailPassword').parentElement.style.display = 'block';
      document.getElementById('emailUseTls').disabled = false;
      document.getElementById('emailAccountName').value = '';
      document.getElementById('emailAccountEmail').value = '';
      document.getElementById('emailImapHost').value = '';
      document.getElementById('emailImapPort').value = '993';
      document.getElementById('emailSmtpHost').value = '';
      document.getElementById('emailSmtpPort').value = '587';
      document.getElementById('emailUsername').value = '';
      document.getElementById('emailPassword').value = '';
      document.getElementById('emailUseTls').checked = true;
      document.getElementById('emailReadOnly').checked = true;
    }
    updateReadOnlyLabel();
    document.getElementById('emailTestStatus').textContent = '';
    document.getElementById('emailAccountModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('emailAccountName').focus(), 100);
  }

  function closeEmailAccountModal() {
    document.getElementById('emailAccountModal').classList.add('hidden');
  }

  function updateReadOnlyLabel() {
    const readOnly = document.getElementById('emailReadOnly').checked;
    const status = document.getElementById('emailReadOnlyStatus');
    const warning = document.getElementById('emailReadOnlyWarning');
    if (readOnly) {
      status.textContent = 'READ ONLY - Sending disabled';
      status.style.color = 'var(--accent, #10b981)';
      warning.style.display = 'none';
    } else {
      status.textContent = 'SEND ENABLED - AI can send emails';
      status.style.color = 'var(--danger, #ef4444)';
      warning.style.display = '';
    }
  }

  async function saveEmailAccount() {
    const editId = document.getElementById('emailAccountEditId').value;
    const name = document.getElementById('emailAccountName').value.trim();
    const email = document.getElementById('emailAccountEmail').value.trim();
    const imapHost = document.getElementById('emailImapHost').value.trim();
    const imapPort = parseInt(document.getElementById('emailImapPort').value, 10);
    const smtpHost = document.getElementById('emailSmtpHost').value.trim();
    const smtpPort = parseInt(document.getElementById('emailSmtpPort').value, 10);
    const username = document.getElementById('emailUsername').value.trim();
    const password = document.getElementById('emailPassword').value;
    const useTls = document.getElementById('emailUseTls').checked;
    const readOnly = document.getElementById('emailReadOnly').checked;

    // Check if this is an OAuth account
    const existingAccount = editId ? emailAccounts.find(a => a.id === editId) : null;
    const isOAuth = existingAccount?.oauth_account_id != null;

    // For OAuth accounts, only validate read_only field
    if (isOAuth) {
      // Confirmation dialog when enabling send for OAuth
      if (!readOnly) {
        if (!confirm('Are you sure? This will allow the AI to send emails from this OAuth account.')) {
          document.getElementById('emailReadOnly').checked = true;
          updateReadOnlyLabel();
          return;
        }
      }

      // Only send read_only update for OAuth accounts
      try {
        await fetch('/api/email/accounts/' + encodeURIComponent(editId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read_only: readOnly })
        });
        toast('Account updated', 'success');
        closeEmailAccountModal();
        if (currentView === 'settings') renderSettingsEmailAccounts(); else loadEmailView();
      } catch {
        toast('Failed to update account', 'error');
      }
      return;
    }

    // Regular IMAP/SMTP account validation
    if (!name || !email || !imapHost || !smtpHost || !username) {
      toast('Please fill in all required fields', 'warning');
      return;
    }
    if (!editId && !password) {
      toast('Password is required', 'warning');
      return;
    }

    // Confirmation dialog when enabling send
    if (!readOnly) {
      if (!confirm('Are you sure? This will allow the AI to send emails from this account.')) {
        document.getElementById('emailReadOnly').checked = true;
        updateReadOnlyLabel();
        return;
      }
    }

    const body = {
      name, email, imap_host: imapHost, imap_port: imapPort,
      smtp_host: smtpHost, smtp_port: smtpPort,
      username, use_tls: useTls, read_only: readOnly,
      user_id: currentUser ? currentUser.id : null,
    };
    if (password) body.password = password;

    try {
      if (editId) {
        await fetch('/api/email/accounts/' + encodeURIComponent(editId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        toast('Account updated', 'success');
      } else {
        body.password = password;
        await fetch('/api/email/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        toast('Account added', 'success');
      }
      closeEmailAccountModal();
      if (currentView === 'settings') renderSettingsEmailAccounts(); else loadEmailView();
    } catch {
      toast('Failed to save account', 'error');
    }
  }

  async function deleteEmailAccountById(id) {
    if (!confirm('Delete this email account?')) return;
    try {
      await fetch('/api/email/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Account deleted', 'success');
      if (currentEmailAccountId === id) currentEmailAccountId = '';
      if (currentView === 'settings') renderSettingsEmailAccounts(); else loadEmailView();
    } catch {
      toast('Failed to delete account', 'error');
    }
  }

  async function testEmailConnection() {
    const editId = document.getElementById('emailAccountEditId').value;
    if (!editId) {
      toast('Save the account first, then test', 'warning');
      return;
    }
    const status = document.getElementById('emailTestStatus');
    status.textContent = 'Testing...';
    status.style.color = '';
    try {
      const r = await fetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: editId })
      });
      const d = await r.json();
      const imapOk = d.imap && d.imap.ok;
      const smtpOk = d.smtp && d.smtp.ok;
      if (imapOk && smtpOk) {
        status.textContent = 'IMAP + SMTP: Connected';
        status.style.color = 'var(--accent, #10b981)';
      } else {
        const errors = [];
        if (!imapOk) errors.push('IMAP: ' + (d.imap?.error || 'failed'));
        if (!smtpOk) errors.push('SMTP: ' + (d.smtp?.error || 'failed'));
        status.textContent = errors.join(' | ');
        status.style.color = 'var(--danger, #ef4444)';
      }
    } catch {
      status.textContent = 'Test failed';
      status.style.color = 'var(--danger, #ef4444)';
    }
  }

  function openComposeModal() {
    const account = emailAccounts.find(a => a.id === currentEmailAccountId);
    if (!account) { toast('Select an account first', 'warning'); return; }
    if (account.read_only) { toast('Read Only Mode: Cannot send emails from this account.', 'warning'); }
    document.getElementById('composeEmailTo').value = '';
    document.getElementById('composeEmailSubject').value = '';
    document.getElementById('composeEmailBody').value = '';
    document.getElementById('emailComposeModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('composeEmailTo').focus(), 100);
  }

  function closeComposeModal() {
    document.getElementById('emailComposeModal').classList.add('hidden');
  }

  async function sendEmailFromCompose() {
    const to = document.getElementById('composeEmailTo').value.trim();
    const subject = document.getElementById('composeEmailSubject').value.trim();
    const body = document.getElementById('composeEmailBody').value.trim();
    if (!to || !subject) { toast('To and Subject are required', 'warning'); return; }
    try {
      const r = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentEmailAccountId, to, subject, body })
      });
      const d = await r.json();
      if (d.ok) {
        toast('Email sent', 'success');
        closeComposeModal();
      } else {
        toast(d.error || 'Failed to send email', 'error');
      }
    } catch {
      toast('Failed to send email', 'error');
    }
  }

  // --- Settings view (Task 12 merge: handlers moved from deleted admin Warden.* namespace) ---

  async function loadSettingsView() {
    // Re-show the Add Email Account button (loadEmailView() hides it on the Email tab).
    // Only the settings-tab copy needs to be visible; the email-tab copy stays hidden.
    document.querySelectorAll('#btnAddEmailAccount').forEach(b => { b.style.display = ''; });
    const settingsAddBtn = document.querySelector('#view-settings #btnAddEmailAccount');
    if (settingsAddBtn) settingsAddBtn.style.display = '';
    const emailAddBtn = document.querySelector('#view-email #btnAddEmailAccount');
    if (emailAddBtn) emailAddBtn.style.display = 'none';

    // Models must be loaded before settings so dropdowns can restore saved selections
    await refreshModelDropdowns();
    await loadSettingsValues();
    renderSettingsFriendlyNames();
    await renderSettingsEmailAccounts();
    renderChannelsGrid();
    renderApiKeysList();
    populateAgentModelSelects();
  }

  async function renderChannelsGrid() {
    const grid = document.getElementById('channelsGrid');
    if (!grid) return;
    try {
      const r = await fetch('/api/channels');
      const d = await r.json();
      const channels = d.channels || [];
      if (channels.length === 0) {
        grid.innerHTML = '<p class="dim" style="font-size:13px">No channels configured.</p>';
        return;
      }
      grid.innerHTML = channels.map(ch => {
        const status = ch.connected
          ? '<span style="color:#10b981">● Connected</span>'
          : (ch.configured ? '<span style="color:#f59e0b">● Configured, not connected</span>' : '<span style="color:#6b7280">○ Not configured</span>');
        const label = ch.type.charAt(0).toUpperCase() + ch.type.slice(1);
        const icon = ch.type === 'telegram' ? '✈️' : ch.type === 'whatsapp' ? '💬' : ch.type === 'slack' ? '💼' : '🔌';
        return `<div class="setting-card">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <span style="font-size:20px">${icon}</span>
            <div><div class="setting-label">${label}</div>${status}</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="UserDash.openChannelConfig('${ch.type}')">Configure ${label}</button>
        </div>`;
      }).join('');
    } catch (e) {
      grid.innerHTML = '<p class="dim" style="font-size:13px">Failed to load channels.</p>';
    }
  }

  function openChannelConfig(type) {
    if (type === 'telegram') openTelegramModal();
    else if (type === 'whatsapp') openWhatsAppModal();
    else if (type === 'slack') openSlackModal();
  }

  async function renderApiKeysList() {
    const list = document.getElementById('apiKeysList');
    if (!list) return;
    try {
      const r = await fetch('/api/api-keys');
      const d = await r.json();
      const keys = d.keys || [];
      if (keys.length === 0) {
        list.innerHTML = '<p class="dim" style="font-size:13px">No API keys stored.</p>';
        return;
      }
      list.innerHTML = keys.map(k => `<div class="setting-card" style="display:flex;align-items:center;justify-content:space-between">
        <div><div class="setting-label">${esc(k.name || k.id)}</div><div class="dim" style="font-size:.72rem">${esc(k.masked || '••••')}</div></div>
        <button class="btn btn-ghost btn-sm" onclick="UserDash.deleteApiKey('${esc(k.id)}')">Delete</button>
      </div>`).join('');
    } catch (e) {
      list.innerHTML = '<p class="dim" style="font-size:13px">Failed to load API keys.</p>';
    }
  }

  async function addApiKey() {
    const nameEl = document.getElementById('newKeyName');
    const valEl = document.getElementById('newKeyValue');
    if (!nameEl || !valEl) return;
    const name = nameEl.value.trim();
    const value = valEl.value.trim();
    if (!name || !value) { toast('Enter both name and value', 'error'); return; }
    try {
      const r = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      toast('API key added', 'success');
      nameEl.value = ''; valEl.value = '';
      renderApiKeysList();
    } catch (e) {
      toast('Failed to add API key', 'error');
    }
  }

  async function deleteApiKey(id) {
    if (!confirm('Delete this API key?')) return;
    try {
      await fetch('/api/api-keys/' + encodeURIComponent(id), { method: 'DELETE' });
      renderApiKeysList();
    } catch (e) { toast('Failed to delete', 'error'); }
  }

  async function populateAgentModelSelects() {
    const orch = document.getElementById('orchestratorModelSelect');
    const sub = document.getElementById('subagentModelSelect');
    if (!orch || !sub) return;
    const models = cachedOllamaModels;
    const makeLabel = m => cachedOllamaFriendlyNames[m] || m;
    const orchOpts = models.map(m => `<option value="${escAttr(m)}">${esc(makeLabel(m))}</option>`);
    orch.innerHTML = orchOpts.length ? orchOpts.join('') : '<option value="">No models loaded</option>';
    const subOpts = ['<option value="">(same as orchestrator)</option>']
      .concat(models.map(m => `<option value="${escAttr(m)}">${esc(makeLabel(m))}</option>`));
    sub.innerHTML = subOpts.join('');
    try {
      const settings = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
      const atlasVal = (settings.atlasModel || '').replace(/^local:/, '');
      if (atlasVal && Array.from(orch.options).find(o => o.value === atlasVal)) {
        orch.value = atlasVal;
      }
    } catch {}
  }

  async function saveAgentModels() {
    const orchEl = document.getElementById('globalDefaultModelSelect');
    const atlasEl = document.getElementById('orchestratorModelSelect');
    const toolsEl = document.getElementById('ollamaChatModelInput');
    const orchCtxEl = document.getElementById('orchestratorCtxInput');
    const subCtxEl = document.getElementById('subagentCtxInput');
    const status = document.getElementById('agentModelsStatus');
    try {
      const payload = {
        globalDefaultModel: orchEl?.value || '',
        atlasModel: atlasEl?.value || '',
        ollamaChatModel: toolsEl?.value || '',
        orchestratorCtx: orchCtxEl?.value || '',
        subagentCtx: subCtxEl?.value || '',
      };
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (status) { status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 2000); }
      toast('Agent models saved', 'success');
    } catch (e) {
      toast('Failed to save agent models', 'error');
    }
  }

  async function saveGeneralSettings() {
    const name = document.getElementById('assistantNameInput')?.value?.trim();
    const localName = document.getElementById('localAssistantNameInput')?.value?.trim();
    const tz = document.getElementById('timezoneInput')?.value?.trim();
    const status = document.getElementById('generalSettingsStatus');
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantName: name, localAssistantName: localName, timezone: tz }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (status) { status.textContent = 'Saved!'; setTimeout(() => { status.textContent = ''; }, 2000); }
    } catch (e) {
      if (status) status.textContent = 'Failed to save';
    }
  }

  async function loadSettingsValues() {
    try {
      const r = await fetch('/api/settings');
      const d = await r.json();
      const urlEl = document.getElementById('ollamaUrl');
      const modelEl = document.getElementById('ollamaModel');
      if (urlEl && d.ollamaUrl) urlEl.value = d.ollamaUrl;
      if (modelEl && d.ollamaModel) modelEl.value = d.ollamaModel;

      const nameEl = document.getElementById('assistantNameInput');
      const localNameEl = document.getElementById('localAssistantNameInput');
      const tzEl = document.getElementById('timezoneInput');
      if (nameEl && d.assistantName) nameEl.value = d.assistantName;
      if (localNameEl && d.localAssistantName) localNameEl.value = d.localAssistantName;
      if (tzEl && d.timezone) tzEl.value = d.timezone;

      // Populate the orchestrator model select with the same options as the chat dropdown,
      // plus the "Auto" sentinel value (empty string).
      const gdm = document.getElementById('globalDefaultModelSelect');
      if (gdm) {
        const prev = d.orchestratorModel || '';
        let html = '';
        if (cachedOllamaModels.length > 0) {
          html += '<option disabled>── Local ──</option>';
          for (const m of cachedOllamaModels) {
            const label = cachedOllamaFriendlyNames[m] || m.split(':')[0] || m;
            html += '<option value="local:' + esc(m) + '">' + esc(label) + '</option>';
          }
        }
        const MODEL_KEY_TYPES = { 'anthropic-api': 'Claude', 'anthropic-oauth': 'Claude', 'openai-api': 'GPT', 'openai-oauth': 'GPT', 'kimi': 'Kimi', 'deepseek': 'DeepSeek', 'groq': 'Groq', 'gemini': 'Gemini', 'mistral': 'Mistral' };
        const modelKeys = cachedUserKeys.filter(k => MODEL_KEY_TYPES[k.key_type]);
        if (modelKeys.length > 0) {
          html += '<option disabled>── Your Keys ──</option>';
          for (const k of modelKeys) {
            const displayLabel = k.label || MODEL_KEY_TYPES[k.key_type];
            html += '<option value="userkey:' + esc(k.id) + '">' + esc(displayLabel) + '</option>';
          }
        }
        gdm.innerHTML = html;
        if (prev && Array.from(gdm.options).find(o => o.value === prev)) gdm.value = prev;
      }

      // Populate Atlas/Artemis model select
      const atlasSel = document.getElementById('orchestratorModelSelect');
      if (atlasSel) {
        const prev = (d.atlasModel || '').replace(/^local:/, '');
        let html = '';
        if (cachedOllamaModels.length === 0) {
          html = '<option value="">No local models</option>';
        } else {
          for (const m of cachedOllamaModels) {
            const label = cachedOllamaFriendlyNames[m] || m.split(':')[0] || m;
            html += '<option value="' + esc(m) + '">' + esc(label) + '</option>';
          }
        }
        atlasSel.innerHTML = html;
        if (prev && Array.from(atlasSel.options).find(o => o.value === prev)) atlasSel.value = prev;
      }

      // Populate Council seat model selects (Skeptic, Pragmatist, Synthesist).
      // Blank = inherit Atlas/Artemis model.
      const councilSeats = [
        { id: 'councilSkepticModelSelect', key: 'councilSkepticModel' },
        { id: 'councilPragmatistModelSelect', key: 'councilPragmatistModel' },
        { id: 'councilSynthesistModelSelect', key: 'councilSynthesistModel' },
      ];
      for (const seat of councilSeats) {
        const sel = document.getElementById(seat.id);
        if (!sel) continue;
        const prev = (d[seat.key] || '').replace(/^local:/, '');
        let html = '<option value="">(inherit Atlas)</option>';
        if (cachedOllamaModels.length > 0) {
          for (const m of cachedOllamaModels) {
            const label = cachedOllamaFriendlyNames[m] || m.split(':')[0] || m;
            html += '<option value="' + esc(m) + '">' + esc(label) + '</option>';
          }
        }
        sel.innerHTML = html;
        if (prev && Array.from(sel.options).find(o => o.value === prev)) sel.value = prev;
      }

      // Populate the toolcall (subagent) model select with local Ollama models only
      const chatSel = document.getElementById('ollamaChatModelInput');
      if (chatSel) {
        const prev = (d.ollamaChatModel || '').replace(/^local:/, '');
        let html = '';
        if (cachedOllamaModels.length === 0) {
          html = '<option value="">No local models</option>';
        } else {
          for (const m of cachedOllamaModels) {
            const label = cachedOllamaFriendlyNames[m] || m.split(':')[0] || m;
            html += '<option value="' + esc(m) + '">' + esc(label) + '</option>';
          }
        }
        chatSel.innerHTML = html;
        if (prev && Array.from(chatSel.options).find(o => o.value === prev)) chatSel.value = prev;
      }

      // Populate num_ctx override inputs (blank = use model default).
      // Atlas has no override — it always uses the model max.
      const orchCtxEl = document.getElementById('orchestratorCtxInput');
      const subCtxEl = document.getElementById('subagentCtxInput');
      if (orchCtxEl) orchCtxEl.value = d.orchestratorCtx || '';
      if (subCtxEl) subCtxEl.value = d.subagentCtx || '';
    } catch (e) {
      console.error('loadSettingsValues error:', e);
    }
  }

  function renderSettingsFriendlyNames() {
    const container = document.getElementById('ollamaFriendlyList');
    if (!container) return;
    if (cachedOllamaModels.length === 0) {
      container.innerHTML = '<p class="dim" style="font-size:.78rem;">No Ollama models loaded. Start Ollama and click Test Connection.</p>';
      return;
    }
    let html = '';
    for (const m of cachedOllamaModels) {
      const friendly = cachedOllamaFriendlyNames[m] || '';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
        + '<span style="flex:0 0 220px;font-size:.78rem;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(m) + '">' + esc(m) + '</span>'
        + '<input class="form-input" data-model="' + escAttr(m) + '" value="' + escAttr(friendly) + '" placeholder="' + escAttr(m.split(':')[0] || m) + '" style="flex:1;max-width:280px">'
        + '</div>';
    }
    container.innerHTML = html;
  }

  async function renderSettingsEmailAccounts() {
    const list = document.getElementById('adminEmailList');
    if (!list) return;
    try {
      const userId = currentUser ? currentUser.id : '';
      const r = await fetch('/api/email/accounts?userId=' + encodeURIComponent(userId));
      const d = await r.json();
      const accs = d.accounts || [];
      if (accs.length === 0) {
        list.innerHTML = '<p class="dim" style="font-size:13px">No email accounts configured. Click "Add Email Account" to create one.</p>';
        return;
      }
      let html = '';
      for (const a of accs) {
        const ro = a.read_only ? 'READ ONLY' : 'READ WRITE';
        const roColor = a.read_only ? 'var(--accent, #10b981)' : 'var(--danger, #ef4444)';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--color-surface);border-radius:10px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,0.04)">'
          + '<div style="flex:1;min-width:0">'
          + '<div style="font-weight:600;font-size:.9rem">' + esc(a.name) + ' <span style="font-size:.72rem;color:var(--text-tertiary)">(' + esc(a.email) + ')</span></div>'
          + '<div style="font-size:.72rem;color:var(--text-tertiary)">IMAP ' + esc(a.imap_host || '?') + ' &middot; SMTP ' + esc(a.smtp_host || '?') + '</div>'
          + '</div>'
          + '<span style="font-size:.7rem;font-weight:600;color:' + roColor + ';padding:2px 6px;border:1px solid currentColor;border-radius:4px">' + ro + '</span>'
          + '<button class="btn btn-ghost btn-sm" onclick="UserDash.openEmailAccountModal(\'' + escAttr(a.id) + '\')">Edit</button>'
          + '<button class="btn btn-danger btn-sm" onclick="UserDash.deleteEmailAccount(\'' + escAttr(a.id) + '\')">&times;</button>'
          + '</div>';
      }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML = '<p class="dim" style="font-size:13px;color:var(--danger)">Failed to load email accounts</p>';
      console.error('renderSettingsEmailAccounts error:', e);
    }
  }

  async function testOllamaConnection() {
    const status = document.getElementById('ollamaStatus');
    if (status) { status.textContent = 'Testing...'; status.style.color = ''; }
    try {
      const r = await fetch('/api/ollama/test');
      const d = await r.json();
      if (d.ok) {
        if (d.models) cachedOllamaModels = d.models;
        if (d.friendlyNames) cachedOllamaFriendlyNames = d.friendlyNames;
        const msg = d.available
          ? 'Connected. Model "' + (d.model || '') + '" available.'
          : 'Connected, but model "' + (d.model || '') + '" not found locally.';
        if (status) { status.textContent = msg; status.style.color = 'var(--accent, #10b981)'; }
        toast(msg, 'success');
        // Refresh dropdowns + friendly names now that we have models
        loadSettingsValues();
        renderSettingsFriendlyNames();
      } else {
        const msg = d.error || 'Cannot reach Ollama';
        if (status) { status.textContent = msg; status.style.color = 'var(--danger, #ef4444)'; }
        toast(msg, 'error');
      }
    } catch (e) {
      const msg = 'Cannot reach Ollama';
      if (status) { status.textContent = msg; status.style.color = 'var(--danger, #ef4444)'; }
      toast(msg, 'error');
    }
  }

  async function saveOllamaConfig() {
    const ollamaUrl = (document.getElementById('ollamaUrl') || {}).value || '';
    const ollamaModel = (document.getElementById('ollamaModel') || {}).value || '';
    const ollamaChatModel = (document.getElementById('ollamaChatModelInput') || {}).value || '';
    const globalDefaultModel = (document.getElementById('globalDefaultModelSelect') || {}).value || '';
    const atlasModel = (document.getElementById('orchestratorModelSelect') || {}).value || '';
    const councilSkepticModel = (document.getElementById('councilSkepticModelSelect') || {}).value || '';
    const councilPragmatistModel = (document.getElementById('councilPragmatistModelSelect') || {}).value || '';
    const councilSynthesistModel = (document.getElementById('councilSynthesistModelSelect') || {}).value || '';
    const orchestratorCtx = (document.getElementById('orchestratorCtxInput') || {}).value || '';
    const subagentCtx = (document.getElementById('subagentCtxInput') || {}).value || '';
    const body = {
      ollamaUrl,
      ollamaModel,
      ollamaChatModel,
      globalDefaultModel,
      atlasModel,
      councilSkepticModel,
      councilPragmatistModel,
      councilSynthesistModel,
      orchestratorCtx,
      subagentCtx,
    };
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        toast('Model config saved' + (d.restart ? ' — restart may be required for full effect' : ''), 'success');
        const status = document.getElementById('ollamaStatus');
        if (status) { status.textContent = 'Saved'; status.style.color = 'var(--accent, #10b981)'; }
      } else {
        toast(d.error || 'Failed to save config', 'error');
      }
    } catch {
      toast('Failed to save config', 'error');
    }
  }

  async function saveGlobalDefaultModel(value) {
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ globalDefaultModel: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        toast('Default model updated', 'success');
      } else {
        toast(d.error || 'Failed to update default model', 'error');
      }
    } catch {
      toast('Failed to update default model', 'error');
    }
  }

  async function saveFriendlyNames() {
    const inputs = document.querySelectorAll('#ollamaFriendlyList input[data-model]');
    const names = {};
    inputs.forEach(inp => { names[inp.dataset.model] = inp.value.trim(); });
    const status = document.getElementById('friendlyNamesStatus');
    if (status) { status.textContent = 'Saving...'; status.style.color = ''; }
    try {
      const r = await fetch('/api/ollama/model-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        cachedOllamaFriendlyNames = names;
        if (status) { status.textContent = 'Saved'; status.style.color = 'var(--accent, #10b981)'; }
        toast('Friendly names saved', 'success');
      } else {
        if (status) { status.textContent = 'Failed'; status.style.color = 'var(--danger, #ef4444)'; }
        toast('Failed to save friendly names', 'error');
      }
    } catch {
      if (status) { status.textContent = 'Failed'; status.style.color = 'var(--danger, #ef4444)'; }
      toast('Failed to save friendly names', 'error');
    }
  }

  // --- Vault ---

  // --- Heartbeat ---

  async function loadHeartbeat() {
    if (!currentUser) return;
    try {
      const r = await fetch('/api/heartbeat');
      const d = await r.json();
      const editor = document.getElementById('heartbeatEditor');
      if (editor) editor.value = d.content || '';
      const toggle = document.getElementById('heartbeatToggle');
      if (toggle) toggle.checked = !!d.enabled;
      const modelSel = document.getElementById('heartbeatModelSelect');
      if (modelSel && d.model) {
        await refreshModelDropdowns();
        modelSel.value = d.model;
      }
      const status = document.getElementById('heartbeatStatus');
      if (status) {
        if (d.enabled && d.lastRun) {
          const ago = Math.round((Date.now() - new Date(d.lastRun).getTime()) / 60000);
          status.textContent = 'Last run: ' + (ago < 1 ? 'just now' : ago + 'm ago');
        } else if (d.enabled) {
          status.textContent = 'Enabled — waiting for first run';
        } else {
          status.textContent = 'Disabled';
        }
      }
    } catch (e) {
      console.error('Failed to load heartbeat:', e);
    }
  }

  async function saveHeartbeat() {
    if (!currentUser) return;
    const editor = document.getElementById('heartbeatEditor');
    const toggle = document.getElementById('heartbeatToggle');
    const modelSel = document.getElementById('heartbeatModelSelect');
    if (!editor) return;
    try {
      const r = await fetch('/api/heartbeat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: editor.value,
          enabled: toggle ? toggle.checked : false,
          model: modelSel ? modelSel.value : 'sonnet',
        }),
      });
      if (!r.ok) throw new Error('Server returned ' + r.status);
      toast('Heartbeat saved', 'success');
      loadHeartbeat(); // refresh status
    } catch (e) {
      toast('Failed to save heartbeat', 'error');
    }
  }

  // --- Vault ---

  async function loadVault() {
    try {
      const r = await fetch(fileUrl('/api/vault'));
      const d = await r.json();
      renderVaultList(d.entries || []);
    } catch {
      document.getElementById('vaultList').innerHTML = '<div class="empty-state"><p class="empty-title">Unable to load vault</p></div>';
    }
  }

  let currentVaultId = null;
  let currentVaultStatus = null;

  function renderVaultList(entries) {
    const el = document.getElementById('vaultList');
    document.getElementById('vaultDetail').classList.add('hidden');
    currentVaultId = null;
    if (!entries || entries.length === 0) {
      el.innerHTML = '<div class="empty-state"><p class="empty-title">No scrubbed files yet</p></div>';
      return;
    }
    el.innerHTML = entries.map(e => {
      const date = new Date(e.scrubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div class="vault-entry" onclick="UserDash.viewVaultEntry('${escAttr(e.id)}', this)">
        <svg class="vault-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <div class="vault-entry-info">
          <span class="vault-entry-name">${esc(e.originalName || e.id)}</span>
          <span class="vault-entry-meta">${date}</span>
        </div>
        <span class="vault-entry-status">${esc(e.status || 'scrubbed')}</span>
      </div>`;
    }).join('');
  }

  async function viewVaultEntry(id, el) {
    currentVaultId = id;
    const detail = document.getElementById('vaultDetail');
    detail.classList.remove('hidden');

    document.querySelectorAll('.vault-entry').forEach(e => e.classList.remove('selected'));
    if (el) el.classList.add('selected');

    const [scrubRes, mapRes] = await Promise.allSettled([
      fetch(fileUrl('/api/vault/' + encodeURIComponent(id) + '/scrubbed')).then(r => r.json()),
      fetch(fileUrl('/api/vault/' + encodeURIComponent(id) + '/mapping')).then(r => r.json()),
    ]);

    if (scrubRes.status === 'fulfilled' && scrubRes.value.content) {
      const d = scrubRes.value;
      currentVaultStatus = d.entry.status || 'scrubbed';
      document.getElementById('vaultDetailTitle').textContent = d.entry.originalName;
      vaultRawContent = d.content;
      await loadVaultDictionary();
      reHighlightVaultContent();
      // Disable delete until restored
      const delBtn = document.getElementById('btnVaultDelete');
      delBtn.disabled = currentVaultStatus === 'scrubbed';
      delBtn.title = currentVaultStatus === 'scrubbed' ? 'Restore the file first before removing' : '';
    } else {
      document.getElementById('vaultDetailTitle').textContent = '';
      document.getElementById('vaultScrubbedContent').innerHTML = '<p style="color:var(--text-secondary)">Scrubbed content not available.</p>';
    }

    if (mapRes.status === 'fulfilled' && mapRes.value.mapping) {
      const rows = Object.entries(mapRes.value.mapping).map(([ph, val]) =>
        `<div class="vault-mapping-row"><span class="vault-mapping-ph">${esc(ph)}</span><span class="vault-mapping-val">${esc(val)}</span></div>`
      ).join('');
      document.getElementById('vaultMappingContent').innerHTML = rows || '<p style="color:var(--text-secondary)">No mappings</p>';
    } else {
      document.getElementById('vaultMappingContent').innerHTML = '<p style="color:var(--text-secondary)">Mapping not available.</p>';
    }

    showVaultTab('scrubbed');
  }

  function showVaultTab(tab) {
    document.querySelectorAll('.vault-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('vaultScrubbedContent').classList.toggle('hidden', tab !== 'scrubbed');
    document.getElementById('vaultMappingContent').classList.toggle('hidden', tab !== 'mapping');
  }

  async function restoreVaultEntry() {
    if (!currentVaultId) return;
    if (!confirm('Restore original file? This will put back the unscrubbed version.')) return;
    try {
      await fetch(fileUrl('/api/vault/' + encodeURIComponent(currentVaultId) + '/recombine'), { method: 'POST' });
      toast('File restored', 'success');
      loadVault();
    } catch {
      toast('Restore failed', 'error');
    }
  }

  async function deleteVaultEntry() {
    if (!currentVaultId) return;
    if (!confirm('Remove this vault entry? The mapping will be permanently deleted.')) return;
    try {
      await fetch(fileUrl('/api/vault/' + encodeURIComponent(currentVaultId)), { method: 'DELETE' });
      toast('Vault entry removed', 'success');
      loadVault();
    } catch {
      toast('Remove failed', 'error');
    }
  }

  function closeVaultDetail() {
    document.getElementById('vaultDetail').classList.add('hidden');
    document.querySelectorAll('.vault-entry').forEach(e => e.classList.remove('selected'));
    currentVaultId = null;
  }

  // --- Vault Dictionary Quick-Add ---

  let vaultDictionary = null;
  let vaultRawContent = ''; // Raw scrubbed content for re-highlighting

  async function loadVaultDictionary() {
    if (vaultDictionary) return vaultDictionary;
    try {
      const r = await fetch(fileUrl('/api/vault/dictionary'));
      vaultDictionary = await r.json();
    } catch {
      vaultDictionary = {};
    }
    return vaultDictionary;
  }

  async function addToDictionary(word) {
    word = word.trim();
    if (!word || word.length < 2) { toast('Word too short', 'warning'); return; }
    const dict = await loadVaultDictionary();
    if (!dict.custom) dict.custom = [];
    const lower = word.toLowerCase();
    if (dict.custom.some(w => w.toLowerCase() === lower)) { toast('Already in dictionary', 'info'); return; }
    dict.custom.push(word);
    try {
      await fetch(fileUrl('/api/vault/dictionary'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dict),
      });
      vaultDictionary = dict;
      toast('Added "' + word + '" to dictionary', 'success');
      // Re-render with live highlighting
      reHighlightVaultContent();
    } catch {
      toast('Failed to update dictionary', 'error');
    }
  }

  function reHighlightVaultContent() {
    if (!vaultRawContent || !vaultDictionary) return;
    let html = esc(vaultRawContent);
    // Highlight existing placeholders
    html = html.replace(/\[([A-Z_]+_\d+)\]/g, '<span class="ph-highlight">[$1]</span>');
    // Highlight dictionary matches (show what would be scrubbed on next run)
    const allWords = [];
    for (const cat of Object.values(vaultDictionary)) {
      if (Array.isArray(cat)) allWords.push(...cat);
    }
    if (allWords.length) {
      const escaped = allWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(w => w.length >= 2);
      if (escaped.length) {
        const re = new RegExp('\\b(' + escaped.join('|') + ')\\b', 'gi');
        html = html.replace(re, '<span class="dict-match-highlight">$1</span>');
      }
    }
    document.getElementById('vaultScrubbedContent').innerHTML = html;
  }

  // Wire up selection-based quick-add
  function setupVaultDictListeners() {
    const content = document.getElementById('vaultScrubbedContent');
    content.addEventListener('mouseup', function() {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text && text.length >= 2 && text.length < 60 && !/\s{2,}/.test(text)) {
        document.getElementById('vaultDictInput').value = text;
      }
    });
    document.getElementById('btnVaultDictAdd').addEventListener('click', () => {
      const inp = document.getElementById('vaultDictInput');
      addToDictionary(inp.value);
      inp.value = '';
    });
    document.getElementById('vaultDictInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addToDictionary(e.target.value);
        e.target.value = '';
      }
    });
  }

  // --- Notifications (SSE with polling fallback) ---

  let notifPollTimer = null;
  let sseWorking = false;

  function connectSSE() {
    if (!currentUser) return;
    if (sseSource) sseSource.close();
    sseWorking = false;

    const sessionToken = localStorage.getItem('dockbox-user-session') || '';
    const url = '/api/notifications?usersession=' + encodeURIComponent(sessionToken);
    sseSource = new EventSource(url);

    sseSource.onopen = () => {
      sseWorking = true;
      // SSE connected — stop polling fallback immediately
      if (notifPollTimer) { clearInterval(notifPollTimer); notifPollTimer = null; }
    };

    sseSource.onmessage = (event) => {
      try {
        sseWorking = true;
        const data = JSON.parse(event.data);
        if (data.type === 'connected') return;
        showNotification(data);
      } catch {}
    };

    sseSource.onerror = () => {
      sseSource.close();
      sseSource = null;
      // Start polling fallback if SSE fails
      if (!notifPollTimer) startNotifPolling();
      // Try SSE again after 30s
      setTimeout(() => {
        if (currentUser) connectSSE();
      }, 30000);
    };
  }

  function startNotifPolling() {
    if (notifPollTimer || !currentUser) return;
    notifPollTimer = setInterval(pollNotifQueue, 3000);
  }

  async function pollNotifQueue() {
    if (document.hidden) return; // paused while tab is hidden
    if (!currentUser) return;
    try {
      const r = await fetch('/api/notifications/poll');
      if (!r.ok) return;
      const d = await r.json();
      if (d.notifications && d.notifications.length > 0) {
        for (const n of d.notifications) {
          showNotification(n);
        }
      }
    } catch {}
  }

  function startNotifListPolling() {
    fetchNotifications();
    setInterval(fetchNotifications, 30000);
  }

  function showNotification(data) {
    lastNotifType = data.type || '';

      if (data.type === 'alarm') { showAlarmRinging(data.taskId, data.message, '', data.sound || 'default'); return; }

    // Store notification in dropdown — skip chat_complete when user is on chat page
    const skipStore = data.type === 'chat_complete' && currentView === 'chat' && !document.hidden;
    // Show intermediate agent updates as toasts
    if (data.type === 'chat_stream' && data.message) {
      toast(data.message, 'info', 4000);
      return;
    }
    if (data.type === 'agent_activity' && data.line) {
      if (!waitingForReply) return;
      if (data.from && data.from !== currentSession) return;
      var clean = data.line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!clean) return;
      if (clean.startsWith('[agent-runner] Raw stream chunk')) return;
      if (clean.startsWith('{') && clean.includes('"model"')) return;
      var words = clean.split(/\s+/).filter(function(w) { return w; });
      for (var i = 0; i < words.length; i++) thinkingWords.push(words[i]);
      while (thinkingWords.length > 50) thinkingWords.shift();
      var joined = thinkingWords.join(' ');
      var el = document.getElementById('typingStatusText');
      if (el) el.textContent = joined;
      var bar = document.getElementById('thinkingBar');
      var content = document.getElementById('thinkingContent');
      if (bar && content) {
        content.textContent = joined;
        bar.style.display = '';
        bar.classList.add('has-content');
        bar.scrollLeft = bar.scrollWidth;
      }
      return;
    }
    if (!skipStore && (data.type === 'ping' || data.type === 'work_task' || data.type === 'task' || data.type === 'chat_complete')) {
      var notifMsg = data.from ? '[From ' + data.from + '] ' + (data.message || '') : (data.message || '');
      notifications.unshift({
        id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type: data.type,
        message: notifMsg,
        timestamp: new Date().toISOString(),
        read: false,
      });
      // Toast for work tasks and scheduled task completions
      if (data.type === 'work_task' || data.type === 'task') {
        toast(notifMsg, 'info', 5000);
      }
      if (notifications.length > 50) notifications.length = 50;
      renderNotifDropdown();
    }

    // Update badge count = unread notifications + unread chat messages
    const unreadNotifs = notifications.filter(n => !n.read).length;
    const unreadChats = Object.values(unreadSessions).reduce((a, b) => a + b, 0);
    notifCount = unreadNotifs + unreadChats;
    updateNotifBadge();

    // Toast for pings only (not chat messages — those are already visible)
    if (data.type === 'ping') {
      const pingMsg = data.from ? 'Ping from ' + data.from + ': ' + (data.message || '') : (data.message || 'You were pinged!');
      toast(pingMsg, 'error', 8000);
    }

    // Auto-refresh views
    if (data.type === 'work_task' && currentView === 'projects') loadProjects();
    if (data.type === 'chat_complete' && currentView === 'chat') pollChat();

    // Skip browser notification for chat messages when user is on the chat page
    const shouldNotify = data.type !== 'chat_complete' || (document.hidden && currentView !== 'chat');
    if (shouldNotify && Notification.permission === 'granted') {
      try {
        const titles = { chat_complete: 'Message received', work_task: 'New task', task: 'Task completed', ping: 'Ping' };
        const title = titles[data.type] || 'Warden';
        const reg = navigator.serviceWorker?.controller ? navigator.serviceWorker.ready : null;
        const notifTag = data.id || data.taskId || 'notif-' + Date.now();
        if (reg) {
          reg.then(r => r.showNotification(title, {
            body: data.message || 'New notification',
            tag: notifTag,
            vibrate: [200, 100, 200],
            data: { type: data.type },
          })).catch(() => {});
        } else {
          new Notification(title, { body: data.message || 'New notification', tag: notifTag });
        }
      } catch {}
    } else if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function updateNotifBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (notifCount > 0) {
      badge.textContent = notifCount > 99 ? '99+' : notifCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function clearNotifications() {
    markAllNotifRead();
    notifications.length = 0; // Actually clear, not just mark read
    // Reset chat unreads too
    var now = new Date().toISOString();
    var sessions = currentUser?.allowed_sessions || [];
    for (var i = 0; i < sessions.length; i++) {
      lastSeenTimestamps[sessions[i]] = now;
      unreadSessions[sessions[i]] = 0;
    }
    localStorage.setItem('dockbox-last-seen', JSON.stringify(lastSeenTimestamps));
    notifCount = 0;
    updateNotifBadge();
    updateSessionUnreadDots();
    renderNotifDropdown();
  }

  // --- Quick Actions ---

  const QUICK_ACTIONS = [
    // --- Review & Understand ---
    { id: 'analyze_email', name: 'Understand an Email', icon: '\u{1F4E7}', category: 'Review',
      desc: 'Break down an email \u2014 what they want, what to do, and how to reply.',
      fields: [{ label: 'Paste the email', placeholder: 'Paste the email here...', type: 'textarea' }],
      template: 'Analyze this email. Tell me: 1) What they\'re asking for, 2) What I need to do, 3) Any deadlines or expectations, 4) Suggest a reply.\n\n{0}' },

    { id: 'analyze_meeting', name: 'Meeting Notes to To-Dos', icon: '\u{1F4CB}', category: 'Review',
      desc: 'Turn messy meeting notes into clear action items and decisions.',
      fields: [{ label: 'Meeting notes', placeholder: 'Paste your notes or what you remember...', type: 'textarea' }],
      template: 'Go through these meeting notes and pull out: 1) Decisions that were made, 2) Who needs to do what and by when, 3) Questions still open, 4) A quick summary.\n\n{0}' },

    { id: 'compare_options', name: 'Compare Options', icon: '\u2696\uFE0F', category: 'Review',
      desc: 'Help me decide between two choices with pros, cons, and a recommendation.',
      fields: [
        { label: 'Option A', placeholder: 'First choice...', type: 'text' },
        { label: 'Option B', placeholder: 'Second choice...', type: 'text' },
        { label: 'What is this for?', placeholder: 'What are you trying to decide?', type: 'text' }
      ],
      template: 'Help me choose between {0} and {1} for {2}. List the pros and cons of each, the key differences, and give me a clear recommendation with your reasoning.' },

    { id: 'summarize', name: 'Summarize This', icon: '\u{1F4DD}', category: 'Review',
      desc: 'Get a short summary of any long document, article, or text.',
      fields: [
        { label: 'Content to summarize', placeholder: 'Paste the content...', type: 'textarea' },
        { label: 'How long?', placeholder: 'e.g., 3 sentences, a few bullet points, 1 paragraph', type: 'text' }
      ],
      template: 'Summarize this in {1}. Keep the most important points.\n\n{0}' },

    { id: 'analyze_risk', name: 'What Could Go Wrong?', icon: '\u26A0\uFE0F', category: 'Review',
      desc: 'Identify potential problems with a plan and how to avoid them.',
      fields: [{ label: 'Your plan or situation', placeholder: 'Describe what you\'re planning to do...', type: 'textarea' }],
      template: 'Look at this plan and tell me what could go wrong. For each risk, tell me how likely it is, how bad it would be, and what I can do to prevent it.\n\n{0}' },

    // --- Write ---
    { id: 'write_email', name: 'Write an Email', icon: '\u2709\uFE0F', category: 'Write',
      desc: 'Draft a professional email \u2014 just tell me who and what about.',
      fields: [
        { label: 'Who is it to?', placeholder: 'e.g., a client, my boss, a supplier...', type: 'text' },
        { label: 'What about?', placeholder: 'What do you need to say?', type: 'text' },
        { label: 'Key details', placeholder: 'Any specific points to include?', type: 'textarea' }
      ],
      template: 'Write a professional email to {0}.\n\nAbout: {1}\n\nInclude these points:\n{2}\n\nKeep it clear, polite, and to the point.' },

    { id: 'rewrite', name: 'Improve My Writing', icon: '\u2728', category: 'Write',
      desc: 'Make text sound better \u2014 more professional, clearer, or friendlier.',
      fields: [
        { label: 'Your text', placeholder: 'Paste what you wrote...', type: 'textarea' },
        { label: 'How should it sound?', placeholder: 'e.g., more professional, simpler, friendlier', type: 'text' }
      ],
      template: 'Rewrite this to sound {1}. Keep the same meaning but make it better.\n\n{0}' },

    { id: 'write_letter', name: 'Write a Letter', icon: '\u{1F4C3}', category: 'Write',
      desc: 'Draft a formal letter \u2014 business, complaint, thank you, etc.',
      fields: [
        { label: 'Type of letter', placeholder: 'e.g., complaint, thank you, request, cover letter...', type: 'text' },
        { label: 'Who is it to?', placeholder: 'Company or person...', type: 'text' },
        { label: 'Details', placeholder: 'What should it say?', type: 'textarea' }
      ],
      template: 'Write a {0} letter to {1}.\n\nDetails:\n{2}\n\nMake it professional and properly formatted.' },

    { id: 'write_post', name: 'Write a Post', icon: '\u{1F4F0}', category: 'Write',
      desc: 'Write a blog post, social media update, or article.',
      fields: [
        { label: 'Topic', placeholder: 'What should it be about?', type: 'text' },
        { label: 'Who is it for?', placeholder: 'Your audience...', type: 'text' },
        { label: 'Main points', placeholder: 'Key things to cover...', type: 'textarea' }
      ],
      template: 'Write a post about {0} for {1}.\n\nMain points:\n{2}\n\nMake it engaging and easy to read.' },

    // --- Research ---
    { id: 'research_topic', name: 'Research Something', icon: '\u{1F50D}', category: 'Research',
      desc: 'Get a thorough summary on any topic with key facts.',
      fields: [
        { label: 'What to research', placeholder: 'What do you want to know about?', type: 'text' },
        { label: 'Anything specific?', placeholder: 'Any particular questions or angles?', type: 'textarea' }
      ],
      template: 'Research {0} for me. Cover the basics, current situation, important facts, and different viewpoints.\n\nSpecific questions:\n{1}' },

    { id: 'research_company', name: 'Look Up a Company', icon: '\u{1F3E2}', category: 'Research',
      desc: 'Get background on a company \u2014 what they do, key people, recent news.',
      fields: [{ label: 'Company name', placeholder: 'Which company?', type: 'text' }],
      template: 'Research {0}. Tell me: what they do, who runs it, how big they are, recent news, and anything else important to know.' },

    { id: 'explain_topic', name: 'Explain Something to Me', icon: '\u{1F4DA}', category: 'Research',
      desc: 'Get a clear explanation of any topic at your level.',
      fields: [
        { label: 'What do you want explained?', placeholder: 'Topic or question...', type: 'text' },
        { label: 'How familiar are you?', placeholder: 'e.g., total beginner, know a little, very familiar', type: 'text' }
      ],
      template: 'Explain {0} to me. My level: {1}.\n\nStart with the basics, then go deeper. Use examples and plain language.' },

    { id: 'extract_key_points', name: 'Pull Out Key Points', icon: '\u{1F4A1}', category: 'Research',
      desc: 'Extract the important takeaways from any document or article.',
      fields: [{ label: 'Content', placeholder: 'Paste the article, document, or notes...', type: 'textarea' }],
      template: 'Read through this and give me:\n1) The main points (bullet points)\n2) Anything surprising or important\n3) Key quotes if any\n4) What I should do with this information\n\n{0}' },

    // --- Business ---
    { id: 'draft_proposal', name: 'Draft a Proposal', icon: '\u{1F4C4}', category: 'Business',
      desc: 'Create a business proposal for a client or project.',
      fields: [
        { label: 'Client or project', placeholder: 'Who is this for?', type: 'text' },
        { label: 'What are you proposing?', placeholder: 'Describe the work or offer...', type: 'textarea' },
        { label: 'Budget/timeline', placeholder: 'Any pricing or deadlines?', type: 'text' }
      ],
      template: 'Draft a business proposal for {0}.\n\nWhat we\'re proposing:\n{1}\n\nBudget/timeline: {2}\n\nInclude: overview, what we\'ll deliver, timeline, pricing, and next steps.' },

    { id: 'draft_invoice', name: 'Create an Invoice', icon: '\u{1F4B0}', category: 'Business',
      desc: 'Generate an invoice for a client with line items and totals.',
      fields: [
        { label: 'Client name', placeholder: 'Who to bill?', type: 'text' },
        { label: 'Work done', placeholder: 'Describe the items or services...', type: 'textarea' },
        { label: 'Rates/amounts', placeholder: 'Hourly rate, per item, or flat fee...', type: 'text' }
      ],
      template: 'Create an invoice for {0}.\n\nWork:\n{1}\n\nRates: {2}\n\nInclude line items, subtotal, tax, and total. Format it professionally.' },

    { id: 'swot', name: 'Strengths & Weaknesses', icon: '\u{1F4CA}', category: 'Business',
      desc: 'Analyze the strengths, weaknesses, opportunities and threats of something.',
      fields: [
        { label: 'What to analyze', placeholder: 'Your business, a product, an idea...', type: 'text' },
        { label: 'Background', placeholder: 'Any context that helps...', type: 'textarea' }
      ],
      template: 'Do a strengths and weaknesses analysis for {0}.\n\nBackground: {1}\n\nCover: Strengths, Weaknesses, Opportunities, and Threats. Give specific points for each and end with recommendations.' },

    { id: 'draft_contract', name: 'Draft an Agreement', icon: '\u{1F4DD}', category: 'Business',
      desc: 'Create a basic agreement or contract between two parties.',
      fields: [
        { label: 'Type', placeholder: 'e.g., service agreement, partnership, NDA...', type: 'text' },
        { label: 'Between who?', placeholder: 'e.g., My Company and Client Name', type: 'text' },
        { label: 'Key terms', placeholder: 'What should it cover?', type: 'textarea' }
      ],
      template: 'Draft a {0} between {1}.\n\nKey terms:\n{2}\n\nMake it professional and cover the important legal basics. Note this is a draft and should be reviewed by a lawyer.' },

    // --- Planning ---
    { id: 'brainstorm', name: 'Brainstorm Ideas', icon: '\u{1F9E0}', category: 'Planning',
      desc: 'Generate a list of creative ideas for any challenge.',
      fields: [
        { label: 'What do you need ideas for?', placeholder: 'Describe the challenge...', type: 'textarea' },
        { label: 'Any limits?', placeholder: 'Budget, timeline, resources...', type: 'text' }
      ],
      template: 'Give me 10 ideas for:\n{0}\n\nLimitations: {1}\n\nFor each idea: a short name, what it is, why it could work, and how hard it would be (Easy/Medium/Hard).' },

    { id: 'project_plan', name: 'Make a Project Plan', icon: '\u{1F5D3}\uFE0F', category: 'Planning',
      desc: 'Break a big project into phases, steps, and deadlines.',
      fields: [
        { label: 'Project', placeholder: 'What\'s the project?', type: 'text' },
        { label: 'Details', placeholder: 'What needs to happen? Any deadlines?', type: 'textarea' }
      ],
      template: 'Create a project plan for {0}.\n\nDetails:\n{1}\n\nBreak it into phases with steps, who does what, and suggested timeline.' },

    { id: 'presentation', name: 'Presentation Outline', icon: '\u{1F3A4}', category: 'Planning',
      desc: 'Create a slide-by-slide outline for a presentation.',
      fields: [
        { label: 'Topic', placeholder: 'What\'s the presentation about?', type: 'text' },
        { label: 'Audience', placeholder: 'Who are you presenting to?', type: 'text' },
        { label: 'How long?', placeholder: 'e.g., 10 minutes, 30 minutes', type: 'text' }
      ],
      template: 'Create a presentation outline for a {2} talk about {0} for {1}.\n\nGive me: slide titles, key points for each slide, and notes on what to say.' },

    { id: 'checklist', name: 'Make a Checklist', icon: '\u2705', category: 'Planning',
      desc: 'Turn any task into a step-by-step checklist.',
      fields: [{ label: 'What needs to get done?', placeholder: 'Describe the task...', type: 'textarea' }],
      template: 'Create a detailed step-by-step checklist for:\n{0}\n\nMake sure nothing is missed. Order the steps logically.' },

    // --- Code (review_code and explain_code adapted from Fabric patterns by danielmiessler) ---
    { id: 'code_review', name: 'Code Review', icon: '\u{1F50D}', category: 'Code',
      desc: 'Principal engineer-level review for correctness, security, performance, and style.',
      fields: [{ label: 'Paste the code', placeholder: 'Paste code here...', type: 'textarea' }, { label: 'Language / context', placeholder: 'e.g. TypeScript, React component, API endpoint', type: 'text' }],
      template: 'You are a Principal Software Engineer renowned for meticulous, constructive code reviews.\n\nReview this {1} code systematically:\n\n1. **Correctness** \u2014 logic errors, off-by-one, race conditions, incorrect API usage\n2. **Security** \u2014 injection, XSS, auth bypass, secrets exposure, OWASP Top 10\n3. **Performance** \u2014 unnecessary allocations, N+1 queries, blocking I/O, algorithmic complexity\n4. **Readability & Maintainability** \u2014 naming, structure, single responsibility, dead code\n5. **Best Practices & Idiomatic Style** \u2014 language conventions, modern syntax, proper error handling\n6. **Edge Cases** \u2014 null/undefined, empty inputs, boundary values, concurrency\n\nFor each finding give: the original code snippet, suggested improvement, and rationale. Prioritize by severity (critical > high > medium > low). End with an overall assessment.\n\n```\n{0}\n```' },
    { id: 'code_explain', name: 'Explain Code', icon: '\u{1F4D6}', category: 'Code',
      desc: 'Break down code, config, or tool output in plain English.',
      fields: [{ label: 'Paste the code', placeholder: 'Paste code, config, error output...', type: 'textarea' }],
      template: 'You are an expert at explaining code, documentation, configuration, and security tool output to people of varying technical backgrounds.\n\nAnalyze the following and provide:\n\n1. **EXPLANATION** \u2014 a plain-English walkthrough of what this does, step by step. Cover inputs, outputs, control flow, and side effects.\n2. **KEY CONCEPTS** \u2014 any patterns, algorithms, or techniques used and why they matter.\n3. **SECURITY IMPLICATIONS** \u2014 any security-relevant aspects (auth, data handling, permissions, network calls).\n4. **DEPENDENCIES** \u2014 what this relies on and what relies on it.\n\nUse clear, jargon-free language. When you must use a technical term, briefly define it.\n\n```\n{0}\n```' },
    { id: 'code_refactor', name: 'Refactor Code', icon: '\u{267B}\u{FE0F}', category: 'Code',
      desc: 'Improve code structure and clarity while preserving exact behavior.',
      fields: [{ label: 'Paste the code', placeholder: 'Paste code here...', type: 'textarea' }, { label: 'What to improve', placeholder: 'e.g. readability, performance, split into functions', type: 'text' }],
      template: 'You are a senior software engineer who specializes in refactoring code to be cleaner, more maintainable, and more idiomatic without changing external behavior.\n\nGoal: {1}\n\nFor each change:\n1. Show the before and after\n2. Explain why the change is better\n3. Confirm it preserves the original behavior\n\nDo NOT add unnecessary abstractions, new dependencies, or features. Keep it simple. The best refactor is the smallest one that achieves the goal.\n\n```\n{0}\n```' },
    { id: 'code_debug', name: 'Debug Code', icon: '\u{1F41B}', category: 'Code',
      desc: 'Systematically find and fix bugs from symptoms or error messages.',
      fields: [{ label: 'Paste the code', placeholder: 'Paste code here...', type: 'textarea' }, { label: 'What\'s wrong?', placeholder: 'Error message, unexpected behavior, stack trace...', type: 'textarea' }],
      template: 'You are a senior debugger who systematically isolates root causes.\n\nThe problem:\n{1}\n\nAnalyze this code and:\n1. **REPRODUCE** \u2014 identify the exact conditions that trigger the bug\n2. **ROOT CAUSE** \u2014 explain why it happens at a technical level\n3. **FIX** \u2014 provide the minimal code change that resolves the issue\n4. **VERIFY** \u2014 explain how to confirm the fix works and doesn\'t break anything else\n5. **PREVENT** \u2014 suggest how to prevent similar bugs in future (tests, types, linting)\n\n```\n{0}\n```' },
    { id: 'code_write', name: 'Write Code', icon: '\u{1F4BB}', category: 'Code',
      desc: 'Generate production-ready code from a description.',
      fields: [{ label: 'What should it do?', placeholder: 'Describe the function, feature, or script...', type: 'textarea' }, { label: 'Language / framework', placeholder: 'e.g. Python, TypeScript, React, Node.js', type: 'text' }],
      template: 'You are an elite programmer who writes secure, composable, production-ready code.\n\nLanguage/framework: {1}\n\nRequirements:\n{0}\n\nProvide:\n1. **SUMMARY** \u2014 one paragraph on the approach\n2. **CODE** \u2014 complete, working implementation with clear comments on non-obvious parts\n3. **STRUCTURE** \u2014 file/function layout if multiple files are needed\n4. **SETUP** \u2014 any dependencies or configuration required\n5. **USAGE** \u2014 example of how to call/run it\n\nAssume users are potentially malicious \u2014 validate inputs, handle errors, never trust external data. Use no deprecated features.' },
    { id: 'code_test', name: 'Write Tests', icon: '\u{2705}', category: 'Code',
      desc: 'Generate comprehensive unit tests with edge cases.',
      fields: [{ label: 'Paste the code to test', placeholder: 'Paste code here...', type: 'textarea' }, { label: 'Test framework', placeholder: 'e.g. vitest, jest, pytest, go test', type: 'text' }],
      template: 'You are a senior QA engineer who writes thorough, maintainable test suites.\n\nTest framework: {1}\n\nWrite tests for this code covering:\n1. **Happy paths** \u2014 normal expected usage\n2. **Edge cases** \u2014 empty inputs, boundary values, max/min, unicode, special chars\n3. **Error cases** \u2014 invalid inputs, network failures, timeouts, null/undefined\n4. **Security cases** \u2014 injection attempts, oversized inputs, auth bypass attempts\n\nEach test should have a clear name describing what it verifies. Use arrange-act-assert pattern. Mock external dependencies only when necessary \u2014 prefer real implementations where possible.\n\n```\n{0}\n```' },
    // --- Setup ---
    { id: 'setup_wizard', name: 'Run Setup Wizard', icon: '\u{1F680}', category: 'Setup',
      desc: 'Walk through onboarding \u2014 set your name, preferences, and explore features.',
      fields: [],
      template: 'Run the setup wizard. Read /workspace/global/SETUP_WIZARD.md and follow the re-run instructions. Walk me through setup again.' },
    { id: 'systems_check', name: 'Systems Check', icon: '\u{1F50D}', category: 'Setup',
      desc: 'Test all tools and integrations to make sure everything works.',
      fields: [],
      template: 'Run a full systems check. Read /workspace/global/SYSTEMS_CHECK.md and follow it. Test every tool category and report results.' },
  ];

  const ACTION_CATEGORIES = ['Setup', 'Review', 'Write', 'Research', 'Business', 'Planning', 'Code', 'Teams'];

  function renderActions(filter) {
    const grid = document.getElementById('actionsGrid');
    const q = (filter || document.getElementById('actionsSearch').value || '').toLowerCase();

    let html = '';
    for (const cat of ACTION_CATEGORIES) {
      const items = QUICK_ACTIONS.filter(a => a.category === cat && (!q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)));
      if (!items.length) continue;

      html += `<div class="action-category">
        <h3 class="action-category-title">${esc(cat)}</h3>
        <div class="action-category-grid">`;

      for (const a of items) {
        html += `<div class="action-card" onclick="UserDash.openPromptBuilder('${escAttr(a.id)}')">
          <div class="action-icon">${a.icon}</div>
          <div class="action-name">${esc(a.name)}</div>
          <div class="action-desc">${esc(a.desc)}</div>
        </div>`;
      }

      html += `</div></div>`;
    }

    grid.innerHTML = html || '<div class="empty-state"><p class="empty-title">No matching actions</p></div>';
  }

  function openPromptBuilder(actionId) {
    const action = QUICK_ACTIONS.find(a => a.id === actionId);
    if (!action) return;

    // Setup wizard opens its own modal
    if (actionId === 'setup_wizard') {
      navigateTo('chat');
      openSetupWizard();
      return;
    }

    // Zero-field actions send immediately without opening the modal
    if (!action.fields || action.fields.length === 0) {
      navigateTo('chat');
      const input = document.getElementById('chatInput');
      if (input) {
        input.value = action.template;
        sendChat();
      }
      return;
    }

    currentPromptTemplate = action;
    promptAttachedFiles = [];
    promptBrowserPath = '.';

    document.getElementById('promptBuilderTitle').textContent = action.icon + ' ' + action.name;

    // Render fields
    const fieldsEl = document.getElementById('promptFields');
    fieldsEl.innerHTML = action.fields.map((f, i) => {
      if (f.type === 'textarea') {
        return `<div class="prompt-field">
          <label class="prompt-field-label">${esc(f.label)}</label>
          <textarea class="prompt-field-input prompt-textarea" id="promptField${i}" placeholder="${escAttr(f.placeholder)}" oninput="UserDash.updatePromptPreview()"></textarea>
        </div>`;
      }
      return `<div class="prompt-field">
        <label class="prompt-field-label">${esc(f.label)}</label>
        <input class="prompt-field-input" id="promptField${i}" placeholder="${escAttr(f.placeholder)}" oninput="UserDash.updatePromptPreview()">
      </div>`;
    }).join('');

    updatePromptPreview();
    document.getElementById('promptFileSearch').value = '';
    const swarmEl = document.getElementById('promptSwarmToggle');
    const teamEl = document.getElementById('promptTeamToggle');
    if (swarmEl) swarmEl.checked = false;
    if (teamEl) teamEl.checked = false;
    document.getElementById('promptBuilderModal').classList.remove('hidden');
    loadAllPromptFiles().then(() => renderPromptFileList(''));

    // Focus first field
    setTimeout(() => {
      const first = document.getElementById('promptField0');
      if (first) first.focus();
    }, 100);
  }

  // ── Setup Wizard ──────────────────────────────────────────
  let _wizStep = 0;
  const _wizData = {};
  const _wizSteps = [
    { title: 'Welcome',
      html: () => `
        <p style="margin:0 0 16px;color:var(--text-secondary)">Let\u2019s get your workspace set up. This takes about a minute.</p>
        <div class="wt-field">
          <label class="wt-field-label">What should I call you?</label>
          <input class="wt-field-input" id="wiz_name" placeholder="Your name" value="${esc(_wizData.name || '')}">
        </div>
        <div class="wt-field">
          <label class="wt-field-label">What do you do?</label>
          <input class="wt-field-input" id="wiz_role" placeholder="e.g. Marketing lead, Developer, Founder" value="${esc(_wizData.role || '')}">
        </div>
        <div class="wt-field">
          <label class="wt-field-label">Timezone</label>
          <input class="wt-field-input" id="wiz_timezone" placeholder="e.g. America/New_York, Europe/London" value="${esc(_wizData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '')}">
        </div>` },
    { title: 'What Makes This Different',
      html: () => `
        <p style="margin:0 0 14px;font-weight:600;color:var(--text-primary);font-size:15px">This is not a chatbot. This is an agent.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 14px">
          <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;font-size:13px;line-height:1.6">
            <div style="font-weight:600;margin-bottom:6px;color:var(--text-tertiary)">A chatbot...</div>
            <div>Answers questions</div>
            <div>Forgets after each message</div>
            <div>Can only type back to you</div>
          </div>
          <div style="background:var(--accent);color:#fff;border-radius:8px;padding:12px;font-size:13px;line-height:1.6">
            <div style="font-weight:600;margin-bottom:6px">Your agent...</div>
            <div>Completes entire tasks</div>
            <div>Reads files, calls APIs, sends emails</div>
            <div>Chains 200+ actions from one prompt</div>
          </div>
        </div>
        <p style="margin:0 0 10px;color:var(--text-secondary);line-height:1.5;font-size:13px"><strong>Give it a job, not a question.</strong> Instead of \u201CWhat are renewable energy trends?\u201D say \u201CResearch renewable energy trends, write a summary, generate a PDF, and email it to sarah@company.com.\u201D It will do all of that.</p>
        <p style="margin:0 0 10px;color:var(--text-secondary);line-height:1.5;font-size:13px"><strong>One prompt at a time.</strong> Don\u2019t send follow-ups while it\u2019s working. If you need to change course, hit the stop button first, then send a new prompt.</p>
        <p style="margin:0;color:var(--text-secondary);line-height:1.5;font-size:13px"><strong>It can build things.</strong> Scripts, web pages, dashboards, automated workflows, data analysis \u2014 if you can describe it, it can probably make it.</p>` },
    { title: 'Meet Warden',
      html: () => `
        <p style="margin:0 0 12px;color:var(--text-secondary);line-height:1.5;font-size:13px">Your assistant is called <strong>Warden</strong>. It\u2019s the same assistant across all models \u2014 same workspace, same memory, same tools. The difference is personality and speed.</p>
        <div style="display:flex;flex-direction:column;gap:8px;margin:0 0 12px">
          <div style="border:2px solid var(--accent);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5">
            <div style="font-weight:600;color:var(--accent)">Default <span style="font-weight:400;color:var(--text-tertiary)">(recommended)</span></div>
            <div style="color:var(--text-secondary)">Thorough and detailed. Takes its time to think things through. Best for complex tasks, research, writing, and anything that benefits from careful reasoning.</div>
          </div>
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5">
            <div style="font-weight:600">Alt</div>
            <div style="color:var(--text-secondary)">Powerful and thorough. Overkill for most everyday tasks, but excellent when you want a second opinion or need heavy-duty reasoning.</div>
          </div>
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5">
            <div style="font-weight:600">Fast</div>
            <div style="color:var(--text-secondary)">Lightweight, runs on modest hardware. Use this to test if your workflow can go completely offline. If Fast handles what you need, you can run the entire AI on your own machine without any cloud dependency.</div>
          </div>
        </div>
        <p style="margin:0;color:var(--text-secondary);line-height:1.5;font-size:13px">You can switch models any time using the dropdown in the chat view. Start with <strong>Default</strong> \u2014 switch to others once you know what you need.</p>` },
    { title: 'Starting Fresh',
      html: () => `
        <p style="margin:0 0 12px;font-weight:600;color:var(--text-primary);font-size:15px">Every message carries history.</p>
        <p style="margin:0 0 10px;color:var(--text-secondary);line-height:1.5;font-size:13px">Each time you send a message, the entire conversation history is included. After 20 or 30 messages, that history gets long \u2014 it costs more tokens, slows things down, and can confuse the agent with old context.</p>
        <div style="background:var(--bg-secondary);border-radius:8px;padding:12px 14px;margin:0 0 12px">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">The \u201CNew Thought\u201D button</div>
          <p style="margin:0 0 8px;color:var(--text-secondary);font-size:13px;line-height:1.5">Click it in the chat header when you\u2019re switching topics or starting a new task. It clears the conversation context so the agent starts fresh \u2014 no confusion, no wasted tokens.</p>
          <p style="margin:0;color:var(--text-secondary);font-size:13px;line-height:1.5">Think of it like closing one browser tab and opening another. Your files and memory are still there \u2014 just the conversation resets.</p>
        </div>
        <p style="margin:0;color:var(--text-secondary);line-height:1.5;font-size:13px"><strong>Rule of thumb:</strong> Finished a task? Click New Thought before starting the next one.</p>` },
    { title: 'Your Dashboard',
      html: () => `
        <p style="margin:0 0 12px;color:var(--text-secondary);font-size:13px">Here\u2019s what you can do from each tab:</p>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.5">
          <div><strong>Chat</strong> \u2014 Give Warden tasks. One clear prompt per task. Be specific about what you want.</div>
          <div><strong>Quick Actions</strong> \u2014 Pre-built prompts that work well out of the box. Great place to start.</div>
          <div><strong>Talk</strong> \u2014 Speak to Warden instead of typing. Same capabilities, just hands-free.</div>
          <div><strong>Email</strong> \u2014 Read and send emails. Connect your account in Connected Accounts first.</div>
          <div><strong>SMS</strong> \u2014 Send and receive text messages through connected phone numbers.</div>
          <div><strong>Files</strong> \u2014 Your workspace. Everything Warden creates lives here \u2014 documents, PDFs, code, data.</div>
          <div><strong>Projects</strong> \u2014 Track projects with deliverables, blockers, budgets, and timelines.</div>
          <div><strong>Calendar</strong> \u2014 View and manage events. Syncs with Google or Outlook.</div>
          <div><strong>Schedules</strong> \u2014 Automated tasks that run on a timer \u2014 daily briefings, reminders, periodic checks.</div>
          <div><strong>Heartbeat</strong> \u2014 Instructions Warden follows every hour, like monitoring your inbox.</div>
          <div><strong>Alarms</strong> \u2014 Set alarms with sound notifications for deadlines and reminders.</div>
        </div>` },
    { title: 'Preferences',
      html: () => `
        <p style="margin:0 0 16px;color:var(--text-secondary)">A few preferences to tailor your experience.</p>
        <div class="wt-field">
          <label class="wt-field-label">Communication style</label>
          <select class="wt-field-input" id="wiz_style">
            <option value="brief"${_wizData.style === 'brief' ? ' selected' : ''}>Brief and direct</option>
            <option value="detailed"${_wizData.style === 'detailed' ? ' selected' : ''}>Detailed and thorough</option>
          </select>
        </div>
        <div class="wt-field">
          <label class="wt-field-label">What are you most interested in?</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px" id="wiz_interests">
            ${['Project Management','Task Tracking','Email & Inbox','Calendar & Events','Scheduling & Automations','Documents & PDFs','Data Analysis & Charts','Web Scraping & Research','Build Dashboards','Build Web Apps','Python Scripts & Tools','Image Generation','Spreadsheets & CSV','SMS & Notifications','API Integrations','Code & Development','Database & SQL','Social Media Management'].map(f =>
              `<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:13px${(_wizData.interests || []).includes(f) ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}">
                <input type="checkbox" value="${f}" style="display:none" ${(_wizData.interests || []).includes(f) ? 'checked' : ''} onchange="this.parentElement.style.background=this.checked?'var(--accent)':'';this.parentElement.style.color=this.checked?'#fff':'';this.parentElement.style.borderColor=this.checked?'var(--accent)':'var(--border)'">${f}</label>`
            ).join('')}
          </div>
        </div>
        <div class="wt-field">
          <label class="wt-field-label">Anything else I should know? (optional)</label>
          <textarea class="wt-field-input" id="wiz_notes" rows="3" placeholder="Team context, current projects, how you work...">${esc(_wizData.notes || '')}</textarea>
        </div>` },
    { title: 'Your Apps',
      html: () => `
        <p style="margin:0 0 8px;color:var(--text-secondary)">Which apps do you use? I can open, control, and automate these on your desktop.</p>
        <div class="wt-field">
          <label class="wt-field-label">Apps & Tools</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px" id="wiz_tools">
            ${['Chrome','Firefox','Brave','Discord','Telegram','WhatsApp','Signal','Spotify','YouTube','VLC','Plex','VS Code','Cursor','Obsidian','Notion','Google Drive','Dropbox','OneDrive','Gmail','GitHub','Docker','Zoom','OBS Studio','TeamViewer','Twitter / X'].map(f =>
              `<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:13px${(_wizData.tools || []).includes(f) ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}">
                <input type="checkbox" value="${f}" style="display:none" ${(_wizData.tools || []).includes(f) ? 'checked' : ''} onchange="this.parentElement.style.background=this.checked?'var(--accent)':'';this.parentElement.style.color=this.checked?'#fff':'';this.parentElement.style.borderColor=this.checked?'var(--accent)':'var(--border)'">${f}</label>`
            ).join('')}
          </div>
        </div>
        <div class="wt-field">
          <label class="wt-field-label">Other apps not listed (optional)</label>
          <input class="wt-field-input" id="wiz_other_tools" placeholder="e.g. Krita, Blender, Steam..." value="${esc(_wizData.other_tools || '')}">
        </div>` },
    { title: 'All Set',
      html: () => `
        <p style="margin:0 0 12px;font-weight:600;color:var(--text-primary)">Here's what I've got:</p>
        <div style="background:var(--bg-secondary);border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.6">
          <div><strong>Name:</strong> ${esc(_wizData.name || 'Not set')}</div>
          <div><strong>Role:</strong> ${esc(_wizData.role || 'Not set')}</div>
          <div><strong>Timezone:</strong> ${esc(_wizData.timezone || 'Not set')}</div>
          <div><strong>Style:</strong> ${_wizData.style === 'detailed' ? 'Detailed and thorough' : 'Brief and direct'}</div>
          <div><strong>Interests:</strong> ${(_wizData.interests || []).join(', ') || 'None selected'}</div>
          <div><strong>Tools:</strong> ${[...(_wizData.tools || []), ...(_wizData.other_tools ? _wizData.other_tools.split(',').map(s => s.trim()).filter(Boolean) : [])].join(', ') || 'None selected'}</div>
          ${_wizData.notes ? '<div><strong>Notes:</strong> ' + esc(_wizData.notes) + '</div>' : ''}
        </div>
        <p style="margin:12px 0 0;color:var(--text-secondary)">I'll save your profile, install dependencies, set up API docs and folders for your tools, and greet you in chat. This may take a minute.</p>` },
  ];

  function _wizCollect() {
    if (_wizStep === 0) {
      _wizData.name = (document.getElementById('wiz_name')?.value || '').trim();
      _wizData.role = (document.getElementById('wiz_role')?.value || '').trim();
      _wizData.timezone = (document.getElementById('wiz_timezone')?.value || '').trim();
    } else if (_wizStep === 5) {
      _wizData.style = document.getElementById('wiz_style')?.value || 'brief';
      _wizData.interests = Array.from(document.querySelectorAll('#wiz_interests input:checked')).map(el => el.value);
      _wizData.notes = (document.getElementById('wiz_notes')?.value || '').trim();
    } else if (_wizStep === 6) {
      _wizData.tools = Array.from(document.querySelectorAll('#wiz_tools input:checked')).map(el => el.value);
      _wizData.other_tools = (document.getElementById('wiz_other_tools')?.value || '').trim();
    }
  }

  function _wizRender() {
    const step = _wizSteps[_wizStep];
    document.getElementById('setupWizardTitle').textContent = step.title;
    document.getElementById('setupWizardBody').innerHTML = step.html();
    document.getElementById('setupWizardBack').style.display = _wizStep > 0 ? '' : 'none';
    const nextBtn = document.getElementById('setupWizardNext');
    nextBtn.textContent = _wizStep === _wizSteps.length - 1 ? 'Finish Setup' : 'Next';
  }

  function openSetupWizard() {
    _wizStep = 0;
    Object.keys(_wizData).forEach(k => delete _wizData[k]);
    _wizRender();
    document.getElementById('setupWizardModal').classList.remove('hidden');
  }

  function closeSetupWizard() {
    document.getElementById('setupWizardModal').classList.add('hidden');
  }

  function setupWizardBack() {
    _wizCollect();
    if (_wizStep > 0) { _wizStep--; _wizRender(); }
  }

  async function setupWizardNext() {
    _wizCollect();
    if (_wizStep === 0 && !_wizData.name) {
      document.getElementById('wiz_name')?.focus();
      return;
    }
    if (_wizStep < _wizSteps.length - 1) {
      _wizStep++;
      _wizRender();
      return;
    }
    // Final step — save profile and send prompt
    _wizData.setup_date = new Date().toISOString().split('T')[0];
    const profileJson = JSON.stringify(_wizData, null, 2);
    // Upload user_profile.json to the group workspace
    try {
      const gFolder = groupsMap[currentSession]?.folder || '';
      await fetch(fileUrl('/api/files/upload?path=' + encodeURIComponent(gFolder)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'user_profile.json' },
        body: profileJson
      });
    } catch (e) { console.warn('Failed to upload profile:', e); }
    // Create .setup_complete so the wizard doesn't re-trigger on next login
    try {
      const gFolder = groupsMap[currentSession]?.folder || '';
      await fetch(fileUrl('/api/files/upload?path=' + encodeURIComponent(gFolder)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': '.setup_complete' },
        body: 'Setup completed: ' + _wizData.setup_date + '\nUser: ' + (_wizData.name || 'unknown') + '\n'
      });
    } catch (e) { console.warn('Failed to create .setup_complete:', e); }
    // Send the setup prompt to chat
    closeSetupWizard();
    const input = document.getElementById('chatInput');
    if (input) {
      input.value = 'Read user_profile.json in my workspace. Follow the instructions in /workspace/global/SETUP_WIZARD.md to set up my workspace using that profile data. Greet me by name.';
      sendChat();
    }
  }

  function closePromptBuilder() {
    document.getElementById('promptBuilderModal').classList.add('hidden');
    currentPromptTemplate = null;
    promptAttachedFiles = [];
  }

  function updatePromptPreview() {
    if (!currentPromptTemplate) return;
    let text = currentPromptTemplate.template;
    currentPromptTemplate.fields.forEach((f, i) => {
      const el = document.getElementById('promptField' + i);
      const val = el ? el.value : '';
      text = text.replace('{' + i + '}', val || '[' + f.label + ']');
    });

    if (promptAttachedFiles.length > 0) {
      text += '\n\nAttached files:\n' + promptAttachedFiles.map(f => '- ' + f).join('\n');
    }

    const useSwarm = document.getElementById('promptSwarmToggle')?.checked;
    const useTeam = document.getElementById('promptTeamToggle')?.checked;
    if (useSwarm) text = '[SWARM MODE] ' + text;
    else if (useTeam) text = '[TEAM MODE] ' + text;

    document.getElementById('promptPreview').textContent = text;
  }

  let allPromptFiles = [];  // cached flat file list across all sessions

  async function loadAllPromptFiles() {
    allPromptFiles = [];
    const sessions = currentUser ? (currentUser.allowed_sessions || []) : [];
    const fetches = sessions.map(async (jid) => {
      const g = groupsMap[jid];
      const folder = g ? g.folder : jid;
      const label = g ? g.name : jid;
      try {
        const r = await fetch(fileUrl('/api/files?path=' + encodeURIComponent(folder) + '&recursive=true'));
        const d = await r.json();
        (d.files || []).forEach(f => {
          allPromptFiles.push({ path: f.path, name: f.name, session: label, size: f.size });
        });
      } catch {}
    });
    await Promise.all(fetches);
    allPromptFiles.sort((a, b) => a.path.localeCompare(b.path));
  }

  function filterPromptFiles() {
    const query = (document.getElementById('promptFileSearch').value || '').toLowerCase();
    renderPromptFileList(query);
  }

  function renderPromptFileList(query) {
    const el = document.getElementById('promptFileList');
    // Selected files always at top
    const selected = allPromptFiles.filter(f => promptAttachedFiles.includes(f.path));
    const unselected = allPromptFiles.filter(f => !promptAttachedFiles.includes(f.path));

    let filtered = unselected;
    if (query) {
      filtered = unselected.filter(f => f.name.toLowerCase().includes(query));
    }

    const render = (list) => list.map(f => {
      const isAttached = promptAttachedFiles.includes(f.path);
      return '<div class="pf-item' + (isAttached ? ' pf-attached' : '') + '" onclick="UserDash.togglePromptFile(\'' + escAttr(f.path) + '\')">' +
        '<span class="pf-check">' + (isAttached ? '✓' : '') + '</span>' +
        '<span class="pf-name">' + esc(f.name) + '</span>' +
        '<span class="pf-path">' + esc(f.path) + '</span>' +
        '</div>';
    }).join('');

    let html = '';
    if (selected.length > 0) {
      html += render(selected);
      if (filtered.length > 0) html += '<div class="pf-divider"></div>';
    }
    html += render(filtered);

    el.innerHTML = html || '<div class="pf-item pf-empty">No files found</div>';
  }

  function togglePromptFile(filePath) {
    const idx = promptAttachedFiles.indexOf(filePath);
    if (idx >= 0) {
      promptAttachedFiles.splice(idx, 1);
    } else {
      promptAttachedFiles.push(filePath);
    }
    const query = (document.getElementById('promptFileSearch').value || '').toLowerCase();
    renderPromptFileList(query);
    updatePromptPreview();
  }

  function removePromptFile(filePath) {
    promptAttachedFiles = promptAttachedFiles.filter(f => f !== filePath);
    const query = (document.getElementById('promptFileSearch').value || '').toLowerCase();
    renderPromptFileList(query);
    updatePromptPreview();
  }

  async function sendPrompt() {
    if (!currentPromptTemplate || !currentSession) return;

    let text = currentPromptTemplate.template;
    currentPromptTemplate.fields.forEach((f, i) => {
      const el = document.getElementById('promptField' + i);
      text = text.replace('{' + i + '}', el ? el.value : '');
    });

    // Append file paths for the agent to reference
    if (promptAttachedFiles.length > 0) {
      text += '\n\nAttached files:\n' + promptAttachedFiles.map(f => '- ' + f).join('\n');
    }

    // Prepend mode directive
    const useSwarm = document.getElementById('promptSwarmToggle')?.checked;
    const useTeam = document.getElementById('promptTeamToggle')?.checked;
    if (useSwarm) text = '[SWARM MODE] Use an agent swarm — each subagent should appear as a separate bot identity. Coordinate the agents to divide this work.\n\n' + text;
    else if (useTeam) text = '[TEAM MODE] Use a coordinated team of agents working behind the scenes. Divide this work among specialists and synthesize the results.\n\n' + text;

    try {
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, jid: currentSession, sender_name: currentUser?.name || 'User' })
      });
      closePromptBuilder();
      toast('Prompt sent!', 'success');
      navigateTo('chat');
    } catch {
      toast('Failed to send prompt', 'error');
    }
  }

  // --- UI Scale ---

  function initScale() {
    document.documentElement.style.zoom = '100%';
  }

  function applyScale(size) {
    document.documentElement.style.zoom = '100%';
  }

  // --- Theme Toggle ---

  function initTheme() {
    const saved = localStorage.getItem('dockbox-theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    updateThemeIcon();
  }

  function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('dockbox-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('dockbox-theme', 'dark');
    }
    updateThemeIcon();
  }

  function updateThemeIcon() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.getElementById('themeIconSun').classList.toggle('hidden', !isDark);
    document.getElementById('themeIconMoon').classList.toggle('hidden', isDark);
  }

  // --- Init ---


  function init() {
    // Theme + Scale
    initTheme();
    initScale();
    document.getElementById('btnThemeToggle').addEventListener('click', toggleTheme);
    loadCalendarToken();

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Nav clicks
    document.querySelectorAll('.nav-item[data-view]').forEach(el => {
      el.addEventListener('click', () => navigateTo(el.dataset.view));
    });

    // Sidebar horizontal scroll with mouse wheel (mobile bottom nav)
    const sidebarNav = document.querySelector('.sidebar-nav');
    if (sidebarNav) {
      sidebarNav.addEventListener('wheel', (e) => {
        // Only convert vertical wheel to horizontal when sidebar is horizontal (mobile)
        const isHorizontal = window.innerWidth <= 768 ||
          getComputedStyle(sidebarNav).flexDirection === 'row';
        if (isHorizontal && e.deltaY !== 0) {
          e.preventDefault();
          sidebarNav.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }

    // Switch user button
    document.getElementById('btnSwitchUser')?.addEventListener('click', switchUser);
    // btnLogout was repurposed into btnAudit (see index.html). Logout is still
    // reachable from the switch-user button on the login screen / topbar.

    // Chat send
    document.getElementById('chatSend').addEventListener('click', sendChat);
    document.getElementById('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 768;
        if (isMobile) {
          // Mobile: Enter = newline, only send via button
          return;
        }
        // Desktop: Enter sends, Shift+Enter newlines
        if (!e.shiftKey) {
          e.preventDefault();
          sendChat();
        }
      }
    });

    // Clear context button
    document.getElementById('btnClearContext')?.addEventListener('click', async () => {
      if (!currentSession) { toast('No session selected', 'error'); return; }
      const group = groupsMap[currentSession];
      if (!group) { toast('Group not found', 'error'); return; }
      try {
        const res = await fetch('/api/groups/' + encodeURIComponent(group.folder) + '/clear-session', {
          method: 'POST',
          headers: { 'X-User-Session': userSession() }
        });
        bustCache('/api/groups');
        const data = await res.json();
        if (data.ok) {
          toast('Context cleared — next message starts fresh', 'success');
          // Clear the chat messages display but preserve empty state
          const chatMessages = document.getElementById('chatMessages');
          const emptyState = document.getElementById('chatEmptyState');
          if (chatMessages && emptyState) {
            chatMessages.innerHTML = '';
            chatMessages.appendChild(emptyState);
            emptyState.classList.remove('hidden');
          }
        } else {
          toast(data.error || ('Failed to start new thought (HTTP ' + res.status + ')'), 'error');
        }
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    });
    // Auto-resize textarea
    document.getElementById('chatInput').addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // Model select — persist choice in localStorage, refresh options on click
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) {
      const saved = localStorage.getItem('dockbox-model') || '';
      modelSelect.value = saved;
      modelSelect.addEventListener('change', function() {
        localStorage.setItem('dockbox-model', this.value);
      });
      modelSelect.addEventListener('mousedown', function() {
        refreshModelDropdowns();
      });
    }

    // Chat attach file
    async function attachFilesToChat(files) {
      if (!currentSession) return;
      const gFolder = groupsMap[currentSession]?.folder;
      if (!gFolder) { toast('No group folder found', 'error'); return; }
      const input = document.getElementById('chatInput');
      for (const file of Array.from(files)) {
        try {
          await uploadWithProgress(fileUrl('/api/files/upload?path=' + encodeURIComponent(gFolder + '/attachments')), file);
          const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
          const tag = isImage ? '[Image: attachments/' + file.name + ']' : '[File: attachments/' + file.name + ']';
          input.value = (input.value ? input.value + '\n' : '') + tag + '\n';
        } catch {
          // error already shown by uploadWithProgress
        }
      }
      input.focus();
    }

    document.getElementById('chatAttachBtn').addEventListener('click', () => {
      document.getElementById('chatFileInput').click();
    });
    document.getElementById('chatFileInput').addEventListener('change', async (e) => {
      if (!e.target.files.length) return;
      await attachFilesToChat(e.target.files);
      e.target.value = '';
    });

    // Chat paste (clipboard images)
    document.getElementById('chatInput').addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const ext = file.type.split('/')[1] || 'png';
            const named = new File([file], 'paste-' + Date.now() + '.' + ext, { type: file.type });
            imageFiles.push(named);
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        await attachFilesToChat(imageFiles);
      }
    });

    // Chat drag-and-drop
    const chatView = document.getElementById('view-chat');
    const chatDropOverlay = document.getElementById('chatDropOverlay');
    let chatDragCounter = 0;
    chatView.addEventListener('dragenter', e => {
      e.preventDefault();
      chatDragCounter++;
      chatDropOverlay.classList.remove('hidden');
    });
    chatView.addEventListener('dragleave', () => {
      chatDragCounter--;
      if (chatDragCounter <= 0) { chatDragCounter = 0; chatDropOverlay.classList.add('hidden'); }
    });
    chatView.addEventListener('dragover', e => { e.preventDefault(); });
    chatView.addEventListener('drop', async e => {
      e.preventDefault();
      chatDragCounter = 0;
      chatDropOverlay.classList.add('hidden');
      if (e.dataTransfer.files.length > 0) await attachFilesToChat(e.dataTransfer.files);
    });
    document.addEventListener('dragend', () => { chatDragCounter = 0; chatDropOverlay.classList.add('hidden'); });

    // Voice: tap = single message, long-press = conversation mode
    const voiceBtn = document.getElementById('voiceBtn');
    let voiceLongPressTimer = null;
    let voiceLongPressed = false;
    voiceBtn.title = 'Tap to talk · Long press for conversation mode';

    function voicePressStart(e) {
      e.preventDefault();
      voiceLongPressed = false;
      voiceLongPressTimer = setTimeout(() => {
        voiceLongPressed = true;
        if (!conversationMode) {
          enterConversationMode();
        }
      }, 600);
    }
    function voicePressEnd(e) {
      e.preventDefault();
      clearTimeout(voiceLongPressTimer);
      if (!voiceLongPressed) {
        toggleRecording();
      }
    }
    voiceBtn.addEventListener('mousedown', voicePressStart);
    voiceBtn.addEventListener('mouseup', voicePressEnd);
    voiceBtn.addEventListener('touchstart', voicePressStart, { passive: false });
    voiceBtn.addEventListener('touchend', voicePressEnd, { passive: false });



    // File toolbar buttons
    document.getElementById('btnFileCut').addEventListener('click', fileCut);
    document.getElementById('btnFileCopy').addEventListener('click', fileCopy);
    document.getElementById('btnFilePaste').addEventListener('click', filePaste);
    document.getElementById('btnFileDownload').addEventListener('click', downloadFile);
    document.getElementById('btnFileDelete').addEventListener('click', fileDelete);
    document.getElementById('btnNewFolder').addEventListener('click', fileNewFolder);
    document.getElementById('btnSelectAll').addEventListener('click', fileSelectAll);
    document.getElementById('btnFileRename').addEventListener('click', fileRename);
    document.getElementById('btnScrubSelected').addEventListener('click', scrubSelected);
    document.getElementById('btnScrubAll').addEventListener('click', scrubAll);
    document.getElementById('btnUpload').addEventListener('click', () => {
      if (filePath === '.') { toast('Navigate into a session folder first', 'warning'); return; }
      document.getElementById('fileUploadInput').click();
    });
    document.getElementById('fileUploadInput').addEventListener('change', async (e) => {
      if (!e.target.files.length) return;
      for (const file of e.target.files) {
        try {
          await uploadWithProgress(fileUrl('/api/files/upload?path=' + encodeURIComponent(filePath)), file);
        } catch {}
      }
      loadFiles();
      e.target.value = '';
    });

    // Drag & drop
    initDragDrop();

    // Keyboard shortcuts for file operations
    document.addEventListener('keydown', (e) => {
      if (currentView !== 'files' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); filePaste(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); fileDelete(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        document.querySelectorAll('#fileList .file-row[data-name], #fileList .file-row[data-name]').forEach(r => fileSelection.add(r.dataset.name));
        updateFileSelectionUI();
      }
    });

    // Project buttons
    document.getElementById('btnNewProject').addEventListener('click', () => openProjectModal());
    document.getElementById('btnSaveProject').addEventListener('click', saveProject);
    document.getElementById('btnBackToProjects').addEventListener('click', () => { backToProjectList(); loadProjects(); });
    document.getElementById('btnEditProject').addEventListener('click', () => openProjectModal(currentProjectId));
    document.getElementById('btnDeleteProject').addEventListener('click', doDeleteProject);
    document.getElementById('btnCompleteProject').addEventListener('click', doCompleteProject);
    document.getElementById('btnArchiveProject').addEventListener('click', doArchiveProject);
    document.getElementById('btnProjectArchive').addEventListener('click', showProjectArchive);
    document.getElementById('btnAddDeliverable').addEventListener('click', () => openProjectItemModal('deliverable'));
    document.getElementById('btnAddBlocker').addEventListener('click', () => openProjectItemModal('blocker'));
    document.getElementById('btnAddPriority').addEventListener('click', () => openProjectItemModal('priority'));
    document.getElementById('btnAddTimeEntry').addEventListener('click', () => openProjectItemModal('time'));
    document.getElementById('btnAddWorkTask').addEventListener('click', addProjectWorkTask);
    document.getElementById('projectGroupFilter').addEventListener('change', function() {
      currentProjectGroupFilter = this.value;
      renderProjectList();
    });
    document.querySelectorAll('.project-tab').forEach(t => t.addEventListener('click', () => switchProjectTab(t.dataset.ptab)));

    // Calendar buttons
    document.getElementById('btnCalPrev').addEventListener('click', () => {
      calMonth--;
      if (calMonth < 0) { calMonth = 11; calYear--; }
      calSelectedDate = null;
      document.getElementById('calDayEvents').classList.add('hidden');
      loadCalendarEvents();
    });
    document.getElementById('btnCalNext').addEventListener('click', () => {
      calMonth++;
      if (calMonth > 11) { calMonth = 0; calYear++; }
      calSelectedDate = null;
      document.getElementById('calDayEvents').classList.add('hidden');
      loadCalendarEvents();
    });
    document.getElementById('btnCalRefresh').addEventListener('click', async () => {
      const btn = document.getElementById('btnCalRefresh');
      const calAccounts = getCalendarOAuthAccounts();
      if (calAccounts.length === 0) {
        toast('No connected calendar accounts to refresh', 'info');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      try {
        const results = await Promise.allSettled(
          calAccounts.map(a =>
            fetch('/api/oauth/accounts/' + encodeURIComponent(a.id) + '/pull-calendar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            }).then(r => r.json())
          )
        );
        let totalInserted = 0, totalUpdated = 0, totalRemoved = 0, errors = 0;
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value.ok) {
            totalInserted += r.value.inserted || 0;
            totalUpdated += r.value.updated || 0;
            totalRemoved += r.value.removed || 0;
          } else {
            errors++;
          }
        });
        const parts = [];
        if (totalInserted) parts.push(totalInserted + ' new');
        if (totalUpdated) parts.push(totalUpdated + ' updated');
        if (totalRemoved) parts.push(totalRemoved + ' removed');
        if (errors) parts.push(errors + ' failed');
        toast(parts.length ? 'Calendar refreshed: ' + parts.join(', ') : 'Calendar up to date', errors ? 'warning' : 'success');
        loadCalendarEvents();
      } catch {
        toast('Calendar refresh failed', 'error');
      }
      btn.disabled = false;
      btn.innerHTML = '&#x21bb; Refresh';
    });
    document.getElementById('btnCalToday').addEventListener('click', () => {
      const now = new Date();
      calYear = now.getFullYear();
      calMonth = now.getMonth();
      calSelectedDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
      loadCalendarEvents();
    });
    document.getElementById('calViewMode').addEventListener('change', (e) => {
      calViewMode = e.target.value;
      renderCalendar();
    });
    document.getElementById('calSourceFilter').addEventListener('change', (e) => {
      calSourceFilter = e.target.value;
      renderCalendar();
      // Re-render day panel if open
      if (calSelectedDate) showDayEvents(calSelectedDate);
    });
    document.getElementById('btnCalNewEvent').addEventListener('click', () => openCalEventModal(null));
    document.getElementById('btnCalEventSave').addEventListener('click', saveCalendarEvent);
    document.getElementById('btnCalEventDelete').addEventListener('click', deleteCalendarEvent_);
    document.getElementById('btnCalEventClose').addEventListener('click', () => {
      document.getElementById('calEventModal').classList.add('hidden');
      calEditingEvent = null;
    });
    document.querySelector('#calEventModal .modal-backdrop').addEventListener('click', () => {
      document.getElementById('calEventModal').classList.add('hidden');
      calEditingEvent = null;
    });
    document.getElementById('btnCalExport').addEventListener('click', calExport);
    document.getElementById('btnCalImport').addEventListener('click', calImport);
    document.getElementById('calImportFile').addEventListener('change', (e) => {
      if (e.target.files[0]) handleCalImport(e.target.files[0]);
    });

    // Automater buttons
    document.getElementById('btnSaveHeartbeat')?.addEventListener('click', saveHeartbeat);
    document.getElementById('btnNewAuto').addEventListener('click', showAutoForm);
    document.getElementById('btnSaveAuto').addEventListener('click', createAutomation);
    document.getElementById('btnCancelAuto').addEventListener('click', hideAutoForm);
    document.getElementById('autoActionInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); createAutomation(); }
    });

    // Email buttons
    document.querySelectorAll('#btnAddEmailAccount').forEach(b => b.addEventListener('click', () => openEmailAccountModal()));
    document.getElementById('emailAccountSelect').addEventListener('change', function() {
      currentEmailAccountId = this.value;
      localStorage.setItem('dockbox-email-account', this.value);
      updateEmailSecurityBanner();
      updateComposeButton();
      closeEmailReader();
      loadEmailInbox();
    });
    document.getElementById('btnRefreshEmail').addEventListener('click', () => {
      // Clear cache and reload from server
      cachedEmailsByFolder = {};
      emailCacheLoaded = false;
      loadEmailInbox();
    });
    document.getElementById('btnCompose').addEventListener('click', openComposeModal);
    document.getElementById('btnCloseEmailAccountModal').addEventListener('click', closeEmailAccountModal);
    document.getElementById('btnCancelEmailAccount').addEventListener('click', closeEmailAccountModal);
    document.querySelector('#emailAccountModal .modal-backdrop').addEventListener('click', closeEmailAccountModal);
    document.getElementById('btnSaveEmailAccount').addEventListener('click', saveEmailAccount);
    document.getElementById('btnTestEmailConnection').addEventListener('click', testEmailConnection);
    document.getElementById('btnCloseComposeModal').addEventListener('click', closeComposeModal);
    document.getElementById('btnCancelCompose').addEventListener('click', closeComposeModal);
    document.querySelector('#emailComposeModal .modal-backdrop').addEventListener('click', closeComposeModal);
    document.getElementById('btnSendEmail').addEventListener('click', sendEmailFromCompose);
    document.getElementById('btnCloseEmailView').addEventListener('click', closeEmailView);
    document.querySelector('#emailViewModal .modal-backdrop').addEventListener('click', closeEmailView);

    // Settings pane buttons (Task 12 merge — handlers moved from deleted admin Warden.* namespace)
    document.getElementById('btnTestOllama')?.addEventListener('click', testOllamaConnection);
    document.getElementById('btnSaveOllama')?.addEventListener('click', saveOllamaConfig);
    document.getElementById('btnSaveFriendlyNames')?.addEventListener('click', saveFriendlyNames);
    document.getElementById('globalDefaultModelSelect')?.addEventListener('change', (e) => saveGlobalDefaultModel(e.target.value));
    document.getElementById('ollamaChatModelInput')?.addEventListener('change', (e) => {
      // Live-update the toolcall model in router_state so container-runner picks it up
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollamaChatModel: e.target.value }),
      }).then(() => toast('Toolcall model updated', 'success')).catch(() => toast('Failed to update toolcall model', 'error'));
    });

    // Vault (optional — vault view was removed, but listeners are harmless if elements still exist)
    document.getElementById('btnVaultClose')?.addEventListener('click', closeVaultDetail);
    document.getElementById('btnVaultRestore')?.addEventListener('click', restoreVaultEntry);
    document.getElementById('btnVaultDelete')?.addEventListener('click', deleteVaultEntry);
    try { setupVaultDictListeners(); } catch (e) { /* vault dict optional */ }
    function toggleRightSidebar() {
      var rsb = document.getElementById('rightSidebar');
      var openBtn = document.getElementById('btnRsbOpen');
      if (!rsb) return;
      var isCollapsed = rsb.classList.contains('collapsed');
      if (isCollapsed) {
        rsb.classList.remove('collapsed');
        if (openBtn) openBtn.style.display = 'none';
        localStorage.removeItem('dockbox-rsb-collapsed');
      } else {
        rsb.classList.add('collapsed');
        if (openBtn) openBtn.style.display = 'flex';
        localStorage.setItem('dockbox-rsb-collapsed', '1');
      }
    }
    document.getElementById('btnRsbClose')?.addEventListener('click', toggleRightSidebar);
    document.getElementById('btnRsbOpen')?.addEventListener('click', toggleRightSidebar);
    document.getElementById('btnHelp')?.addEventListener('click', showHelpModal);
    // Restore collapsed state
    if (localStorage.getItem('dockbox-rsb-collapsed') === '1') {
      document.getElementById('rightSidebar')?.classList.add('collapsed');
      var openBtn = document.getElementById('btnRsbOpen');
      if (openBtn) openBtn.style.display = 'flex';
    }
    document.querySelectorAll('.vault-tab').forEach(tab => {
      tab.addEventListener('click', () => showVaultTab(tab.dataset.tab));
    });

    // Preview modal
    document.getElementById('btnClosePreview').addEventListener('click', closePreview);
    document.querySelector('#previewModal .modal-backdrop').addEventListener('click', closePreview);
    document.getElementById('btnPreviewDownload').addEventListener('click', () => {
      if (previewFilePath) window.open(fileUrl('/api/files/download?path=' + encodeURIComponent(previewFilePath)));
    });
    document.getElementById('btnPreviewDelete').addEventListener('click', async () => {
      if (!previewFilePath || !confirm('Delete this file?')) return;
      try {
        await fetch(fileUrl('/api/files?path=' + encodeURIComponent(previewFilePath)), { method: 'DELETE' });
        toast('File deleted', 'success');
        closePreview();
        loadFiles();
      } catch { toast('Delete failed', 'error'); }
    });
    document.getElementById('btnPreviewScrub').addEventListener('click', async () => {
      if (!previewFilePath) return;
      const btn = document.getElementById('btnPreviewScrub');
      btn.disabled = true;
      btn.textContent = 'Scrubbing...';
      try {
        const r = await fetch(fileUrl('/api/vault/scrub'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [previewFilePath] })
        });
        if (!r.ok) { toast('Scrub failed: ' + r.status, 'error'); return; }
        const d = await r.json();
        const result = (d.results || [])[0];
        if (result && result.error) {
          toast('Scrub failed: ' + result.error, 'error');
        } else {
          toast('File scrubbed successfully', 'success');
          // Reload preview with scrubbed content
          await previewFile(previewFilePath);
          loadFiles();
        }
      } catch {
        toast('Scrub failed', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Scrub';
      }
    });

    // Notification bell
    document.getElementById('btnNotifications').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleNotifDropdown();
    });
    document.getElementById('notifClearAll').addEventListener('click', function(e) {
      e.stopPropagation();
      clearNotifications();
    });
    document.addEventListener('click', function(e) {
      const dd = document.getElementById('notifDropdown');
      if (dd && !dd.classList.contains('hidden') && !e.target.closest('.notif-wrap')) {
        dd.classList.add('hidden');
      }
    });

    // Actions search
    document.getElementById('actionsSearch').addEventListener('input', function() {
      renderActions(this.value);
    });

    // Single-user Warden: no auth. Skip verify-session and go straight in.
    const storedId = localStorage.getItem('dockbox-user-id') || 'owner';
    currentUser = { id: storedId, name: 'Dominic', color: '#10b981' };
    localStorage.setItem('dockbox-user-id', storedId);
    localStorage.setItem('dockbox-user-session', 'local');
    currentSession = 'owner@local';
    // Force sidebar expanded on init — no collapse state is persisted for the
    // left sidebar, but if a stale toggle left it collapsed, reset here.
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('collapsed');
    enterDashboard();
  }

  // Failsafe: render the sidebar nav the moment the DOM is ready, even if
  // init() throws somewhere downstream. This runs in addition to init()'s
  // own call to renderSidebarNav() — calling it twice is harmless because
  // the second call just replaces the same innerHTML.
  document.addEventListener('DOMContentLoaded', function () {
    try {
      if (!currentUser) {
        currentUser = { id: 'owner', name: 'Dominic', color: '#10b981' };
        currentSession = 'owner@local';
      }
      renderSidebarNav();
    } catch (e) {
      console.error('failsafe renderSidebarNav:', e);
    }
  });

  document.addEventListener('DOMContentLoaded', init);

  // --- Public API ---
  // =========================================================
  //  Talk View
  // =========================================================

  const TalkState = { IDLE: 'idle', LISTEN: 'listen', THINK: 'think', SPEAK: 'speak' };

  let talkState = TalkState.IDLE;
  let talkRecognition = null;
  let talkIsRecording = false;
  let talkSilenceTimer = null;
  let talkFinalText = '';
  let talkLastTimestamp = new Date().toISOString();
  let talkConvMode = false;
  let talkConvWaiting = false;
  let talkInited = false;
  let talkCurrentJid = null;

  const TalkSR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function setTalkState(s) {
    talkState = s;
    const orb = document.getElementById('talkOrb');
    const lbl = document.getElementById('talkStateLabel');
    if (!orb || !lbl) return;
    orb.classList.remove('state-listen', 'state-think', 'state-speak', 'state-conv-idle');
    lbl.classList.remove('state-listen', 'state-think', 'state-speak', 'state-conv');
    const labels = {
      [TalkState.IDLE]:   talkConvMode ? 'Conversation mode – tap to end' : 'Tap to speak',
      [TalkState.LISTEN]: 'Listening…',
      [TalkState.THINK]:  'Thinking…',
      [TalkState.SPEAK]:  'Speaking – tap to skip',
    };
    lbl.textContent = labels[s] || 'Tap to speak';
    if (s === TalkState.LISTEN) { orb.classList.add('state-listen'); lbl.classList.add('state-listen'); }
    if (s === TalkState.THINK)  { orb.classList.add('state-think');  lbl.classList.add('state-think'); }
    if (s === TalkState.SPEAK)  { orb.classList.add('state-speak');  lbl.classList.add('state-speak'); }
    if (s === TalkState.IDLE && talkConvMode) { orb.classList.add('state-conv-idle'); lbl.classList.add('state-conv'); }
  }

  function talkAddMessage(role, text) {
    const empty = document.getElementById('talkTranscriptEmpty');
    if (empty) empty.style.display = 'none';
    const transcript = document.getElementById('talkTranscript');
    if (!transcript) return;
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = `talk-msg ${role}`;
    div.innerHTML = `<div class="talk-msg-bubble">${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div><span class="talk-msg-time">${time}</span>`;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function talkSpeak(text) {
    if (!window.speechSynthesis) return Promise.resolve();
    const ttsToggle = document.getElementById('talkTtsToggle');
    if (ttsToggle && !ttsToggle.checked) return Promise.resolve();
    return new Promise(resolve => {
      window.speechSynthesis.cancel();
      const chunks = text.length > 200
        ? text.match(/[^.!?]+[.!?]*/g) || [text]
        : [text];
      let i = 0;
      function speakNext() {
        if (i >= chunks.length) { resolve(); return; }
        const utt = new SpeechSynthesisUtterance(chunks[i++].trim());
        utt.lang = 'en-US'; utt.rate = 1.0; utt.pitch = 1.0;
        utt.onend = speakNext;
        utt.onerror = speakNext;
        window.speechSynthesis.speak(utt);
      }
      speakNext();
    });
  }

  let talkPollTimer = null;

  function talkSend(text) {
    if (!talkCurrentJid) { toast('Select a chat session first', 'error'); return; }
    talkAddMessage('user', text);
    setTalkState(TalkState.THINK);
    talkLastTimestamp = new Date().toISOString();
    const modelSel = document.getElementById('talkModelSelect');
    const model = modelSel ? modelSel.value : '';
    const payload = { text, jid: talkCurrentJid, sender_name: currentUser?.name || 'User' };
    if (model) payload.model = model;

    fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then(() => talkStartPolling())
    .catch(() => {
      toast('Send failed', 'error');
      setTalkState(TalkState.IDLE);
    });
  }

  function talkStartPolling() {
    if (talkPollTimer) clearInterval(talkPollTimer);
    let attempts = 0;
    const maxAttempts = 150; // 5 min at 2s intervals
    talkPollTimer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(talkPollTimer);
        talkPollTimer = null;
        toast('No response received', 'error');
        setTalkState(TalkState.IDLE);
        return;
      }
      fetch('/api/messages?jid=' + encodeURIComponent(talkCurrentJid) + '&since=' + encodeURIComponent(talkLastTimestamp) + '&limit=5')
        .then(r => r.json())
        .then(data => {
          if (!data.messages || !data.messages.length) return;
          // Use same filter as steve.html — is_bot_message flag
          const botMsgs = data.messages.filter(m => m.is_bot_message && m.timestamp > talkLastTimestamp);
          if (botMsgs.length) {
            clearInterval(talkPollTimer);
            talkPollTimer = null;
            const latest = botMsgs[botMsgs.length - 1];
            // Advance timestamp past all returned messages
            data.messages.forEach(m => { if (m.timestamp > talkLastTimestamp) talkLastTimestamp = m.timestamp; });
            // Clean text same as steve.html
            const clean = (latest.content || '').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').trim();
            talkAddMessage('bot', clean);
            setTalkState(TalkState.SPEAK);
            talkSpeak(clean).then(() => {
              setTalkState(TalkState.IDLE);
              if (talkConvMode) setTimeout(talkStartRecording, 400);
            });
          } else {
            // Advance past non-bot messages so we don't re-fetch them
            data.messages.forEach(m => { if (!m.is_bot_message && m.timestamp > talkLastTimestamp) talkLastTimestamp = m.timestamp; });
          }
        })
        .catch(() => {});
    }, 2000);
  }

  function talkStartRecording() {
    if (talkIsRecording || talkState === TalkState.THINK) return;
    if (!TalkSR) { toast('Speech recognition not supported in this browser', 'error'); return; }
    talkRecognition = new TalkSR();
    talkRecognition.lang = 'en-US';
    talkRecognition.interimResults = true;
    // Non-continuous: browser ends session on natural silence, one phrase per tap
    // Conversation mode uses continuous and sends each final segment as it arrives
    talkRecognition.continuous = !!talkConvMode;
    talkFinalText = '';
    setTalkState(TalkState.LISTEN);

    talkRecognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          if (talkConvMode) {
            // Conversation mode: send each final phrase immediately, don't accumulate
            talkFinalText = t.trim();
          } else {
            talkFinalText = t.trim();
          }
        } else {
          interim = t;
        }
      }
      const lbl = document.getElementById('talkStateLabel');
      if (lbl) lbl.textContent = (talkFinalText + (interim ? ' ' + interim : '')).trim() || 'Listening…';
    };

    talkRecognition.onerror = (e) => {
      if (e.error !== 'aborted') toast('Voice error: ' + e.error, 'error');
      talkIsRecording = false;
      setTalkState(TalkState.IDLE);
    };

    talkRecognition.onend = () => {
      talkIsRecording = false;
      if (talkFinalText.trim()) {
        talkSend(talkFinalText.trim());
      } else {
        setTalkState(TalkState.IDLE);
      }
    };

    talkRecognition.start();
    talkIsRecording = true;
  }

  function talkStopRecording() {
    if (!talkIsRecording || !talkRecognition) return;
    clearTimeout(talkSilenceTimer);
    talkRecognition.stop();
    talkIsRecording = false;
  }

  function talkOrbClick() {
    if (talkState === TalkState.THINK) return;
    if (talkState === TalkState.SPEAK) {
      window.speechSynthesis && window.speechSynthesis.cancel();
      setTalkState(TalkState.IDLE);
      if (talkConvMode) setTimeout(talkStartRecording, 300);
      return;
    }
    if (talkConvMode) {
      // End conversation mode
      talkConvMode = false;
      const convBtn = document.getElementById('talkConvBtn');
      if (convBtn) convBtn.classList.remove('active');
      if (talkIsRecording) talkStopRecording();
      window.speechSynthesis && window.speechSynthesis.cancel();
      setTalkState(TalkState.IDLE);
      return;
    }
    if (talkIsRecording) {
      talkStopRecording();
    } else {
      talkStartRecording();
    }
  }

  function talkToggleConvMode() {
    talkConvMode = !talkConvMode;
    const convBtn = document.getElementById('talkConvBtn');
    if (convBtn) convBtn.classList.toggle('active', talkConvMode);
    if (talkConvMode) {
      toast('Conversation mode on – tap orb to end', 'info', 2500);
      setTalkState(TalkState.IDLE);
      setTimeout(talkStartRecording, 300);
    } else {
      if (talkIsRecording) talkStopRecording();
      window.speechSynthesis && window.speechSynthesis.cancel();
      setTalkState(TalkState.IDLE);
    }
  }

  function talkPopulateSessions() {
    const sel = document.getElementById('talkSessionSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select session…</option>';
    if (currentUser && currentUser.allowed_sessions) {
      currentUser.allowed_sessions.forEach(jid => {
        const group = groupsMap[jid];
        const label = group ? (group.name || jid) : jid;
        const opt = document.createElement('option');
        opt.value = jid;
        opt.textContent = label;
        if (jid === currentSession) opt.selected = true;
        sel.appendChild(opt);
      });
    }
    // Set default to current session
    if (currentSession) {
      talkCurrentJid = currentSession;
      sel.value = currentSession;
    } else if (sel.options.length > 1) {
      sel.selectedIndex = 1;
      talkCurrentJid = sel.value;
    }
  }

  function initTalkView() {
    if (talkInited) { talkPopulateSessions(); return; }
    talkInited = true;

    talkPopulateSessions();

    const orb = document.getElementById('talkOrb');
    if (orb) orb.addEventListener('click', talkOrbClick);

    const convBtn = document.getElementById('talkConvBtn');
    if (convBtn) convBtn.addEventListener('click', talkToggleConvMode);

    const clearBtn = document.getElementById('talkClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      const t = document.getElementById('talkTranscript');
      if (t) {
        t.innerHTML = '<div class="talk-transcript-empty" id="talkTranscriptEmpty"><svg width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" opacity="0.3"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>Conversation will appear here</span></div>';
      }
    });

    const sessionSel = document.getElementById('talkSessionSelect');
    if (sessionSel) sessionSel.addEventListener('change', () => {
      talkCurrentJid = sessionSel.value || null;
    });

    setTalkState(TalkState.IDLE);
  }

    // ── Alarms ──
    async function loadAlarms() {
      if (!currentUser) return;
      try {
        const r = await fetch('/api/alarms', { headers: { 'X-User-Session': userSession() } });
        if (!r.ok) throw new Error('Failed to load alarms');
        const data = await r.json();
        renderAlarms(data.alarms || []);
      } catch (e) { console.error('loadAlarms', e); }
    }

    function renderAlarms(alarms) {
      const el = document.getElementById('alarm-list');
      if (!el) return;
      if (!alarms.length) { el.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:2rem">No alarms yet. Create one above!</p>'; return; }
      el.innerHTML = alarms.map(a => {
        const repeatLabel = a.repeat_type === 'once' ? (a.alarm_date || 'Once') : a.repeat_type === 'custom' ? (a.repeat_days || 'Custom') : a.repeat_type.charAt(0).toUpperCase() + a.repeat_type.slice(1);
        return '<div class="alarm-card' + (a.enabled ? '' : ' disabled') + '">' +
          '<div class="alarm-time-display">' + esc(a.alarm_time) + '</div>' +
          '<div class="alarm-info"><div class="alarm-label">' + esc(a.label) + '</div><div class="alarm-repeat">' + esc(repeatLabel) + (a.sound && a.sound !== 'default' ? ' &middot; ' + esc(a.sound) : '') + '</div></div>' +
          '<div class="alarm-actions">' +
          '<div class="alarm-toggle' + (a.enabled ? ' active' : '') + '" onclick="UserDash.toggleAlarm(\'' + escAttr(a.id) + '\',' + !a.enabled + ')"></div>' +
          '<button class="btn btn-sm" onclick="UserDash.editAlarm(\'' + escAttr(a.id) + '\')">Edit</button>' +
          '<button class="btn btn-sm btn-danger" onclick="UserDash.deleteAlarm(\'' + escAttr(a.id) + '\')">Delete</button>' +
          '</div></div>';
      }).join('');
    }

    function openAlarmModal(alarm) {
      const modal = document.getElementById('alarmModal');
      document.getElementById('alarm-modal-title').textContent = alarm ? 'Edit Alarm' : 'New Alarm';
      document.getElementById('alarm-edit-id').value = alarm ? alarm.id : '';
      document.getElementById('alarm-label').value = alarm ? alarm.label : 'Alarm';
      document.getElementById('alarm-time').value = alarm ? alarm.alarm_time : '';
      document.getElementById('alarm-sound').value = alarm ? (alarm.sound || 'default') : 'default';
      document.getElementById('alarm-repeat').value = alarm ? (alarm.repeat_type || 'once') : 'once';
      document.getElementById('alarm-date').value = alarm ? (alarm.alarm_date || '') : '';
      const rt = alarm ? (alarm.repeat_type || 'once') : 'once';
      document.getElementById('alarm-date-row').style.display = rt === 'once' ? '' : 'none';
      document.getElementById('repeat-days-row').style.display = rt === 'custom' ? '' : 'none';
      const days = (alarm && alarm.repeat_days) ? alarm.repeat_days.split(',') : [];
      document.querySelectorAll('#repeat-days-row input[type=checkbox]').forEach(cb => { cb.checked = days.includes(cb.value); });
      modal.classList.remove('hidden');
    }

    async function saveAlarm() {
      if (!currentUser) return;
      const id = document.getElementById('alarm-edit-id').value;
      const body = {
        label: document.getElementById('alarm-label').value || 'Alarm',
        alarm_time: document.getElementById('alarm-time').value,
        sound: document.getElementById('alarm-sound').value,
        repeat_type: document.getElementById('alarm-repeat').value,
      };
      if (!body.alarm_time) { toast('Please set a time', 'error'); return; }
      if (body.repeat_type === 'once') {
        body.alarm_date = document.getElementById('alarm-date').value || null;
      }
      if (body.repeat_type === 'custom') {
        const checked = [];
        document.querySelectorAll('#repeat-days-row input:checked').forEach(cb => checked.push(cb.value));
        body.repeat_days = checked.join(',');
      }
      try {
        const url = id
          ? '/api/alarms/' + encodeURIComponent(id)
          : '/api/alarms';
        const r = await fetch(url, { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json', 'X-User-Session': userSession()}, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('Save failed');
        document.getElementById('alarmModal').classList.add('hidden');
        toast(id ? 'Alarm updated' : 'Alarm created', 'success');
        loadAlarms();
      } catch (e) { toast('Error saving alarm', 'error'); console.error(e); }
    }

    async function toggleAlarm(alarmId, enabled) {
      if (!currentUser) return;
      try {
        await fetch('/api/alarms/' + encodeURIComponent(alarmId), {
          method: 'PUT', headers: {'Content-Type':'application/json', 'X-User-Session': userSession()}, body: JSON.stringify({ enabled })
        });
        loadAlarms();
      } catch (e) { console.error('toggleAlarm', e); }
    }

    async function deleteAlarm(alarmId) {
      if (!confirm('Delete this alarm?')) return;
      if (!currentUser) return;
      try {
        await fetch('/api/alarms/' + encodeURIComponent(alarmId), { method: 'DELETE', headers: { 'X-User-Session': userSession() } });
        toast('Alarm deleted', 'success');
        loadAlarms();
      } catch (e) { console.error('deleteAlarm', e); }
    }

    async function editAlarm(alarmId) {
      if (!currentUser) return;
      try {
        const r = await fetch('/api/alarms', { headers: { 'X-User-Session': userSession() } });
        if (!r.ok) return;
        const data = await r.json();
        const alarm = (data.alarms || []).find(a => a.id === alarmId);
        if (alarm) openAlarmModal(alarm);
      } catch (e) { console.error('editAlarm', e); }
    }

    function applyAlarmTemplate(label, time) {
      openAlarmModal({ label, alarm_time: time, repeat_type: 'daily', sound: 'default', enabled: 1 });
    }

    function playAlarmSound(type) {
      try {
        alarmAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        alarmOscillator = alarmAudioCtx.createOscillator();
        const gain = alarmAudioCtx.createGain();
        alarmOscillator.connect(gain);
        gain.connect(alarmAudioCtx.destination);
        if (type === 'gentle') { alarmOscillator.type = 'sine'; alarmOscillator.frequency.value = 440; gain.gain.value = 0.3; }
        else if (type === 'urgent') { alarmOscillator.type = 'square'; alarmOscillator.frequency.value = 800; gain.gain.value = 0.4; }
        else { alarmOscillator.type = 'triangle'; alarmOscillator.frequency.value = 600; gain.gain.value = 0.35; }
        alarmOscillator.start();
      } catch (e) { console.error('playAlarmSound', e); }
    }

    function stopAlarmSound() {
      try { if (alarmOscillator) { alarmOscillator.stop(); alarmOscillator = null; } if (alarmAudioCtx) { alarmAudioCtx.close(); alarmAudioCtx = null; } } catch (e) {}
    }

    function showAlarmRinging(alarmId, label, time, sound) {
      alarmRingingId = alarmId;
      const el = document.getElementById('alarm-ringing');
      el.querySelector('.alarm-ring-label').textContent = label || 'Alarm';
      el.querySelector('.alarm-ring-time').textContent = time || '';
      el.style.display = '';
      if (sound !== 'none') playAlarmSound(sound || 'default');
    }

    async function snoozeAlarm() {
      stopAlarmSound();
      document.getElementById('alarm-ringing').style.display = 'none';
      if (!alarmRingingId) return;
      if (!currentUser) return;
      try {
        await fetch('/api/alarms/' + encodeURIComponent(alarmRingingId) + '/snooze', {
          method: 'POST', headers: {'Content-Type':'application/json', 'X-User-Session': userSession()}, body: JSON.stringify({ minutes: 5 })
        });
        toast('Snoozed for 5 minutes', 'info');
      } catch (e) { console.error('snoozeAlarm', e); }
      alarmRingingId = null;
    }

    function dismissAlarm() {
      stopAlarmSound();
      document.getElementById('alarm-ringing').style.display = 'none';
      alarmRingingId = null;
    }

    // Alarm event listeners
    document.getElementById('btn-new-alarm')?.addEventListener('click', () => openAlarmModal());
    document.getElementById('alarm-modal-save')?.addEventListener('click', saveAlarm);
    document.getElementById('alarm-modal-cancel')?.addEventListener('click', () => document.getElementById('alarmModal').classList.add('hidden'));
    document.getElementById('alarm-modal-close')?.addEventListener('click', () => document.getElementById('alarmModal').classList.add('hidden'));
    document.getElementById('alarm-repeat')?.addEventListener('change', (e) => {
      document.getElementById('alarm-date-row').style.display = e.target.value === 'once' ? '' : 'none';
      document.getElementById('repeat-days-row').style.display = e.target.value === 'custom' ? '' : 'none';
    });

  // ====================== SMS ======================

  var smsAccounts = [];
  var currentSmsAccountId = null;

  async function loadSmsView() {
    try {
      var r = await fetch('/api/sms/accounts?userId=' + encodeURIComponent(userId), {});
      var d = await r.json();
      smsAccounts = d.accounts || [];
    } catch (e) { smsAccounts = []; }

    if (smsAccounts.length === 0) {
      document.getElementById('smsSetup').style.display = '';
      document.getElementById('smsActive').style.display = 'none';
    } else {
      document.getElementById('smsSetup').style.display = 'none';
      document.getElementById('smsActive').style.display = '';

      var sel = document.getElementById('smsAccountSelect');
      sel.innerHTML = smsAccounts.map(function(a) {
        return '<option value="' + esc(a.id) + '">' + esc(a.name) + ' (' + esc(a.phone_number) + ')</option>';
      }).join('');
      currentSmsAccountId = smsAccounts[0].id;

      var isReadOnly = smsAccounts[0].read_only;
      var banner = document.getElementById('smsSecurityBanner');
      var compose = document.getElementById('smsCompose');
      if (isReadOnly) {
        banner.style.display = 'flex';
        compose.style.display = 'none';
      } else {
        banner.style.display = 'none';
        compose.style.display = '';
      }

      loadSmsMessages();
    }
  }

  async function loadSmsMessages() {
    var sel = document.getElementById('smsAccountSelect');
    currentSmsAccountId = sel.value;
    var account = smsAccounts.find(function(a) { return a.id === currentSmsAccountId; });
    if (account) {
      var banner = document.getElementById('smsSecurityBanner');
      var compose = document.getElementById('smsCompose');
      if (account.read_only) { banner.style.display = 'flex'; compose.style.display = 'none'; }
      else { banner.style.display = 'none'; compose.style.display = ''; }
    }

    var list = document.getElementById('smsMessageList');
    list.innerHTML = '<p style="color:var(--text3);text-align:center;padding:24px">Loading...</p>';

    try {
      var r = await fetch('/api/sms/messages?accountId=' + encodeURIComponent(currentSmsAccountId) + '&limit=50', {});
      var d = await r.json();
      var msgs = d.messages || [];

      if (msgs.length === 0) {
        list.innerHTML = '<p style="color:var(--text3);text-align:center;padding:24px">No messages yet.</p>';
        return;
      }

      list.innerHTML = msgs.map(function(m) {
        var isInbound = m.direction === 'inbound' || m.direction === 'inbound';
        var align = isInbound ? 'flex-start' : 'flex-end';
        var bg = isInbound ? 'var(--surface)' : 'var(--accent)';
        var color = isInbound ? 'var(--text)' : '#fff';
        var border = isInbound ? '1px solid var(--border)' : 'none';
        var who = isInbound ? esc(m.from) : 'To: ' + esc(m.to);
        var date = m.date_sent ? new Date(m.date_sent).toLocaleString() : '';
        return '<div style="display:flex;justify-content:' + align + '">'
          + '<div style="max-width:75%;padding:10px 14px;border-radius:12px;background:' + bg + ';color:' + color + ';border:' + border + ';font-size:0.9rem">'
          + '<div style="font-size:0.72rem;opacity:0.7;margin-bottom:2px">' + who + (date ? ' &middot; ' + date : '') + '</div>'
          + esc(m.body)
          + '</div></div>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<p style="color:var(--danger);text-align:center;padding:24px">Failed to load messages.</p>';
    }
  }

  async function sendSmsMessage() {
    var to = document.getElementById('smsComposeTo').value.trim();
    var body = document.getElementById('smsComposeBody').value.trim();
    var errEl = document.getElementById('smsSendError');
    errEl.textContent = '';
    if (!to || !body) { errEl.textContent = 'Phone number and message are required.'; return; }

    var btn = document.getElementById('smsSendBtn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      var r = await fetch('/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentSmsAccountId, to: to, body: body })
      });
      var d = await r.json();
      if (d.error) {
        errEl.textContent = d.error;
      } else {
        document.getElementById('smsComposeBody').value = '';
        loadSmsMessages();
      }
    } catch (e) {
      errEl.textContent = 'Failed to send message.';
    }
    btn.disabled = false;
    btn.textContent = 'Send';
  }

  async function testSmsConnection() {
    var sid = document.getElementById('smsSetupSid').value.trim();
    var token = document.getElementById('smsSetupToken').value.trim();
    var errEl = document.getElementById('smsSetupError');
    errEl.textContent = '';
    if (!sid || !token) { errEl.textContent = 'SID and Auth Token are required.'; return; }

    errEl.style.color = 'var(--text3)';
    errEl.textContent = 'Testing...';
    try {
      var r = await fetch('/api/sms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_sid: sid, auth_token: token })
      });
      var d = await r.json();
      if (d.success) {
        errEl.style.color = 'var(--green,#059669)';
        errEl.textContent = 'Connection successful!';
      } else {
        errEl.style.color = 'var(--danger)';
        errEl.textContent = d.error || 'Connection failed.';
      }
    } catch (e) {
      errEl.style.color = 'var(--danger)';
      errEl.textContent = 'Connection test failed.';
    }
  }

  async function saveSmsAccount() {
    var name = document.getElementById('smsSetupName').value.trim();
    var sid = document.getElementById('smsSetupSid').value.trim();
    var token = document.getElementById('smsSetupToken').value.trim();
    var phone = document.getElementById('smsSetupPhone').value.trim();
    var readOnly = document.getElementById('smsSetupReadOnly').checked;
    var errEl = document.getElementById('smsSetupError');
    errEl.style.color = 'var(--danger)';
    errEl.textContent = '';

    if (!name || !sid || !token || !phone) {
      errEl.textContent = 'All fields are required.';
      return;
    }

    try {
      var r = await fetch('/api/sms/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, account_sid: sid, auth_token: token, phone_number: phone, read_only: readOnly, user_id: userId })
      });
      var d = await r.json();
      if (d.error) { errEl.textContent = d.error; return; }
      loadSmsView();
    } catch (e) {
      errEl.textContent = 'Failed to save account.';
    }
  }

  function showSmsSettings() {
    var account = smsAccounts.find(function(a) { return a.id === currentSmsAccountId; });
    if (!account) return;
    var content = document.getElementById('smsSettingsContent');
    content.innerHTML = '<div style="font-size:0.9rem;color:var(--text)">'
      + '<p><strong>Name:</strong> ' + esc(account.name) + '</p>'
      + '<p><strong>Phone:</strong> ' + esc(account.phone_number) + '</p>'
      + '<p><strong>SID:</strong> ' + esc(account.account_sid) + '</p>'
      + '<p><strong>Read-Only:</strong> ' + (account.read_only ? 'Yes' : 'No')
      + ' <button onclick="UserDash.toggleSmsReadOnly()" style="margin-left:8px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text2);cursor:pointer;font-size:0.8rem">'
      + (account.read_only ? 'Enable Sending' : 'Disable Sending') + '</button></p>'
      + '<p style="margin-top:8px;font-size:0.8rem;color:var(--text3)">Webhook URL for inbound SMS:<br><code style="font-size:0.75rem;word-break:break-all">' + location.origin + '/api/sms/webhook/' + esc(account.id) + '</code></p>'
      + '</div>';
    document.getElementById('smsSettingsModal').style.display = 'flex';
  }

  async function toggleSmsReadOnly() {
    var account = smsAccounts.find(function(a) { return a.id === currentSmsAccountId; });
    if (!account) return;
    try {
      await fetch('/api/sms/accounts/' + encodeURIComponent(account.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read_only: account.read_only ? 0 : 1 })
      });
      document.getElementById('smsSettingsModal').style.display = 'none';
      loadSmsView();
    } catch (e) {}
  }

  async function deleteSmsAccountFn() {
    if (!currentSmsAccountId) return;
    if (!confirm('Delete this SMS account?')) return;
    try {
      await fetch('/api/sms/accounts/' + encodeURIComponent(currentSmsAccountId), {
        method: 'DELETE'
      });
      document.getElementById('smsSettingsModal').style.display = 'none';
      loadSmsView();
    } catch (e) {}
  }

  function refreshSms() { loadSmsMessages(); }

  // ====================== Usage Dashboard ======================

  async function loadUsageDashboard() {
    if (!currentUser) return;
    try {
      var keysRes = await fetch('/api/api-keys', { headers: { 'X-User-Session': userSession() } });
      var keysData = await keysRes.json();
      var keys = keysData.keys || [];

      // --- Keys Table ---
      var listEl = document.getElementById('apiKeysList');
      if (listEl) {
        if (keys.length === 0) {
          listEl.innerHTML = '<div style="color:var(--text-tertiary);padding:12px;text-align:center;font-size:0.85rem">No API keys configured.</div>';
        } else {
          listEl.innerHTML = keys.map(function(k) {
            var typeName = { 'anthropic-api': 'Anthropic', 'anthropic-api-key': 'Anthropic', 'anthropic-oauth': 'OAuth', 'openai-api': 'OpenAI', 'openai-oauth': 'OpenAI OAuth', 'openai-compatible': 'OpenAI Compat', 'kimi': 'Kimi', 'deepseek': 'DeepSeek', 'groq': 'Groq', 'augureai': 'Augure AI', 'quickbooks': 'QuickBooks', 'stripe': 'Stripe', 'square': 'Square', 'xero': 'Xero', 'freshbooks': 'FreshBooks', 'wave': 'Wave', 'twilio': 'Twilio', 'sendgrid': 'SendGrid', 'mailgun': 'Mailgun', 'vonage': 'Vonage', 'hubspot': 'HubSpot', 'salesforce': 'Salesforce', 'mailchimp': 'Mailchimp', 'activecampaign': 'ActiveCampaign', 'github': 'GitHub', 'gitlab': 'GitLab', 'jira': 'Jira', 'linear': 'Linear', 'vercel': 'Vercel', 'cloudflare': 'Cloudflare', 'notion': 'Notion', 'airtable': 'Airtable', 'google-sheets': 'Google Sheets', 'zapier': 'Zapier', 'custom': 'Custom' }[k.key_type] || k.key_type;
            var badge = k.is_active
              ? '<span style="color:#22c55e;font-size:11px;font-weight:600">Active</span>'
              : '<span style="color:var(--text-tertiary);font-size:11px">Inactive</span>';
            return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">'
              + '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500">' + typeName + (k.label ? ' — ' + k.label : '') + '</div><div style="font-size:12px;color:var(--text-tertiary)">' + badge + '</div></div>'
              + '<button class="btn btn-sm" onclick="UserDash.toggleApiKey(\'' + k.id + '\',' + !k.is_active + ')">' + (k.is_active ? 'Disable' : 'Enable') + '</button>'
              + '<button class="btn btn-sm btn-danger" onclick="UserDash.deleteApiKey(\'' + k.id + '\')">Delete</button>'
              + '</div>';
          }).join('');
        }
      }
    } catch (err) {
      console.error('Failed to load usage dashboard:', err);
    }
  }

  function formatPeriod(p) {
    if (!p) return '';
    if (p.startsWith('last-') && p.endsWith('-days')) {
      var days = p.replace('last-', '').replace('-days', '');
      return 'Last ' + days + ' Days';
    }
    var parts = p.split('-');
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return months[parseInt(parts[1]) - 1] + ' ' + parts[0];
  }

  var providerDefaults = {
    // Communication
    'twilio':           { url: 'https://api.twilio.com/2010-04-01', model: '', auth: 'Basic {key}', hint: 'Format: AccountSID:AuthToken' },
    'slack':            { url: 'https://slack.com/api', model: '', auth: 'Bearer {key}', hint: 'Bot User OAuth Token (xoxb-...)' },
    'sendgrid':         { url: 'https://api.sendgrid.com/v3', model: '', auth: 'Bearer {key}', hint: 'API Key from Settings > API Keys' },
    'mailgun':          { url: 'https://api.mailgun.net/v3', model: '', auth: 'Basic {key}', hint: 'Format: api:your-api-key' },
    'vonage':           { url: 'https://api.nexmo.com', model: '', auth: 'Bearer {key}', hint: 'API Key from Vonage dashboard' },
    // Meetings & Calendar
    'zoom':             { url: 'https://api.zoom.us/v2', model: '', auth: 'Bearer {key}', hint: 'Server-to-Server OAuth token or JWT' },
    'calendly':         { url: 'https://api.calendly.com', model: '', auth: 'Bearer {key}', hint: 'Personal Access Token from Integrations' },
    'google-calendar':  { url: 'https://www.googleapis.com/calendar/v3', model: '', auth: 'Bearer {key}', hint: 'OAuth access token or service account key' },
    'microsoft-graph':  { url: 'https://graph.microsoft.com/v1.0', model: '', auth: 'Bearer {key}', hint: 'OAuth access token from Azure AD' },
    // Project Management
    'jira':             { url: 'https://your-domain.atlassian.net/rest/api/3', model: '', auth: 'Basic {key}', hint: 'Format: email@example.com:api-token. Set base URL to your domain.' },
    'linear':           { url: 'https://api.linear.app', model: '', auth: 'Bearer {key}', hint: 'Personal API Key from Settings > API' },
    'asana':            { url: 'https://app.asana.com/api/1.0', model: '', auth: 'Bearer {key}', hint: 'Personal Access Token from Developer Console' },
    'monday':           { url: 'https://api.monday.com/v2', model: '', auth: 'Bearer {key}', hint: 'API Token from Admin > API' },
    'clickup':          { url: 'https://api.clickup.com/api/v2', model: '', auth: 'Bearer {key}', hint: 'Personal API Token from Settings > Apps' },
    // CRM & Marketing
    'hubspot':          { url: 'https://api.hubapi.com', model: '', auth: 'Bearer {key}', hint: 'Private App Access Token' },
    'salesforce':       { url: 'https://login.salesforce.com/services/data/v59.0', model: '', auth: 'Bearer {key}', hint: 'OAuth access token. Set base URL to your instance.' },
    'mailchimp':        { url: 'https://us1.api.mailchimp.com/3.0', model: '', auth: 'Basic {key}', hint: 'Format: anystring:your-api-key. Update us1 in URL to your datacenter.' },
    'activecampaign':   { url: '', model: '', auth: 'Api-Token: {key}', hint: 'API Key from Settings > Developer. Set base URL to your account URL.' },
    // Finance & Commerce
    'quickbooks':       { url: 'https://quickbooks.api.intuit.com/v3', model: '', auth: 'Bearer {key}', hint: 'OAuth 2.0 access token' },
    'stripe':           { url: 'https://api.stripe.com/v1', model: '', auth: 'Bearer {key}', hint: 'Secret key (sk_live_... or sk_test_...)' },
    'square':           { url: 'https://connect.squareup.com/v2', model: '', auth: 'Bearer {key}', hint: 'Access token from Developer Dashboard' },
    'xero':             { url: 'https://api.xero.com/api.xro/2.0', model: '', auth: 'Bearer {key}', hint: 'OAuth 2.0 access token' },
    'freshbooks':       { url: 'https://api.freshbooks.com', model: '', auth: 'Bearer {key}', hint: 'OAuth access token' },
    'wave':             { url: 'https://gql.waveapps.com/graphql/public', model: '', auth: 'Bearer {key}', hint: 'Full Access Token from Wave developer portal' },
    'shopify':          { url: 'https://your-store.myshopify.com/admin/api/2024-01', model: '', auth: 'X-Shopify-Access-Token: {key}', hint: 'Admin API access token. Set base URL to your store.' },
    // Productivity
    'notion':           { url: 'https://api.notion.com/v1', model: '', auth: 'Bearer {key}', hint: 'Internal Integration Token from notion.so/my-integrations' },
    'airtable':         { url: 'https://api.airtable.com/v0', model: '', auth: 'Bearer {key}', hint: 'Personal Access Token from airtable.com/create/tokens' },
    'google-drive':     { url: 'https://www.googleapis.com/drive/v3', model: '', auth: 'Bearer {key}', hint: 'OAuth access token or service account key' },
    'google-sheets':    { url: 'https://sheets.googleapis.com/v4', model: '', auth: 'Bearer {key}', hint: 'OAuth access token or service account key' },
    'dropbox':          { url: 'https://api.dropboxapi.com/2', model: '', auth: 'Bearer {key}', hint: 'Access token from App Console' },
    'zapier':           { url: 'https://hooks.zapier.com', model: '', auth: 'Bearer {key}', hint: 'Webhook URL — paste the full hook URL as the base URL' },
    // Developer
    'github':           { url: 'https://api.github.com', model: '', auth: 'Bearer {key}', hint: 'Personal Access Token (classic or fine-grained)' },
    'gitlab':           { url: 'https://gitlab.com/api/v4', model: '', auth: 'Bearer {key}', hint: 'Personal Access Token. Set base URL for self-hosted.' },
    'vercel':           { url: 'https://api.vercel.com', model: '', auth: 'Bearer {key}', hint: 'Token from Settings > Tokens' },
    'cloudflare':       { url: 'https://api.cloudflare.com/client/v4', model: '', auth: 'Bearer {key}', hint: 'API Token from My Profile > API Tokens' },
    // Social Media
    'ayrshare':         { url: 'https://app.ayrshare.com/api', model: '', auth: 'Bearer {key}', hint: 'API Key from ayrshare.com dashboard. Posts to X, FB, IG, LinkedIn, TikTok, and more.' },
    'zernio':           { url: 'https://api.zernio.com/v1', model: '', auth: 'Bearer {key}', hint: 'API Key from zernio.com. Free tier available. Supports 15+ platforms.' },
    'buffer':           { url: 'https://api.buffer.com', model: '', auth: 'Bearer {key}', hint: 'Personal API key from publish.buffer.com/settings/api. Note: GraphQL API.' },
    'twitter':          { url: 'https://api.x.com/2', model: '', auth: 'Bearer {key}', hint: 'Bearer Token from developer.x.com. Read-only — posting requires OAuth.' },
    'facebook':         { url: 'https://graph.facebook.com/v25.0', model: '', auth: 'Bearer {key}', hint: 'Page Access Token. Requires Meta App Review for posting.' },
    'instagram':        { url: 'https://graph.facebook.com/v25.0', model: '', auth: 'Bearer {key}', hint: 'IG User Token via Meta developer portal. Requires Business account.' },
    // AI & Media
    'augureai':         { url: 'https://api.augureai.com/v1', model: 'canadai', auth: 'Bearer {key}', hint: 'API Key from Augure AI dashboard' },
    'together':         { url: 'https://api.together.ai/v1', model: '', auth: 'Bearer {key}', hint: 'API Key from together.ai/settings' },
    'replicate':        { url: 'https://api.replicate.com/v1', model: '', auth: 'Bearer {key}', hint: 'API Token from replicate.com/account/api-tokens' },
    'stability':        { url: 'https://api.stability.ai/v2beta', model: '', auth: 'Bearer {key}', hint: 'API Key from platform.stability.ai/account/keys' },
    'openai-image':     { url: 'https://api.openai.com/v1', model: '', auth: 'Bearer {key}', hint: 'API Key from platform.openai.com/api-keys' },
    'fal':              { url: 'https://fal.run', model: '', auth: 'Key {key}', hint: 'API Key from fal.ai/dashboard/keys' },
    // Website Login
    'website-login':    { url: '', model: '', auth: '', hint: 'Store a website URL, username, and password. Warden can use these to log in on your behalf.' },
    // Custom
    'custom':           { url: '', model: '', auth: 'Bearer {key}', hint: '' },
  };

  function fillProviderDefaults(keyType) {
    var d = providerDefaults[keyType] || { url: '', model: '', auth: 'Bearer {key}', hint: '' };
    var urlEl = document.getElementById('apiKeyBaseUrl');
    var modelEl = document.getElementById('apiKeyDefaultModel');
    var authEl = document.getElementById('apiKeyAuthFormat');
    var hintEl = document.getElementById('apiKeyHint');
    if (urlEl) urlEl.value = d.url;
    if (modelEl) modelEl.value = d.model;
    if (authEl) authEl.value = d.auth || 'Bearer {key}';
    if (hintEl) { hintEl.textContent = d.hint || ''; hintEl.style.display = d.hint ? '' : 'none'; }
    // Toggle website login fields vs API key field
    var isWebLogin = keyType === 'website-login';
    var apiKeyRow = document.getElementById('apiKeyRow');
    var webFields = document.getElementById('websiteLoginFields');
    var baseUrlRow = document.getElementById('apiKeyBaseUrlRow');
    if (apiKeyRow) apiKeyRow.style.display = isWebLogin ? 'none' : '';
    if (webFields) webFields.style.display = isWebLogin ? '' : 'none';
    if (baseUrlRow) baseUrlRow.style.display = isWebLogin ? 'none' : '';
  }

  var apiKeyTypeEl = document.getElementById('apiKeyType');
  if (apiKeyTypeEl) {
    apiKeyTypeEl.addEventListener('change', function() { fillProviderDefaults(this.value); });
    fillProviderDefaults(apiKeyTypeEl.value);
  }

  async function addApiKey() {
    if (!currentUser) return;
    var keyType = document.getElementById('apiKeyType').value;
    var label = document.getElementById('apiKeyLabel').value;
    var key, baseUrl, defaultModel;
    if (keyType === 'website-login') {
      var url = (document.getElementById('websiteLoginUrl')?.value || '').trim();
      var user = (document.getElementById('websiteLoginUser')?.value || '').trim();
      var pass = (document.getElementById('websiteLoginPass')?.value || '').trim();
      if (!url || !user || !pass) return alert('Please fill in URL, username, and password');
      // Pack credentials as JSON — stored encrypted like any other key
      key = JSON.stringify({ url: url, username: user, password: pass });
      baseUrl = url;
      defaultModel = '';
    } else {
      var keyInput = document.getElementById('apiKeyInput');
      key = keyInput.value.trim();
      if (!key) return alert('Please enter an API key');
      baseUrl = document.getElementById('apiKeyBaseUrl').value.trim();
      defaultModel = document.getElementById('apiKeyDefaultModel').value.trim();
    }
    try {
      await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
        body: JSON.stringify({ key: key, key_type: keyType, label: label || (keyType === 'website-login' ? 'Website Login' : keyType), base_url: baseUrl, default_model: defaultModel, auth_header_format: (document.getElementById('apiKeyAuthFormat') || {}).value || 'Bearer {key}' })
      });
      if (keyType === 'website-login') {
        document.getElementById('websiteLoginUrl').value = '';
        document.getElementById('websiteLoginUser').value = '';
        document.getElementById('websiteLoginPass').value = '';
      } else {
        document.getElementById('apiKeyInput').value = '';
      }
      document.getElementById('apiKeyLabel').value = '';
      loadUsageDashboard();
    } catch (err) {
      alert('Failed to add key: ' + err.message);
    }
  }

  async function toggleApiKey(keyId, active) {
    if (!currentUser) return;
    await fetch('/api/api-keys/' + keyId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-User-Session': userSession() },
      body: JSON.stringify({ is_active: active })
    });
    loadUsageDashboard();
  }

  async function deleteApiKey(keyId) {
    if (!currentUser) return;
    if (!confirm('Delete this API key?')) return;
    await fetch('/api/api-keys/' + keyId, {
      method: 'DELETE',
      headers: { 'X-User-Session': userSession() }
    });
    loadUsageDashboard();
  }

  document.getElementById('btnAddApiKey')?.addEventListener('click', addApiKey);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen || function(){}).call(document.documentElement).catch(function(){});
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document).catch(function(){});
    }
  }

  // Single-file action wrappers (called from per-file buttons)
  async function deleteFile(p) {
    if (!confirm('Delete ' + p.split('/').pop() + '?')) return;
    try {
      await fetch(fileUrl('/api/files?path=' + encodeURIComponent(p)), { method: 'DELETE' });
      toast('Deleted', 'success');
      loadFiles();
    } catch { toast('Delete failed', 'error'); }
  }

  function downloadSingleFile(p) {
    window.open(fileUrl('/api/files/download?path=' + encodeURIComponent(p)));
  }

  async function renameFile(p) {
    const oldName = p.split('/').pop();
    const newName = prompt('Rename to:', oldName);
    if (!newName || newName === oldName) return;
    const dir = p.substring(0, p.length - oldName.length);
    try {
      await fetch(fileUrl('/api/files/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: p, to: dir + newName }),
      });
      toast('Renamed', 'success');
      loadFiles();
    } catch { toast('Rename failed', 'error'); }
  }

  // === Split pane: shared terminal + in-container browser ===
  let paneOpen = false;
  let paneActiveTab = 'terminal';
  let paneCurrentFolder = null;
  let panePollTimer = null;
  let paneLockPollTimer = null;

  // === Task 20: xterm.js terminal pane — attaches to shared `warden` tmux session ===
  // The terminal is single-user shared: every dashboard client (phone, desktop, LAN)
  // connects to the same /api/terminal WebSocket, which the pty-server (Task 19) bridges
  // to `tmux attach -t warden`. Reconnecting restores full scrollback/state because tmux
  // persists. Until Task 19 lands, the WS will fail to open — we still wire the frontend
  // so it's ready.
  const TerminalPane = (() => {
    const termEl = () => document.getElementById('terminalXterm');
    let term = null;
    let fitAddon = null;
    let ws = null;
    let wsClosedByUser = false;
    let reconnectTimer = null;
    let reconnectBackoff = 500;   // ms, doubles on each failure, capped at 10s
    let inited = false;
    let lastCols = 0;
    let lastRows = 0;
    let resizeTimer = null;

    function wsUrl() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + location.host + '/api/terminal';
    }

    function setStatus(text) {
      const el = document.getElementById('terminalStatus');
      if (!el) return;
      if (text) { el.textContent = text; el.classList.remove('hidden'); }
      else { el.classList.add('hidden'); }
    }

    function clearReconnect() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }

    function scheduleReconnect() {
      if (wsClosedByUser) return;
      clearReconnect();
      reconnectBackoff = Math.min(reconnectBackoff * 2, 10000);
      setStatus('Terminal disconnected — reconnecting in ' + Math.round(reconnectBackoff/1000) + 's…');
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectBackoff);
    }

    function sendResize() {
      if (!ws || ws.readyState !== WebSocket.OPEN || !fitAddon || !term) return;
      try {
        fitAddon.fit();
      } catch { /* pane not visible yet */ }
      const cols = term.cols, rows = term.rows;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols; lastRows = rows;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }

    function connect() {
      if (wsClosedByUser) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch (e) {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        reconnectBackoff = 500;  // reset backoff on success
        setStatus('');
        // Send an initial resize so the server can tmux resize-window to our cols/rows.
        sendResize();
      };
      ws.onmessage = (ev) => {
        if (!term) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'output' && typeof msg.data === 'string') {
          term.write(msg.data);
        } else if (msg.type === 'error' && typeof msg.message === 'string') {
          // Server-side error (e.g. tmux session missing). Surface it in the pane status,
          // keep the WS open so the server can retry / spawn the session.
          setStatus('Terminal: ' + msg.message);
        }
      };
      ws.onclose = () => { ws = null; scheduleReconnect(); };
      ws.onerror = () => { try { ws && ws.close(); } catch {} };
    }

    function disconnect() {
      wsClosedByUser = true;
      clearReconnect();
      if (ws) { try { ws.close(); } catch {} ws = null; }
    }

    function init() {
      if (inited) return;
      const mount = termEl();
      if (!mount) return;
      if (typeof window.Terminal === 'undefined') {
        setStatus('Terminal library failed to load (CDN blocked?).');
        return;
      }
      term = new window.Terminal({
        cursorBlink: true,
        fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        theme: {
          background: '#0b0e14',
          foreground: '#c9d1d9',
          cursor: '#58a6ff',
          selectionBackground: 'rgba(88,166,255,0.35)',
        },
        allowProposedApi: true,
      });
      if (window.FitAddon) {
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
      }
      term.open(mount);
      try { fitAddon && fitAddon.fit(); } catch {}
      // User keystrokes → tmux session via WS.
      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });
      // Resize handling: debounce fit + send resize on container size changes.
      if (window.ResizeObserver && mount) {
        new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => { sendResize(); }, 80);
        }).observe(mount);
      }
      window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { sendResize(); }, 80);
      });
      inited = true;
      wsClosedByUser = false;
      connect();
    }

    function ensure() {
      if (!inited) init();
      else if ((!ws || ws.readyState !== WebSocket.OPEN) && !wsClosedByUser) connect();
      // Always fit when the tab becomes visible — xterm can't size itself while hidden.
      requestAnimationFrame(() => { try { fitAddon && fitAddon.fit(); sendResize(); } catch {} });
    }

    function dispose() {
      disconnect();
      if (term) { try { term.dispose(); } catch {} term = null; }
      if (fitAddon) fitAddon = null;
      inited = false;
      lastCols = 0; lastRows = 0;
    }

    return { init, ensure, dispose, disconnect };
  })();

  let paneTerminalLoaded = null;  // folder string currently loaded
  let paneBrowserLoaded = null;

  function paneFolder() {
    if (!currentSession) return null;
    return (groupsMap[currentSession] && groupsMap[currentSession].folder) || null;
  }

  function setPaneStatus(which, text) {
    const el = document.getElementById(which === 'terminal' ? 'terminalStatus' : 'browserStatus');
    if (!el) return;
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else { el.classList.add('hidden'); }
  }

  async function fetchPanePorts(folder) {
    try {
      const r = await fetch('/api/groups/' + encodeURIComponent(folder) + '/ports', {
        headers: { 'X-User-Session': userSession() },
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  function clearPaneIframes() {
    const tf = document.getElementById('terminalFrame');
    const bf = document.getElementById('browserFrame');
    if (tf) tf.src = '';
    if (bf) bf.src = '';
    paneTerminalLoaded = null;
    paneBrowserLoaded = null;
  }

  // ttyd and noVNC register window.onbeforeunload to warn about losing the
  // active session — that turns into a "Leave site?" popup every time the
  // dashboard refreshes. They're same-origin (loaded via our proxy), so we
  // can suppress it from the parent. Install once per iframe.
  function suppressIframeBeforeUnload(iframe) {
    if (!iframe || iframe.dataset.beforeunloadSuppressed) return;
    iframe.dataset.beforeunloadSuppressed = '1';
    iframe.addEventListener('load', () => {
      try {
        const w = iframe.contentWindow;
        if (!w) return;
        w.onbeforeunload = null;
        w.addEventListener('beforeunload', (e) => {
          try { e.stopImmediatePropagation(); } catch {}
          delete e.returnValue;
        }, { capture: true });
      } catch { /* cross-origin guard */ }
    });
  }

  async function ensurePaneConnected() {
    if (paneActiveTab === 'terminal') {
      TerminalPane.ensure();
      if (panePollTimer) { clearTimeout(panePollTimer); panePollTimer = null; }
      return;
    }
    // Browser tab: simple iframe navigator — no polling needed.
    if (paneActiveTab === 'browser') {
      if (panePollTimer) { clearTimeout(panePollTimer); panePollTimer = null; }
      return;
    }
  }

  function togglePane() {
    paneOpen = !paneOpen;
    const right = document.getElementById('chatSplitRight');
    const handle = document.getElementById('chatSplitHandle');
    if (!right || !handle) return;
    if (paneOpen) {
      right.classList.remove('hidden');
      right.style.display = '';
      handle.classList.remove('hidden');
      handle.style.display = '';
      localStorage.setItem('dockbox-pane-open', '1');
      ensurePaneConnected();
      startPaneLockPoll();
    } else {
      right.classList.add('hidden');
      right.style.display = 'none';
      handle.classList.add('hidden');
      handle.style.display = 'none';
      localStorage.removeItem('dockbox-pane-open');
      stopPaneLockPoll();
      // Pane closed — stop pumping resize events but keep the tmux attach alive so
      // reopening is instant and other clients keep seeing output. (TerminalPane stays
      // connected across pane open/close.)
    }
  }

  function switchPaneTab(tab) {
    paneActiveTab = tab;
    document.querySelectorAll('.pane-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.pane === tab);
    });
    const termBody = document.getElementById('paneTerminal');
    const browseBody = document.getElementById('paneBrowser');
    if (termBody) termBody.classList.toggle('hidden', tab !== 'terminal');
    if (browseBody) browseBody.classList.toggle('hidden', tab !== 'browser');
    ensurePaneConnected();
  }

  function resetPaneForSession() {
    paneCurrentFolder = null;
    paneTerminalLoaded = null;
    paneBrowserLoaded = null;
    const tf = document.getElementById('terminalFrame');
    const bf = document.getElementById('browserFrame');
    if (tf) tf.src = '';
    if (bf) bf.src = '';
    if (paneOpen) ensurePaneConnected();
  }

  function startPaneLockPoll() {
    if (paneLockPollTimer) return;
    paneLockPollTimer = setInterval(async () => {
      const folder = paneFolder();
      if (!folder) return;
      try {
        const r = await cachedFetch('/api/groups', { headers: { 'X-User-Session': userSession() } }, 1500);
        const d = await r.json();
        const g = (d.groups || []).find(x => x.jid === currentSession);
        const locked = !!(g && g.activity && g.activity.locked);
        const overlay = document.getElementById('terminalLockOverlay');
        if (overlay) overlay.classList.toggle('hidden', !locked);
      } catch { /* ignore */ }
    }, 1500);
  }
  function stopPaneLockPoll() {
    if (paneLockPollTimer) { clearInterval(paneLockPollTimer); paneLockPollTimer = null; }
  }

  function browserNavigate() {
    const input = document.getElementById('browserUrlInput');
    const frame = document.getElementById('browserFrame');
    if (!input || !frame) return;
    let url = input.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    input.value = url;
    frame.src = url;
  }

  function initPaneResize() {
    const handle = document.getElementById('chatSplitHandle');
    const right = document.getElementById('chatSplitRight');
    if (!handle || !right) return;
    const saved = localStorage.getItem('dockbox-pane-width');
    if (saved) right.style.width = saved;
    let startX = 0, startWidth = 0;
    const container = handle.closest('.chat-split-container');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = right.offsetWidth;
      handle.classList.add('dragging');
      // Suppress iframe pointer events so they don't steal the drag the
      // moment the cursor crosses into the terminal or browser pane.
      if (container) container.classList.add('resizing');
      function onMove(ev) {
        const delta = startX - ev.clientX;
        const min = 300;
        const max = Math.floor(window.innerWidth * 0.7);
        const w = Math.max(min, Math.min(max, startWidth + delta));
        right.style.width = w + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        if (container) container.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('dockbox-pane-width', right.style.width);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  async function openTerminal() {
    try {
      const r = await fetch('/api/open-terminal', { method: 'POST' });
      const d = await r.json();
      if (!d.ok) toast(d.error || 'Could not open terminal', 'error');
    } catch { toast('Failed to open terminal', 'error'); }
  }

  function initPane() {
    const btn = document.getElementById('btnTogglePane');
    if (btn) btn.addEventListener('click', togglePane);
    initPaneResize();
    suppressIframeBeforeUnload(document.getElementById('terminalFrame'));
    suppressIframeBeforeUnload(document.getElementById('browserFrame'));
    if (localStorage.getItem('dockbox-pane-open') === '1') {
      setTimeout(() => { paneOpen = false; togglePane(); }, 500);
    }
    // Init keep alive button state
    const kaBtn = document.getElementById('btnKeepAlive');
    if (kaBtn && keepAliveEnabled) {
      kaBtn.classList.add('active');
      document.getElementById('keepAliveLabel').textContent = 'Alive';
      startKeepAlivePing();
    }
  }
  // Hook init: run after DOMContentLoaded chain has set things up.
  document.addEventListener('DOMContentLoaded', () => setTimeout(initPane, 100));

  function toggleSidebar() {
    var sb = document.getElementById('sidebar');
    if (sb) sb.classList.toggle('collapsed');
  }

  return {
    toggleSidebar,
    selectUser,
    showPasswordModal,
    closePasswordModal,
    submitPassword,
    navigateTo,
    stopProcessing,
    toggleKeepAlive,
    loadHome,
    openQuickTask,
    updateQuickTaskStatus,
    loadFiles,
    previewFile,
    viewVersion,
    revertVersion,
    toggleFileSelect,
    deleteFile,
    renameFile,
    downloadFile: downloadSingleFile,
    openProject,
    openProjectModal: function(id) { openProjectModal(id); },
    saveProject,
    toggleDeliverable: doToggleDeliverable,
    editDeliverable: doEditDeliverable,
    deleteDeliverable: doDeleteDeliverable,
    deleteBlocker: doDeleteBlocker,
    deletePriority: doDeletePriority,
    deleteTimeEntry: doDeleteTimeEntry,
    editFinancials: function() { openProjectItemModal('financials'); },
    restoreProject: restoreProjectById,
    changeWorkTaskStatus,
    deleteProjectWorkTask,
    assignProjectWorkTask,
    stopTimerFromSidebar,
    cancelTimer,
    startTimerForProject,
    editTimeEntry,
    toggleAutomation,
    deleteAutomation,
    useAutoTemplate,
    viewVaultEntry,
    openPromptBuilder,
    closePromptBuilder,
    updatePromptPreview,
    filterPromptFiles,
    togglePromptFile,
    removePromptFile,
    sendPrompt,
    closeScrubModal,
    closeModal: function(id) { document.getElementById(id)?.classList.add('hidden'); },
    speakMessage: (btn) => speakText(btn.dataset.text, btn),
    openChannelConfig,
    addApiKey,
    deleteApiKey,
    saveAgentModels,
    saveGeneralSettings,
    // Calendar
    loadCalendarEvents,
    openCalEventModal,
    // Connected Accounts
    saveUserEmail,
    loadConnectedAccounts,
    disconnectChannel,
    connectUserChannel,
    disconnectUserChannel,
    reconnectUserChannel,
    closeWaQrModal,
    unlinkWhatsappChat,
    openChannelLinkModal,
    openLinkDiscoveredChat,
    pushCalendarEvent,
    pushAllLocalEvents,
    // Email
    viewEmailInReader,
    closeEmailReader,
    updateReadOnlyLabel,
    openEmailAccountModal,
    deleteEmailAccount: deleteEmailAccountById,
    loadMoreEmails,
      toggleAlarm,
      editAlarm,
      deleteAlarm,
      applyAlarmTemplate,
      snoozeAlarm,
      dismissAlarm,
      // SMS
      loadSmsMessages,
      sendSmsMessage,
      testSmsConnection,
      saveSmsAccount,
      showSmsSettings,
      toggleSmsReadOnly,
      deleteSmsAccount: deleteSmsAccountFn,
      refreshSms,
      // Usage Dashboard
      loadUsageDashboard,
      toggleFullscreen,
      toggleApiKey,
      deleteApiKey,
      openSetupWizard,
      closeSetupWizard,
      setupWizardBack,
      setupWizardNext,
      // Split pane / terminal
      openTerminal,
      togglePane,
      switchPaneTab,
      browserNavigate,
      switchIdea,
      createIdea,
      deleteIdea,
      deleteCurrentIdea,
      // Logs
      loadLogs,
      loadLogHistory,
  };
})();
