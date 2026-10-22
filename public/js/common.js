/* global RosTime */
const Ros = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  let toastTimer;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  // `?clock=17:40` previews the event as if it were that time on the event day; the clock keeps ticking from there.
  const clockParam = new URLSearchParams(location.search).get('clock');
  let clockOffsetMs = null;
  function nowMin(event) {
    const [y, m, d] = event.date.split('-').map(Number);
    const midnight = new Date(y, m - 1, d).getTime();
    if (clockParam && clockOffsetMs === null) {
      const target = RosTime.parseTime(clockParam);
      clockOffsetMs = target === null ? 0 : midnight + target * 60000 - Date.now();
    }
    return (Date.now() + (clockOffsetMs || 0) - midnight) / 60000;
  }

  function cueStatus(cue, now) {
    if (cue.done_at) return 'done';
    if (now >= cue.start_min + Math.max(cue.duration, 5)) return 'late';
    if (now >= cue.start_min) return 'live';
    if (cue.start_min - now <= 30) return 'soon';
    return 'upcoming';
  }
  const statusLabel = { done: 'Done', late: 'Overdue', live: 'Now', soon: 'Up next', upcoming: 'Upcoming' };

  function untilText(mins) {
    const m = Math.round(mins);
    if (m <= 0) return 'now';
    if (m < 60) return `in ${m} min`;
    return `in ${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ''}`.trim();
  }

  function clockText(event) {
    return RosTime.fmtTime(Math.floor(nowMin(event)));
  }

  const cache = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ } },
  };

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // A page opened under an older release reloads once when the new worker takes over.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded && !document.querySelector('dialog[open]')) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  function timeAgo(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Money is stored in kobo.
  const naira = (k) => `₦${(Math.round(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
  function toKobo(str) {
    const n = Number(String(str ?? '').replace(/[₦,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  const nairaInput = (k) => (k ? String(k / 100) : '');
  const waLink = (phone, text) => `https://wa.me/${phone || ''}?text=${encodeURIComponent(text)}`;
  const fmtDate = (d) => (d ? new Date(`${d.slice(0, 10)}T12:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

  async function copy(text, label = 'Link') {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied`); } catch { prompt('Copy this', text); }
  }

  return { naira, toKobo, nairaInput, waLink, fmtDate, copy, esc, api, toast, nowMin, cueStatus, statusLabel, untilText, clockText, cache, registerSW, timeAgo, fmt: RosTime.fmtTime, parse: RosTime.parseTime };
})();
