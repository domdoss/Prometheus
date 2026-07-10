// DockBox shared dashboard utilities.
// Loaded via <script> BEFORE app.js in both the user and admin dashboards.
// All helpers are exposed as globals so existing call sites keep working.
(function(global) {
  'use strict';

  // ============================================================
  // Request cache + in-flight dedup
  // ============================================================
  var _cfCache = new Map();    // url -> { ts, ttl, res }
  var _cfInflight = new Map(); // url -> Promise<Response>
  var _cfGen = 0;              // bumped by bustCache to invalidate in-flight writes

  /**
   * fetch() wrapper with TTL caching and in-flight request dedup (GET only).
   * Returns a cloned Response so each caller can consume the body.
   * @param {string} url
   * @param {object|null} opts - fetch options (non-GET methods bypass the cache)
   * @param {number} ttlMs - how long a successful response stays cached
   */
  function cachedFetch(url, opts, ttlMs) {
    ttlMs = ttlMs || 0;
    var method = (opts && opts.method ? String(opts.method) : 'GET').toUpperCase();
    if (method !== 'GET') return global.fetch(url, opts);

    var hit = _cfCache.get(url);
    if (hit && (Date.now() - hit.ts) < hit.ttl) {
      return Promise.resolve(hit.res.clone());
    }
    if (_cfInflight.has(url)) {
      return _cfInflight.get(url).then(function(r) { return r.clone(); });
    }
    var gen = _cfGen;
    var p = global.fetch(url, opts).then(function(res) {
      _cfInflight.delete(url);
      if (res.ok && ttlMs > 0 && gen === _cfGen) {
        _cfCache.set(url, { ts: Date.now(), ttl: ttlMs, res: res.clone() });
      }
      return res;
    }, function(err) {
      _cfInflight.delete(url);
      throw err;
    });
    _cfInflight.set(url, p);
    return p.then(function(r) { return r.clone(); });
  }

  /** Drop cached entries whose URL starts with prefix (all entries if omitted). */
  function bustCache(prefix) {
    _cfGen++;
    Array.from(_cfCache.keys()).forEach(function(k) {
      if (!prefix || k.indexOf(prefix) === 0) _cfCache.delete(k);
    });
    Array.from(_cfInflight.keys()).forEach(function(k) {
      if (!prefix || k.indexOf(prefix) === 0) _cfInflight.delete(k);
    });
  }

  // ============================================================
  // HTML escaping
  // ============================================================
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  // ============================================================
  // Toasts
  // ============================================================
  function toast(message, type, duration) {
    type = type || 'info';
    duration = duration === undefined ? 3500 : duration;
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    if (type === 'error' && duration > 5000) {
      // Persistent toast with close button (used for pings)
      el.innerHTML = '<span class="toast-msg">' + esc(message) + '</span><button class="toast-close" aria-label="Dismiss" onclick="this.parentElement.classList.add(\'toast-exit\');setTimeout(()=>this.parentElement.remove(),200)">&times;</button>';
      container.appendChild(el);
    } else {
      el.textContent = message;
      container.appendChild(el);
      setTimeout(function() {
        el.classList.add('toast-exit');
        setTimeout(function() { el.remove(); }, 200);
      }, duration);
    }
  }

  // ============================================================
  // Chat helpers
  // ============================================================
  function botModelClass(msg) {
    if (!msg.is_bot_message) return '';
    if (msg.sender === 'assistant:local') return ' ollama';
    if (msg.id && msg.id.startsWith('ipc-')) return ' ipc';
    return ' claude';
  }

  var senderColors = ['#6366f1', '#ec4899', '#f59e0b', '#14b8a6', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16', '#f97316', '#0ea5e9'];
  function senderColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return senderColors[Math.abs(h) % senderColors.length];
  }

  // ============================================================
  // Formatting
  // ============================================================
  /** Relative time, e.g. "just now", "5m ago", "3d ago". Falsy input -> "never". */
  function timeAgo(ts) {
    if (!ts) return 'never';
    var s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** Like fmtSize but returns '' for 0/undefined (file-list display style). */
  function fmtFileSize(bytes) {
    if (!bytes || bytes === 0) return '';
    return fmtSize(bytes);
  }

  // ============================================================
  // Export globals
  // ============================================================
  global.cachedFetch = cachedFetch;
  global.bustCache = bustCache;
  global.esc = esc;
  global.escAttr = escAttr;
  global.toast = toast;
  global.botModelClass = botModelClass;
  global.senderColor = senderColor;
  global.timeAgo = timeAgo;
  global.notifTimeAgo = timeAgo; // unified alias
  global.fmtSize = fmtSize;
  global.fmtFileSize = fmtFileSize;
})(window);
