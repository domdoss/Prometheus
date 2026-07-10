/* ============================================================
   DOCKBOX — MERIDIAN EXTRAS (premium interaction/motion layer)
   Loaded AFTER app.js. Never edits app.js; talks to it only via
   the UserDash export (guarded), the DOM, and localStorage.
   Companion CSS lives in css/harbor.css §22 "MERIDIAN MOTION".

   Features:
     1. Command palette (Ctrl/Cmd+K)
     2. Sliding active-nav gradient pill (desktop)
     3. Skeleton shimmer loaders (files / projects / schedules)
     7. Theme crossfade + <meta theme-color> sync
     8. Crew avatar chips (data-crew tagging on received msgs)
    10. Full-screen drag-drop overlay → forwards to chatFileInput
   (4/5/6/9 are pure CSS in harbor.css §22.)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- shared helpers ---------- */

  function ud() {
    if (typeof UserDash !== 'undefined' && UserDash) return UserDash;
    return (typeof window !== 'undefined' && window.UserDash) ? window.UserDash : null;
  }
  function call(method /* , ...args */) {
    var u = ud();
    if (!u || typeof u[method] !== 'function') return false;
    try { u[method].apply(u, Array.prototype.slice.call(arguments, 1)); } catch (e) {}
    return true;
  }
  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }
  function isMobile() {
    try { return window.matchMedia('(max-width: 768px)').matches; }
    catch (e) { return false; }
  }
  function root() {
    return document.getElementById('meridianRoot') || document.body;
  }

  /* ============================================================
     1. COMMAND PALETTE — Ctrl/Cmd+K
     ============================================================ */

  var VIEWS = [
    ['home', 'Home'], ['chat', 'Chat'], ['logs', 'Logs'], ['talk', 'Talk'],
    ['email', 'Email'], ['sms', 'SMS'], ['projects', 'Projects'],
    ['calendar', 'Calendar'], ['files', 'Files'], ['automater', 'Schedules'],
    ['heartbeat', 'Heartbeat'], ['alarms', 'Alarms'], ['vault', 'Vault'],
    ['apikeys', 'API Keys'], ['accounts', 'Connected Accounts'], ['actions', 'Quick Actions']
  ];

  var pal = null, palInput = null, palList = null;
  var palItems = [], palFiltered = [], palSel = 0;

  function buildPalette() {
    pal = document.createElement('div');
    pal.id = 'meridianPalette';
    pal.className = 'hidden';
    pal.innerHTML =
      '<div class="mp-panel" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<div class="mp-input-row">' +
          '<svg class="mp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          '<input id="mpInput" type="text" placeholder="Search views, chats, projects\u2026" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="mp-list" id="mpList" role="listbox"></div>' +
        '<div class="mp-footer">' +
          '<span><span class="mp-kbd">\u2191</span><span class="mp-kbd">\u2193</span> navigate</span>' +
          '<span><span class="mp-kbd">\u21B5</span> open</span>' +
          '<span><span class="mp-kbd">esc</span> close</span>' +
        '</div>' +
      '</div>';
    root().appendChild(pal);
    palInput = pal.querySelector('#mpInput');
    palList = pal.querySelector('#mpList');

    pal.addEventListener('mousedown', function (e) {
      if (e.target === pal) closePalette();
    });
    palInput.addEventListener('input', function () { palFilter(palInput.value); });
    palInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); palRun(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
  }

  function gatherItems() {
    var items = [];
    var i;

    // Views (UserDash.navigateTo)
    for (i = 0; i < VIEWS.length; i++) {
      (function (id, label) {
        items.push({ label: label, hint: 'View', run: function () { call('navigateTo', id); } });
      })(VIEWS[i][0], VIEWS[i][1]);
    }

    // Chats / groups from the session selector
    var sel = document.getElementById('chatSessionSelect');
    if (sel && sel.options) {
      for (i = 0; i < sel.options.length; i++) {
        (function (o) {
          if (!o.value) return;
          var name = (o.textContent || '').trim() || o.value;
          items.push({
            label: name, hint: 'Chat',
            run: function () {
              sel.value = o.value;
              try { sel.dispatchEvent(new Event('change')); } catch (e) {}
              call('navigateTo', 'chat');
            }
          });
        })(sel.options[i]);
      }
    }

    // Projects from the rendered card list (if cheaply available)
    var cards = document.querySelectorAll('#projectList .project-card');
    for (i = 0; i < cards.length; i++) {
      (function (card) {
        var oc = card.getAttribute('onclick') || '';
        var m = oc.match(/openProject\('([^']+)'\)/);
        if (!m) return;
        var nameEl = card.querySelector('.project-card-title') || card.querySelector('.project-name') || card.querySelector('h3') || card;
        var name = (nameEl.textContent || '').trim().split('\n')[0].slice(0, 48);
        items.push({
          label: name || 'Project', hint: 'Project',
          run: function () {
            call('navigateTo', 'projects');
            setTimeout(function () { call('openProject', m[1]); }, 120);
          }
        });
      })(cards[i]);
    }

    // Quick commands
    items.push({
      label: 'Toggle dark mode', hint: 'Command',
      run: function () {
        var b = document.getElementById('btnThemeToggle');
        if (b) b.click();
      }
    });
    items.push({ label: 'Toggle sidebar', hint: 'Command', run: function () { call('toggleSidebar'); } });

    return items;
  }

  function fuzzyScore(q, t) {
    q = q.toLowerCase(); t = t.toLowerCase();
    if (!q) return 1;
    var ti = 0, score = 0, prev = -2;
    for (var qi = 0; qi < q.length; qi++) {
      var found = t.indexOf(q[qi], ti);
      if (found === -1) return -1;
      score += 1;
      if (found === prev + 1) score += 3;                       // consecutive run
      if (found === 0 || t[found - 1] === ' ') score += 2;      // word start
      prev = found;
      ti = found + 1;
    }
    return score + Math.max(0, 8 - t.length / 6);               // brevity nudge
  }

  function palFilter(q) {
    var scored = [];
    for (var i = 0; i < palItems.length; i++) {
      var s = fuzzyScore(q, palItems[i].label);
      if (s >= 0) scored.push({ s: s, item: palItems[i] });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    palFiltered = scored.slice(0, 12).map(function (x) { return x.item; });
    palSel = 0;
    palRender();
  }

  function palRender() {
    if (!palList) return;
    if (!palFiltered.length) {
      palList.innerHTML = '<div class="mp-empty">No matches</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < palFiltered.length; i++) {
      var it = palFiltered[i];
      html += '<div class="mp-item' + (i === palSel ? ' sel' : '') + '" data-i="' + i + '" role="option"' + (i === palSel ? ' aria-selected="true"' : '') + '>' +
        '<span class="mp-item-label"></span><span class="mp-hint"></span></div>';
    }
    palList.innerHTML = html;
    var rows = palList.children;
    for (i = 0; i < rows.length; i++) {
      rows[i].querySelector('.mp-item-label').textContent = palFiltered[i].label;
      rows[i].querySelector('.mp-hint').textContent = palFiltered[i].hint;
      rows[i].addEventListener('mouseenter', function () {
        palSel = parseInt(this.getAttribute('data-i'), 10) || 0;
        palHighlight();
      });
      rows[i].addEventListener('click', function () {
        palSel = parseInt(this.getAttribute('data-i'), 10) || 0;
        palRun();
      });
    }
  }

  function palHighlight() {
    var rows = palList ? palList.children : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].classList) rows[i].classList.toggle('sel', i === palSel);
    }
  }

  function palMove(dir) {
    if (!palFiltered.length) return;
    palSel = (palSel + dir + palFiltered.length) % palFiltered.length;
    palHighlight();
    var row = palList.children[palSel];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function palRun() {
    var it = palFiltered[palSel];
    closePalette();
    if (it && typeof it.run === 'function') {
      try { it.run(); } catch (e) {}
    }
  }

  function openPalette() {
    if (!pal) buildPalette();
    palItems = gatherItems();
    pal.classList.remove('hidden');
    palInput.value = '';
    palFilter('');
    setTimeout(function () { palInput.focus(); }, 10);
  }
  function closePalette() {
    if (pal) pal.classList.add('hidden');
  }
  function paletteOpen() {
    return pal && !pal.classList.contains('hidden');
  }

  function initPalette() {
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (paletteOpen()) closePalette(); else openPalette();
      } else if (e.key === 'Escape' && paletteOpen()) {
        closePalette();
      }
    });
  }

  /* ============================================================
     2. SLIDING ACTIVE-NAV PILL — desktop only, FLIP via transform
     ============================================================ */

  function initNavPill() {
    if (reduced()) return; // degrade: keep the static per-item gradient
    var nav = document.getElementById('sidebarNav');
    if (!nav) return;

    var pill = document.createElement('div');
    pill.className = 'meridian-nav-pill no-anim';
    pill.setAttribute('aria-hidden', 'true');
    nav.insertBefore(pill, nav.firstChild);

    var firstShow = true, raf = 0;

    function position() {
      raf = 0;
      if (isMobile()) {
        // mobile keeps the static pill (CSS gradient on .active)
        document.body.classList.remove('meridian-pill');
        pill.style.opacity = '0';
        firstShow = true;
        return;
      }
      var act = nav.querySelector('.nav-item.active');
      if (!act) {
        pill.style.opacity = '0';
        return;
      }
      document.body.classList.add('meridian-pill');
      var nr = nav.getBoundingClientRect();
      var ar = act.getBoundingClientRect();
      if (!ar.width && !ar.height) return; // hidden / not laid out yet
      var x = ar.left - nr.left + nav.scrollLeft;
      var y = ar.top - nr.top + nav.scrollTop;
      pill.style.width = ar.width + 'px';
      pill.style.height = ar.height + 'px';
      pill.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      pill.style.opacity = '1';
      if (firstShow) {
        firstShow = false;
        requestAnimationFrame(function () { pill.classList.remove('no-anim'); });
      }
    }
    function schedule() {
      if (!raf) raf = requestAnimationFrame(position);
    }

    // active class moves on view change; nav items are re-rendered by app.js
    new MutationObserver(schedule).observe(nav, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class']
    });
    // sidebar collapse/expand animates width — re-measure after it settles
    var sb = document.getElementById('sidebar');
    if (sb) {
      new MutationObserver(function () { schedule(); setTimeout(position, 330); })
        .observe(sb, { attributes: true, attributeFilter: ['class'] });
      sb.addEventListener('transitionend', schedule);
    }
    window.addEventListener('resize', schedule);
    setTimeout(position, 150);
    setTimeout(position, 800); // after app.js renders #navPinned / restores view
  }

  /* ============================================================
     3. SKELETON SHIMMER LOADERS — files / projects / schedules
     (chat already ships its own skeleton from app.js)
     ============================================================ */

  var SKEL_TARGETS = { files: 'fileList', projects: 'projectList', automater: 'autoList' };

  function injectSkeleton(containerId) {
    var c = document.getElementById(containerId);
    if (!c) return;
    if (c.children.length > 0) return;           // has content (or app skeleton) already
    var sk = document.createElement('div');
    sk.className = 'meridian-skel';
    sk.setAttribute('aria-hidden', 'true');
    sk.innerHTML =
      '<div class="meridian-skel-row" style="width:92%"></div>' +
      '<div class="meridian-skel-row" style="width:78%"></div>' +
      '<div class="meridian-skel-row" style="width:86%"></div>' +
      '<div class="meridian-skel-row" style="width:64%"></div>';
    c.appendChild(sk);

    var timer = null, ob = null;
    function done() {
      if (sk.parentNode) sk.parentNode.removeChild(sk);
      if (ob) ob.disconnect();
      if (timer) clearTimeout(timer);
    }
    // remove on first real child insertion (app.js innerHTML writes also wipe it)
    ob = new MutationObserver(function () {
      for (var i = 0; i < c.children.length; i++) {
        if (c.children[i] !== sk) { done(); return; }
      }
      if (!sk.parentNode) done();
    });
    ob.observe(c, { childList: true });
    timer = setTimeout(done, 4000);              // max 4s safety
  }

  function initSkeletons() {
    Object.keys(SKEL_TARGETS).forEach(function (view) {
      var sec = document.getElementById('view-' + view);
      if (!sec) return;
      new MutationObserver(function () {
        if (sec.classList.contains('active')) injectSkeleton(SKEL_TARGETS[view]);
      }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* ============================================================
     7. THEME CROSSFADE + <meta name="theme-color"> SYNC
     ============================================================ */

  var THEME_COLOR = { light: '#eef1f7', dark: '#0a0c14' }; // matches harbor.css --bg

  function initThemeFade() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    function sync() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      meta.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
    }
    var fadeTimer = null;
    new MutationObserver(function () {
      sync();
      if (reduced()) return;
      document.documentElement.classList.add('theme-fading');
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () {
        document.documentElement.classList.remove('theme-fading');
      }, 350);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
  }

  /* ============================================================
     8. CREW AVATAR CHIPS — tag received messages with data-crew
     so harbor.css can draw a gradient-ring initial chip.
     Sender name comes from the .msg-meta span app.js renders.
     ============================================================ */

  var CREW_INITIALS = { atlas: 'A', byte: 'B', dexter: 'D', iris: 'I', artemis: 'Ar' };

  function tagCrew(el) {
    if (!el || el.nodeType !== 1 || !el.classList) return;
    if (!el.classList.contains('msg') || !el.classList.contains('received')) return;
    if (el.dataset.crew) return;
    var span = el.querySelector('.msg-meta span');
    var name = span ? (span.textContent || '').trim().toLowerCase() : '';
    var m = name.match(/^(atlas|byte|dexter|iris|artemis)\b/);
    if (m) {
      el.dataset.crew = m[1];
      el.dataset.crewInitial = CREW_INITIALS[m[1]];
    } else {
      el.dataset.crew = 'dockbox';            // generic assistant → Warden mark
      el.dataset.crewInitial = 'D';
    }
  }

  function initCrewChips() {
    var box = document.getElementById('chatMessages');
    if (!box) return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) tagCrew(added[j]);
      }
    }).observe(box, { childList: true });
    for (var i = 0; i < box.children.length; i++) tagCrew(box.children[i]);
  }

  /* ============================================================
     10. FULL-SCREEN DRAG-DROP OVERLAY (chat view)
     Forwards dropped files to #chatFileInput via DataTransfer +
     a synthetic 'change' event — the exact path the paperclip
     uses (app.js: chatFileInput change → attachFilesToChat).
     If DataTransfer construction is unavailable, the overlay
     degrades to a pointer-events:none cosmetic layer over the
     existing per-view drop zone.
     ============================================================ */

  function initDragDrop() {
    var input = document.getElementById('chatFileInput');
    var supported = !!input;
    if (supported) {
      try { void new DataTransfer(); } catch (e) { supported = false; }
    }

    var overlay = document.createElement('div');
    overlay.id = 'meridianDrop';
    overlay.className = 'hidden';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="meridian-drop-card">' +
        '<svg class="meridian-drop-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 9 12 4 17 9"/><line x1="12" y1="4" x2="12" y2="16"/></svg>' +
        '<div class="meridian-drop-title">Drop to attach</div>' +
        '<div class="meridian-drop-sub">Files will be added to this chat</div>' +
      '</div>';
    root().appendChild(overlay);

    if (supported) {
      // we own the interaction: suppress the legacy in-view overlay
      document.body.classList.add('meridian-dnd');
    } else {
      // cosmetic only: let the existing chat drop zone keep working
      overlay.style.pointerEvents = 'none';
    }

    var depth = 0;
    function chatActive() {
      var v = document.getElementById('view-chat');
      return !!(v && v.classList.contains('active'));
    }
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      return Array.prototype.indexOf.call(t, 'Files') > -1;
    }
    function show() { overlay.classList.remove('hidden'); }
    function hide() { depth = 0; overlay.classList.add('hidden'); }
    function visible() { return !overlay.classList.contains('hidden'); }

    function forward(files) {
      if (!supported || !files || !files.length) return;
      try {
        var dt = new DataTransfer();
        for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
    }

    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e) || !chatActive()) return;
      e.preventDefault();
      depth++;
      show();
    });
    window.addEventListener('dragover', function (e) {
      if (!visible()) return;
      e.preventDefault();
      if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {} }
    });
    window.addEventListener('dragleave', function () {
      if (!visible()) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    });
    window.addEventListener('drop', function (e) {
      if (!visible()) return;
      e.preventDefault();
      var files = e.dataTransfer ? e.dataTransfer.files : null;
      hide();
      forward(files);
    });
    window.addEventListener('dragend', hide);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && visible()) hide();
    });
  }

  /* ---------- boot ---------- */

  function init() {
    try { initPalette(); } catch (e) {}
    try { initNavPill(); } catch (e) {}
    try { initSkeletons(); } catch (e) {}
    try { initThemeFade(); } catch (e) {}
    try { initCrewChips(); } catch (e) {}
    try { initDragDrop(); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
