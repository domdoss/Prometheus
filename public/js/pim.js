/* ===== PIM views — Calendar / Email / Projects tabs =====
 * Self-contained: own `$` + `api()` wrapper, talks to the flat current
 * endpoints directly (no app.js internals). Plain JS only — no TS syntax.
 * Ported from archive/groupware-source/js/app.js calendar/email/project
 * render logic, decoupled from the old multi-user /api/users/{id}/X model.
 * Renders whatever the live API returns; empty states where endpoints are
 * stubs or unconfigured.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const qs = (s, r) => (r || document).querySelector(s);
  const qsa = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  async function api(path, opts) {
    try {
      const r = await fetch(path, opts);
      const txt = await r.text();
      let data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, err: e };
    }
  }
  const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const putJson = (path, body) => api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const del = (path) => api(path, { method: 'DELETE' });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function p2(n) { return String(n).padStart(2, '0'); }
  function dateStr(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }

  function toast(msg, kind) {
    const el = $('pimToast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'pim-toast ' + (kind || 'info');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'pim-toast hidden'; }, 2600);
  }

  // ───────────────────────────────────────────────────────── Calendar
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth();
  let calEvents = [];
  let calSelected = null; // yyyy-mm-dd
  let calEditing = null;

  async function refreshCalendar() {
    const start = new Date(calYear, calMonth, 1).toISOString();
    const end = new Date(calYear, calMonth + 1, 0, 23, 59, 59).toISOString();
    const r = await api('/api/calendar/events?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end));
    calEvents = (r.data && r.data.events) || [];
    renderCalendar();
  }

  function eventStart(ev) { return ev.start_time || ev.start || ''; }

  function renderCalendar() {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const title = $('calTitle');
    if (title) title.textContent = months[calMonth] + ' ' + calYear;

    const grid = $('calGrid');
    if (!grid) return;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const daysInPrev = new Date(calYear, calMonth, 0).getDate();
    const todayStr = dateStr(new Date());

    let html = '';
    days.forEach((d) => { html += '<div class="pim-cal-h">' + d + '</div>'; });
    for (let i = firstDay - 1; i >= 0; i--) {
      html += '<div class="pim-cal-cell other"><span class="pim-cal-d">' + (daysInPrev - i) + '</span></div>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = calYear + '-' + p2(calMonth + 1) + '-' + p2(d);
      const isToday = ds === todayStr;
      const isSel = calSelected === ds;
      const cls = 'pim-cal-cell' + (isToday ? ' today' : '') + (isSel ? ' selected' : '');
      const dayEvents = calEvents.filter((e) => { const s = eventStart(e); return s && s.slice(0, 10) === ds; });
      html += '<div class="' + cls + '" data-date="' + ds + '">';
      html += '<span class="pim-cal-d">' + d + '</span>';
      dayEvents.slice(0, 3).forEach((ev) => {
        const bg = ev.color || '';
        html += '<span class="pim-cal-ev"' + (bg ? ' style="background:' + esc(bg) + '"' : '') + ' data-id="' + esc(ev.id || '') + '">' + esc(ev.title || '(event)') + '</span>';
      });
      if (dayEvents.length > 3) html += '<span class="pim-cal-more">+' + (dayEvents.length - 3) + ' more</span>';
      html += '</div>';
    }
    const total = firstDay + daysInMonth;
    const rem = total % 7;
    if (rem > 0) for (let i = 1; i <= 7 - rem; i++) html += '<div class="pim-cal-cell other"><span class="pim-cal-d">' + i + '</span></div>';
    grid.innerHTML = html;

    qsa('.pim-cal-cell:not(.other)', grid).forEach((cell) => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.pim-cal-ev')) return;
        calSelected = cell.dataset.date;
        renderCalendar();
        showDayEvents(calSelected);
      });
    });
    qsa('.pim-cal-ev', grid).forEach((dot) => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const ev = calEvents.find((x) => x.id === dot.dataset.id);
        if (ev) openEventForm(ev);
      });
    });
    if (calSelected) showDayEvents(calSelected);
  }

  function showDayEvents(ds) {
    const panel = $('calDayList');
    const head = $('calDayTitle');
    if (!panel) return;
    const d = new Date(ds + 'T12:00:00');
    if (head) head.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const dayEvents = calEvents.filter((e) => { const s = eventStart(e); return s && s.slice(0, 10) === ds; });
    if (!dayEvents.length) {
      panel.innerHTML = '<div class="pim-empty">No events. Click "+ New Event" to create one.</div>';
      return;
    }
    panel.innerHTML = dayEvents.map((ev) => {
      const allDay = ev.all_day === 1 || ev.all_day === true;
      const time = allDay ? 'All day' : (ev.start_time ? new Date(ev.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
      return '<div class="pim-ev-card" data-id="' + esc(ev.id || '') + '">'
        + '<span class="pim-ev-time">' + esc(time) + '</span>'
        + '<div class="pim-ev-info">'
        + '<div class="pim-ev-name">' + esc(ev.title || '(event)') + '</div>'
        + (ev.description ? '<div class="pim-ev-desc">' + esc(ev.description) + '</div>' : '')
        + (ev.location ? '<div class="pim-ev-loc">' + esc(ev.location) + '</div>' : '')
        + '</div></div>';
    }).join('');
    qsa('.pim-ev-card', panel).forEach((card) => {
      card.addEventListener('click', () => {
        const ev = calEvents.find((x) => x.id === card.dataset.id);
        if (ev) openEventForm(ev);
      });
    });
  }

  function openEventForm(ev, ds, hour) {
    calEditing = ev || null;
    const f = $('calForm');
    if (!f) return;
    $('calFormTitle').textContent = ev ? 'Edit Event' : 'New Event';
    $('calEvTitle').value = ev ? (ev.title || '') : '';
    $('calEvDesc').value = ev ? (ev.description || '') : '';
    $('calEvLoc').value = ev ? (ev.location || '') : '';
    if (ev && ev.start_time) {
      $('calEvStart').value = String(ev.start_time).slice(0, 16);
    } else {
      const dt = ds || calSelected || dateStr(new Date());
      const h = hour != null ? p2(hour) : '09';
      $('calEvStart').value = dt + 'T' + h + ':00';
      $('calEvEnd').value = dt + 'T' + p2(Math.min(23, (parseInt(h, 10) || 9) + 1)) + ':00';
    }
    if (ev && ev.end_time) $('calEvEnd').value = String(ev.end_time).slice(0, 16);
    $('calEvDelete').classList.toggle('hidden', !ev);
    f.classList.remove('hidden');
  }
  function closeEventForm() { const f = $('calForm'); if (f) f.classList.add('hidden'); calEditing = null; }

  async function saveEvent() {
    const title = $('calEvTitle').value.trim();
    if (!title) { toast('Title is required', 'error'); return; }
    // Local naive ISO per PIM_TABS_PLAN — never UTC-shift (avoids the hour-off bug).
    const start = $('calEvStart').value;
    const end = $('calEvEnd').value;
    const payload = {
      title,
      description: $('calEvDesc').value,
      location: $('calEvLoc').value,
      start_time: start || null,
      end_time: end || null,
      all_day: false,
    };
    if (calEditing) {
      const r = await putJson('/api/calendar/events/' + encodeURIComponent(calEditing.id), payload);
      if (r.ok) { toast('Event updated', 'ok'); closeEventForm(); refreshCalendar(); }
      else toast('Failed to update event', 'error');
    } else {
      const r = await postJson('/api/calendar/events', payload);
      if (r.ok) { toast('Event created', 'ok'); closeEventForm(); refreshCalendar(); }
      else toast('Failed to create event', 'error');
    }
  }

  async function deleteEvent() {
    if (!calEditing) return;
    if (!confirm('Delete this event?')) return;
    const r = await del('/api/calendar/events/' + encodeURIComponent(calEditing.id));
    if (r.ok) { toast('Event deleted', 'ok'); closeEventForm(); refreshCalendar(); }
    else toast('Failed to delete event', 'error');
  }

  function exportIcs() { window.location.href = '/api/calendar/export'; }

  function bindCalendar() {
    $('calPrev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } refreshCalendar(); });
    $('calNext').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } refreshCalendar(); });
    $('calToday').addEventListener('click', () => { const t = new Date(); calYear = t.getFullYear(); calMonth = t.getMonth(); calSelected = dateStr(t); refreshCalendar(); });
    $('btnCalNew').addEventListener('click', () => openEventForm(null));
    $('btnCalExport').addEventListener('click', exportIcs);
    $('calEvSave').addEventListener('click', saveEvent);
    $('calEvCancel').addEventListener('click', closeEventForm);
    $('calEvDelete').addEventListener('click', deleteEvent);
  }

  // ──────────────────────────────────────────────────────────── Email
  let emailAccounts = [];
  let emailAccountId = '';
  let emailCache = []; // current inbox page

  async function refreshEmail() {
    const r = await api('/api/email/accounts');
    emailAccounts = (r.data && r.data.accounts) || [];
    const sel = $('emailAccountSelect');
    const saved = localStorage.getItem('jarvis-email-account');
    if (saved && emailAccounts.find((a) => a.id === saved)) emailAccountId = saved;
    else if (emailAccounts.length) emailAccountId = emailAccounts[0].id;
    else emailAccountId = '';
    if (sel) {
      if (!emailAccounts.length) {
        sel.innerHTML = '<option value="">No accounts configured</option>';
      } else {
        sel.innerHTML = emailAccounts.map((a) =>
          '<option value="' + esc(a.id) + '">' + esc(a.name || a.email) + ' (' + esc(a.email || '') + ')' + (a.read_only ? ' [READ ONLY]' : '') + '</option>'
        ).join('');
        sel.value = emailAccountId;
      }
    }
    renderEmailEmptyState();
    if (emailAccountId) loadInbox();
    else renderEmailList([]);
  }

  function renderEmailEmptyState() {
    const wrap = $('emailInbox');
    const compose = $('btnEmailCompose');
    if (!emailAccounts.length) {
      if (wrap) wrap.innerHTML = '<div class="pim-empty">No email account configured — add one in Accounts.'
        + ' <button class="btn btn-primary btn-sm" id="pimEmailGoAccounts">Go to Accounts</button></div>';
      const go = $('pimEmailGoAccounts');
      if (go) go.addEventListener('click', () => {
        const btn = document.querySelector('.rail-btn[data-view="accounts"]');
        if (btn) btn.click();
      });
      if (compose) compose.disabled = true;
    } else if (compose) {
      compose.disabled = false;
    }
  }

  async function loadInbox(fresh) {
    if (!emailAccountId) { renderEmailList([]); return; }
    const r = await api('/api/email/inbox?accountId=' + encodeURIComponent(emailAccountId) + '&limit=30' + (fresh ? '&fresh=1' : ''));
    emailCache = (r.data && r.data.emails) || [];
    renderEmailList(emailCache);
  }

  // Auto-refresh the inbox every 5 minutes while the Email view is visible
  // (the server caches on the same interval, so this stays cheap).
  setInterval(() => {
    const view = $('view-email');
    if (view && view.classList.contains('active') && emailAccountId) loadInbox();
  }, 5 * 60 * 1000);

  function renderEmailList(emails) {
    const inbox = $('emailInbox');
    if (!inbox) return;
    if (!emailAccounts.length) { renderEmailEmptyState(); return; }
    if (!emails.length) {
      inbox.innerHTML = '<div class="pim-empty">No emails found.</div>';
      return;
    }
    const now = new Date();
    inbox.innerHTML = emails.map((em, i) => {
      const from = em.from || 'Unknown';
      const subject = em.subject || '(no subject)';
      const preview = (em.body || em.snippet || '').replace(/<[^>]*>/g, '').slice(0, 140);
      const d = em.date ? new Date(em.date) : null;
      let dateStr = '';
      if (d && !isNaN(d)) {
        const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        dateStr = isToday ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
      return '<div class="pim-mail-row" data-i="' + i + '">'
        + '<div class="pim-mail-from">' + esc(from) + (em.isRead === false ? ' <span class="pim-mail-unread">●</span>' : '') + '</div>'
        + '<div class="pim-mail-main">'
        + '<div class="pim-mail-subj">' + esc(subject) + '</div>'
        + '<div class="pim-mail-prev">' + esc(preview) + '</div>'
        + '</div>'
        + '<div class="pim-mail-date">' + esc(dateStr) + '</div>'
        + '</div>';
    }).join('');
    qsa('.pim-mail-row', inbox).forEach((row) => {
      row.addEventListener('click', () => expandEmail(parseInt(row.dataset.i, 10)));
    });
  }

  async function expandEmail(i) {
    const em = emailCache[i];
    if (!em) return;
    const row = qs('.pim-mail-row[data-i="' + i + '"]');
    if (!row) return;
    if (qs('.pim-mail-body', row)) { row.classList.toggle('expanded'); return; }
    let body = em.body || '';
    // Fetch full body if we only have a snippet.
    if (em.id && (!body || body.length < 200 || em.snippet)) {
      const r = await api('/api/email/message?accountId=' + encodeURIComponent(emailAccountId) + '&emailId=' + encodeURIComponent(em.id));
      if (r.data && r.data.email && r.data.email.body) { em.body = r.data.email.body; body = em.body; em.to = r.data.email.to; }
    }
    const isHtml = /^\s*</.test(body);
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'pim-mail-body';
    if (isHtml) { bodyDiv.innerHTML = body; } else { bodyDiv.textContent = body; }
    const meta = document.createElement('div');
    meta.className = 'pim-mail-meta dim';
    meta.textContent = 'To: ' + (Array.isArray(em.to) ? em.to.join(', ') : (em.to || '')) + (em.date ? '  ·  ' + new Date(em.date).toLocaleString() : '');
    row.classList.add('expanded');
    row.appendChild(meta);
    row.appendChild(bodyDiv);
  }

  function toggleCompose() {
    const f = $('emailComposeForm');
    if (!f) return;
    if (!emailAccountId) { toast('No email account configured', 'error'); return; }
    if (f.classList.contains('hidden')) {
      $('emailTo').value = '';
      $('emailSubject').value = '';
      $('emailBody').value = '';
      f.classList.remove('hidden');
    } else {
      f.classList.add('hidden');
    }
  }

  async function sendEmail() {
    const to = $('emailTo').value.trim();
    const subject = $('emailSubject').value.trim();
    const body = $('emailBody').value;
    if (!to || !subject || !body) { toast('To, subject and body are required', 'error'); return; }
    const r = await postJson('/api/email/send', { accountId: emailAccountId, to, subject, body });
    if (r.data && r.data.ok) { toast('Email sent', 'ok'); $('emailComposeForm').classList.add('hidden'); }
    else toast('Send failed: ' + (r.data && r.data.error ? r.data.error : 'unknown error'), 'error');
  }

  function bindEmail() {
    $('btnEmailRefresh').addEventListener('click', () => { loadInbox(true); });
    $('btnEmailCompose').addEventListener('click', toggleCompose);
    $('emailAccountSelect').addEventListener('change', (e) => {
      emailAccountId = e.target.value;
      localStorage.setItem('jarvis-email-account', emailAccountId);
      loadInbox();
    });
    $('emailSend').addEventListener('click', sendEmail);
    $('emailCancel').addEventListener('click', () => $('emailComposeForm').classList.add('hidden'));
  }

  // ───────────────────────────────────────────── Settings toggle (PIM→Kontact)
  function injectExternalToggle() {
    const view = $('view-accounts');
    if (!view || $('pimExternalSection')) return;
    const wrap = document.createElement('div');
    wrap.className = 'account-section';
    wrap.id = 'pimExternalSection';
    wrap.innerHTML =
      '<div class="account-section-head"><h3>PIM Routing</h3><span class="dim">Radicale / Kontact</span></div>'
      + '<div class="account-list" style="padding:10px">'
      + '<label class="inline" style="display:flex;gap:8px;align-items:center;cursor:pointer">'
      + '<input type="checkbox" id="pimExternalToggle"> Route PIM to external apps (Radicale/Kontact)'
      + '</label>'
      + '<div class="dim" style="font-size:11px;margin-top:6px">When on, calendar/contacts/todos sync to Kontact via the local Radicale hub instead of being stored internally. Toggle is UI-only for now — deeper routing is wired separately.</div>'
      + '</div>';
    view.querySelector('.accounts-grid').appendChild(wrap);
    const cb = $('pimExternalToggle');
    cb.checked = localStorage.getItem('jarvis-pim-external') === '1';
    cb.addEventListener('change', () => {
      localStorage.setItem('jarvis-pim-external', cb.checked ? '1' : '0');
      toast(cb.checked ? 'PIM routing: external (Kontact)' : 'PIM routing: internal', 'info');
      updateExternalBadges();
    });
  }
  function externalOn() { return localStorage.getItem('jarvis-pim-external') === '1'; }
  function updateExternalBadges() {
    const badge = $('calKontactBadge');
    if (badge) { badge.classList.toggle('hidden', !externalOn()); }
  }

  // ─────────────────────────────────────────────────────────── Boot
  function injectToast() {
    if ($('pimToast')) return;
    const el = document.createElement('div');
    el.id = 'pimToast';
    el.className = 'pim-toast hidden';
    document.body.appendChild(el);
  }

  function init() {
    injectToast();
    bindCalendar();
    bindEmail();
    injectExternalToggle();
    updateExternalBadges();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PIM = {
    refreshCalendar,
    refreshEmail,
  };
})();