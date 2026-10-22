/* global Ros, io */
(() => {
  const token = location.pathname.split('/').pop();
  const base = `/api/v/${token}`;
  const cacheKey = `ros:v:${token}`;
  const outboxKey = `${cacheKey}:outbox`;
  const $ = (id) => document.getElementById(id);
  let state = Ros.cache.get(cacheKey);
  let prevStarts = state ? Object.fromEntries(state.cues.map((c) => [c.id, c.start_min])) : {};

  function render() {
    if (!state) return;
    const { event, vendor, cues } = state;
    const now = Ros.nowMin(event);
    document.title = `${vendor.role} · ${event.name}`;
    $('ev-name').textContent = event.name;
    $('who').textContent = `${vendor.name}${vendor.name === vendor.role ? '' : ` · ${vendor.role}`}${event.venue ? ` · ${event.venue}` : ''}`;
    $('clock').textContent = Ros.clockText(event);

    $('checkin').classList.toggle('hidden', Boolean(vendor.checked_in_at));
    $('checked').classList.toggle('hidden', !vendor.checked_in_at);
    if (vendor.checked_in_at) $('checked-text').textContent = `Checked in at ${Ros.timeAgo(vendor.checked_in_at)}${vendor.pending ? ' (sending…)' : ''}`;
    $('alerts').classList.toggle('hidden', vendor.push_enabled || !pushSupported());

    const next = cues.find((c) => !c.done_at && c.start_min + c.duration > now);
    $('next').classList.toggle('hidden', !next);
    if (next) {
      $('next-when').textContent = Ros.fmt(next.start_min);
      $('next-count').textContent = next.start_min > now ? Ros.untilText(next.start_min - now) : 'Happening now';
      $('next-title').textContent = next.title;
      $('next-with').textContent = next.with.length ? `With ${next.with.join(', ')}` : '';
    }

    const done = cues.filter((c) => c.done_at).length;
    $('progress').textContent = `${done} of ${cues.length} done`;
    $('cues').innerHTML = cues.map((c) => {
      const st = Ros.cueStatus(c, now);
      const flash = prevStarts[c.id] !== undefined && prevStarts[c.id] !== c.start_min ? ' flash' : '';
      return `<li class="cue is-${st}${flash}" data-id="${c.id}">
        <div class="time">${Ros.fmt(c.start_min)}<span class="dur">${c.duration} min</span></div>
        <div class="what">
          <div class="t">${Ros.esc(c.title)}</div>
          ${c.notes ? `<div class="notes">${Ros.esc(c.notes)}</div>` : ''}
          <div class="chips"><span class="pill ${st}">${Ros.statusLabel[st]}${c.pending ? ' · sending…' : ''}</span>${c.with.map((w) => `<span class="chip">${Ros.esc(w)}</span>`).join('')}</div>
        </div>
        <div class="acts">${c.done_at ? '<button class="btn sm ghost" data-done="0">Undo</button>' : '<button class="btn ok" data-done="1">✓ Mark done</button>'}</div>
      </li>`;
    }).join('') || '<li class="cue"><div></div><div class="muted">No cues assigned to you yet.</div></li>';
    prevStarts = Object.fromEntries(cues.map((c) => [c.id, c.start_min]));

    $('notices-card').classList.toggle('hidden', !state.notices.length);
    $('notices').innerHTML = state.notices.map((n) => `<li><time>${Ros.timeAgo(n.at)}</time>${Ros.esc(n.message.replace(`${event.name}: `, ''))}</li>`).join('');
  }

  // ---------- offline-safe actions ----------
  // Actions apply locally right away, then go to the server. If that fails they wait in an outbox.

  const outbox = () => Ros.cache.get(outboxKey) || [];
  function queue(path, body) {
    Ros.cache.set(outboxKey, [...outbox(), { path, body }]);
    Ros.cache.set(cacheKey, state);
    render();
    flush();
  }
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let items = outbox();
      const sent = items.length > 0;
      while (items.length) {
        try {
          await Ros.api('POST', base + items[0].path, items[0].body);
        } catch (err) {
          if (!err.status) break; // network down: keep it for later
          Ros.toast(err.message); // server said no: drop it
        }
        items = outbox().slice(1);
        Ros.cache.set(outboxKey, items);
      }
      if (sent && !items.length) await refresh();
    } finally {
      flushing = false;
    }
  }

  async function refresh() {
    try {
      state = await Ros.api('GET', base);
      Ros.cache.set(cacheKey, state);
      render();
    } catch (err) {
      if (err.status === 404) $('ev-name').textContent = 'This link is no longer active';
    }
  }

  $('checkin').addEventListener('click', () => {
    state.vendor.checked_in_at = new Date().toISOString();
    state.vendor.pending = true;
    if (navigator.vibrate) navigator.vibrate(30);
    queue('/checkin');
  });
  $('cues').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-done]');
    if (!btn) return;
    const cue = state.cues.find((c) => c.id === Number(btn.closest('[data-id]').dataset.id));
    const done = btn.dataset.done === '1';
    cue.done_at = done ? new Date().toISOString() : null;
    cue.pending = true;
    queue(`/cues/${cue.id}/done`, { done });
  });

  // ---------- notices ----------

  function showNotice(text) {
    $('notice-text').textContent = text.replace(`${state?.event.name}: `, '');
    $('notice').classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
  $('notice-x').addEventListener('click', () => $('notice').classList.add('hidden'));

  // ---------- push ----------

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  }
  $('alerts').addEventListener('click', async () => {
    try {
      const { publicKey } = await Ros.api('GET', '/api/push-key');
      if (!publicKey) return Ros.toast('Alerts are not set up on this server yet.');
      if ((await Notification.requestPermission()) !== 'granted') return Ros.toast('Alerts were blocked. You can allow them in your browser settings.');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
      await Ros.api('POST', `${base}/push`, { subscription: sub.toJSON() });
      Ros.toast("Alerts on. We'll ping you when your cues change.");
    } catch (err) {
      Ros.toast(`Couldn't turn on alerts: ${err.message}`);
    }
  });

  // ---------- live connection ----------

  const setOnline = (on) => $('offline').classList.toggle('hidden', on);
  const socket = io({ auth: { vendor: token } });
  socket.on('state', (s) => {
    // Keep local edits that haven't reached the server yet.
    if (outbox().length && state) return;
    state = s;
    Ros.cache.set(cacheKey, s);
    render();
  });
  socket.on('notice', showNotice);
  socket.on('connect', () => { setOnline(true); flush(); });
  socket.on('disconnect', () => setOnline(false));
  socket.on('connect_error', () => setOnline(false));
  window.addEventListener('online', flush);

  if (!state) refresh();
  render();
  setInterval(render, 20000);
  Ros.registerSW();
})();
