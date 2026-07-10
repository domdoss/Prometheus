// Generated from the groupware v2/user dashboard (backups/dockbox on 67.213.74.115).
// Ported views: home, files, sms, projects, automater, alarms, apikeys, actions, heartbeat, vault, talk.
// API paths rewritten from /api/users/{id}/* to the single-user /api/* routes.
window.UserDash = (() => {
  // ---- single-user shims for groupware shell dependencies ----
  let currentUser = { id: 'owner', name: 'Owner', color: '#7aa2f7' };
  const userId = 'owner';
  function userSession() { return ''; }
  function navigateTo(view) { if (window.__localSwitchView) window.__localSwitchView(view); }
  function updateRightSidebar() {}
  function markSessionRead() {} function loadChat() {} function loadIdeas() {}
  function syncTypingIndicatorForSession() {} function refreshModelDropdowns() {}
  function loadConnectedAccounts() {} function loadEmailView() {} function loadCalendarEvents() {}
  function loadLogs() {} function renderSidebarNav() {} function toggleSidebar() {}
  function toggleNavPin() {} function closePasswordModal() {} function sendPrompt() {}
  function switchPaneTab() {} function togglePane() {}
  function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
  let currentView = 'chat';
  let currentSession = '';
  let chatLastTimestamp = '';
  let knownMsgIds = new Set();
  let notifCount = 0;
  let unreadSessions = {};  // jid → count of unseen bot messages
  let notifications = [];
  let chatPolling = false;
  let filePath = '.';
  let lastNotifType = null;
  let promptAttachedFiles = [];
  let promptBrowserPath = '.';
  let currentPromptTemplate = null;
  let groupsMap = {};  // jid → { name, folder }
  function fileUrl(base) {
    const sep = base.includes('?') ? '&' : '?';
    return base + sep + 'usersession=' + encodeURIComponent(userSession());
  }

  // esc, escAttr, toast, botModelClass, senderColor, timeAgo/notifTimeAgo,
  // fmtSize/fmtFileSize are provided globally by /js/utils.js (loaded first).

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
        var select = document.getElementById('chatSessionSelect');
        if (select) {
          select.value = jid;
          select.dispatchEvent(new Event('change'));
        }
        navigateTo('chat');
        document.getElementById('notifDropdown').classList.add('hidden');
      });
    });
  }

  function skeletonHtml(lines) {
    var html = '<div class="skeleton-container" aria-hidden="true">';
    for (var i = 0; i < (lines || 4); i++) {
      html += '<div class="skeleton skeleton-line' + (i % 3 === 2 ? ' short' : '') + '"></div>';
    }
    return html + '</div>';
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

    } catch (err) {
      console.error('Failed to load home stats:', err);
    }
  }

  // --- Navigation ---

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

  let initialChatLoad = false;
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
          } else {
            statusEl.textContent = 'Starting container...';
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
    document.querySelectorAll('.msg.msg-processing').forEach(e => e.classList.remove('msg-processing'));
    if (statusPollInterval) { clearInterval(statusPollInterval); statusPollInterval = null; }
    clearThinkingBar();
  }

  // Ensure the typing indicator reflects the current container state for
  // currentSession. Safe to call on tab switch, chat switch, or after refresh.
  let keepAliveEnabled = localStorage.getItem('dockbox-keepalive') === '1';

  let stopSuppressUntil = 0;

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

  let currentIdea = '';

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

  function isToday(d) {
    const t = new Date();
    return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
  }

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
        const title = titles[data.type] || 'Dockbox';
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
    { title: 'Meet Jarvis',
      html: () => `
        <p style="margin:0 0 12px;color:var(--text-secondary);line-height:1.5;font-size:13px">Your assistant is called <strong>Jarvis</strong>. It\u2019s the same assistant across all models \u2014 same workspace, same memory, same tools. The difference is personality and speed.</p>
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
          <div><strong>Chat</strong> \u2014 Give Jarvis tasks. One clear prompt per task. Be specific about what you want.</div>
          <div><strong>Quick Actions</strong> \u2014 Pre-built prompts that work well out of the box. Great place to start.</div>
          <div><strong>Talk</strong> \u2014 Speak to Jarvis instead of typing. Same capabilities, just hands-free.</div>
          <div><strong>Email</strong> \u2014 Read and send emails. Connect your account in Connected Accounts first.</div>
          <div><strong>SMS</strong> \u2014 Send and receive text messages through connected phone numbers.</div>
          <div><strong>Files</strong> \u2014 Your workspace. Everything Jarvis creates lives here \u2014 documents, PDFs, code, data.</div>
          <div><strong>Projects</strong> \u2014 Track projects with deliverables, blockers, budgets, and timelines.</div>
          <div><strong>Calendar</strong> \u2014 View and manage events. Syncs with Google or Outlook.</div>
          <div><strong>Schedules</strong> \u2014 Automated tasks that run on a timer \u2014 daily briefings, reminders, periodic checks.</div>
          <div><strong>Heartbeat</strong> \u2014 Instructions Jarvis follows every hour, like monitoring your inbox.</div>
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
    { title: 'Your Tools & Services',
      html: () => `
        <p style="margin:0 0 8px;color:var(--text-secondary)">What tools and services do you use day to day? I'll set up API connections, install dependencies, and create docs for each one.</p>
        <div class="wt-field">
          <label class="wt-field-label">Services & Platforms</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px" id="wiz_tools">
            ${['GitHub','GitLab','Stripe','QuickBooks','HubSpot','Salesforce','Notion','Slack','Discord','Jira','Linear','Trello','Google Workspace','Microsoft 365','Shopify','AWS','Google Cloud','Cloudflare','Vercel','Netlify','Twilio','SendGrid','Mailchimp','Zapier','Airtable','Figma','Canva','OpenAI','Anthropic','Docker','PostgreSQL','MongoDB','Redis','Supabase','Firebase'].map(f =>
              `<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:13px${(_wizData.tools || []).includes(f) ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}">
                <input type="checkbox" value="${f}" style="display:none" ${(_wizData.tools || []).includes(f) ? 'checked' : ''} onchange="this.parentElement.style.background=this.checked?'var(--accent)':'';this.parentElement.style.color=this.checked?'#fff':'';this.parentElement.style.borderColor=this.checked?'var(--accent)':'var(--border)'">${f}</label>`
            ).join('')}
          </div>
        </div>
        <div class="wt-field">
          <label class="wt-field-label">Other tools not listed above (optional)</label>
          <input class="wt-field-input" id="wiz_other_tools" placeholder="e.g. Basecamp, Xero, custom internal APIs..." value="${esc(_wizData.other_tools || '')}">
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

  const TalkState = { IDLE: 'idle', LISTEN: 'listen', THINK: 'think', SPEAK: 'speak' };

  let talkState = TalkState.IDLE;
  let talkRecognition = null;
  let talkIsRecording = false;
  let talkSilenceTimer = null;
  let talkFinalText = '';
  let talkLastTimestamp = new Date().toISOString();
  let talkConvMode = false;
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

  document.getElementById('gwBtnAddApiKey')?.addEventListener('click', addApiKey);

  async function deleteFile(p) {
    if (!confirm('Delete ' + p.split('/').pop() + '?')) return;
    try {
      await fetch(fileUrl('/api/files?path=' + encodeURIComponent(p)), { method: 'DELETE' });
      toast('Deleted', 'success');
      loadFiles();
    } catch { toast('Delete failed', 'error'); }
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
  return {
    closePasswordModal,
    navigateTo,
    stopProcessing,
    loadHome,
    openQuickTask,
    updateQuickTaskStatus,
    loadFiles,
    previewFile,
    deleteFile,
    renameFile,
    openProject,
    editFinancials: function() { openProjectItemModal('financials'); },
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
    updatePromptPreview,
    togglePromptFile,
    sendPrompt,
    closeModal: function(id) { document.getElementById(id)?.classList.add('hidden'); },
    toggleAlarm,
    editAlarm,
    deleteAlarm,
    applyAlarmTemplate,
    snoozeAlarm,
    dismissAlarm,
    loadSmsMessages,
    sendSmsMessage,
    testSmsConnection,
    saveSmsAccount,
    showSmsSettings,
    toggleSmsReadOnly,
    deleteSmsAccount: deleteSmsAccountFn,
    refreshSms,
    loadUsageDashboard,
    toggleFullscreen,
    toggleApiKey,
    deleteApiKey,
    openSetupWizard,
    closeSetupWizard,
    setupWizardBack,
    setupWizardNext,
    togglePane,
    switchPaneTab,
    loadProjects,
    loadAutomations,
    renderAutoTemplates,
    loadSmsView,
    loadVault,
    renderActions,
    initTalkView,
    loadHeartbeat,
    loadAlarms,
  };
})();
