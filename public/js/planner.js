/* global Ros, RosNav, io */
(() => {
  const token = location.pathname.split('/').pop();
  const base = `/api/p/${token}`;
  const cacheKey = `ros:p:${token}`;
  const $ = (id) => document.getElementById(id);
  let state = Ros.cache.get(cacheKey);
  let prevStarts = {};

  const vendorById = () => Object.fromEntries(state.vendors.map((v) => [v.id, v]));
  const vendorLink = (v) => `${location.origin}/v/${v.token}`;
  const waLink = (phone, text) => `https://wa.me/${phone || ''}?text=${encodeURIComponent(text)}`;

  async function act(method, path, body, okMsg) {
    try {
      const r = await Ros.api(method, base + path, body);
      if (okMsg) Ros.toast(okMsg);
      return r;
    } catch (err) {
      Ros.toast(navigator.onLine ? err.message : "You're offline. Changes need a connection.");
      throw err;
    }
  }

  // ---------- render ----------

  function render() {
    if (!state) return;
    const { event, vendors, cues } = state;
    const now = Ros.nowMin(event);
    const vmap = vendorById();
    document.title = `${event.name} · Planner`;
    $('ev-name').textContent = event.name;
    $('ev-sub').textContent = [new Date(event.date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), event.venue].filter(Boolean).join(' · ');
    $('clock').textContent = Ros.clockText(event);

    const statuses = cues.map((c) => Ros.cueStatus(c, now));
    const late = statuses.filter((s) => s === 'late').length;
    const done = statuses.filter((s) => s === 'done').length;
    const firstCueFor = (vid) => Math.min(...cues.filter((c) => c.vendor_ids.includes(vid)).map((c) => c.start_min));
    const missing = vendors.filter((v) => !v.checked_in_at && firstCueFor(v.id) - now <= 60);
    const next = cues.find((c, i) => statuses[i] !== 'done' && c.start_min >= now) || null;

    const overall = $('overall');
    if (cues.length && done === cues.length) { overall.className = 'pill done'; overall.textContent = 'All done'; }
    else if (late || missing.length) { overall.className = 'pill late'; overall.textContent = [late && `${late} overdue`, missing.length && `${missing.length} not here`].filter(Boolean).join(' · '); }
    else { overall.className = 'pill ok'; overall.textContent = 'On track'; }

    setStat('st-late', late, late > 0);
    setStat('st-in', `${vendors.filter((v) => v.checked_in_at).length}/${vendors.length}`, missing.length > 0);
    setStat('st-done', `${done}/${cues.length}`);
    setStat('st-next', next ? Ros.fmt(next.start_min) : '–');
    $('st-next').querySelector('.l').textContent = next ? next.title : 'Next cue';

    // timeline
    const nowIdx = cues.findIndex((c) => c.start_min > now);
    const showNow = now > (cues[0]?.start_min ?? 0) - 120 && now < (cues.at(-1)?.start_min ?? 0) + 180;
    $('cues').innerHTML = cues.map((c, i) => {
      const st = statuses[i];
      const chips = c.vendor_ids.map((vid) => {
        const v = vmap[vid];
        if (!v) return '';
        const cls = v.checked_in_at ? 'in' : missing.includes(v) ? 'missing' : '';
        return `<span class="chip ${cls}" title="${v.checked_in_at ? 'Checked in' : 'Not checked in'}">${v.checked_in_at ? '✓ ' : ''}${Ros.esc(v.role)}</span>`;
      }).join('');
      const doneBy = c.done_at ? ` ${Ros.timeAgo(c.done_at)}${c.done_by && vmap[c.done_by] ? ` by ${Ros.esc(vmap[c.done_by].name)}` : ''}` : '';
      const flash = prevStarts[c.id] !== undefined && prevStarts[c.id] !== c.start_min ? ' flash' : '';
      const line = showNow && i === nowIdx ? `<li class="nowline" aria-hidden="true"><span>Now ${Ros.clockText(state.event)}</span></li>` : '';
      return `${line}<li class="cue is-${st}${flash}" data-id="${c.id}">
        <div class="time">${Ros.fmt(c.start_min)}<span class="dur">${c.duration} min</span></div>
        <div class="what">
          <div class="t">${Ros.esc(c.title)}</div>
          ${c.notes ? `<div class="notes">${Ros.esc(c.notes)}</div>` : ''}
          <div class="chips"><span class="pill ${st}">${Ros.statusLabel[st]}${doneBy}</span>${chips}</div>
        </div>
        <div class="acts">
          ${c.done_at ? '<button class="btn sm ghost" data-act="undo">Undo</button>' : '<button class="btn sm" data-act="done">✓ Done</button>'}
          ${c.done_at ? '' : '<button class="btn sm ghost" data-act="shift" title="Move this and later cues">Move…</button>'}
          <button class="btn sm ghost" data-act="edit">Edit</button>
        </div>
      </li>`;
    }).join('') || '<li class="cue"><div></div><div class="muted">No cues yet. Add the first one.</div></li>';
    prevStarts = Object.fromEntries(cues.map((c) => [c.id, c.start_min]));

    // vendors
    $('vendors').innerHTML = vendors.map((v) => {
      const here = v.checked_in_at ? `<span class="chip in">✓ In ${Ros.timeAgo(v.checked_in_at)}</span>` : `<span class="chip ${missing.includes(v) ? 'missing' : ''}">Not here</span>`;
      const invite = `Hi ${v.name}, here is your live run of show for ${event.name}. Check in when you arrive and you'll see any changes instantly: ${vendorLink(v)}`;
      return `<li data-id="${v.id}">
        <button class="vname" data-act="edit" title="Edit vendor"><div class="name">${Ros.esc(v.name)}</div><div class="muted small">${v.name === v.role ? '' : `${Ros.esc(v.role)} · `}${v.phone ? `+${Ros.esc(v.phone)}` : 'no number'}${v.push_enabled ? ' · 🔔 alerts on' : ''}${v.rating ? ` · <span class="rated" title="Couple's rating">${'★'.repeat(v.rating)}</span>` : ''}</div></button>
        ${here}
        <div class="acts">
          <button class="btn sm" data-act="copy">Copy link</button>
          <a class="btn sm" target="_blank" rel="noopener" href="${waLink(v.phone, invite)}">Send on WhatsApp</a>
          ${v.checked_in_at ? '' : '<button class="btn sm ghost" data-act="checkin">Mark here</button>'}
          <button class="btn sm ${v.phone ? 'ghost' : ''}" data-act="match" title="Suggest vendors for this role">${v.phone ? 'Find another' : '✨ Find a match'}</button>
        </div>
      </li>`;
    }).join('') || '<li class="muted">No vendors yet.</li>';

    // activity
    $('feed').innerHTML = state.activity.map((a) => {
      const v = a.vendor_id && vmap[a.vendor_id];
      if (a.kind === 'notify') {
        const via = a.channel === 'log' ? 'not sent' : a.channel.replace(',', ' + ');
        const resend = v ? ` <a href="${waLink(v.phone, `${a.message}\n${vendorLink(v)}`)}" target="_blank" rel="noopener">Send on WhatsApp</a>` : '';
        return `<li><time>${Ros.timeAgo(a.at)}</time><span class="tag">To ${Ros.esc(v ? v.role : 'vendor')} · ${via}</span>${Ros.esc(a.message.replace(`${event.name}: `, ''))}${a.channel === 'log' ? resend : ''}</li>`;
      }
      return `<li><time>${Ros.timeAgo(a.at)}</time>${Ros.esc(a.message)}</li>`;
    }).join('') || '<li class="muted">Nothing yet.</li>';
  }

  function setStat(id, n, alert = false) {
    const el = $(id);
    el.querySelector('.n').textContent = n;
    el.classList.toggle('alert', alert);
  }

  // ---------- cue dialog ----------

  const cueDlg = $('cue-dlg');
  let editingCue = null;
  function openCue(cue) {
    editingCue = cue;
    const f = cueDlg.querySelector('form');
    $('cue-dlg-title').textContent = cue ? 'Edit cue' : 'New cue';
    f.title.value = cue?.title || '';
    f.time.value = cue ? Ros.fmt(cue.start_min) : '';
    f.duration.value = cue?.duration ?? 15;
    f.notes.value = cue?.notes || '';
    $('c-vendors').innerHTML = state.vendors.map((v) => `<label><input type="checkbox" value="${v.id}" ${cue?.vendor_ids.includes(v.id) ? 'checked' : ''}> ${Ros.esc(v.role)} <span class="muted small">${Ros.esc(v.name)}</span></label>`).join('') || '<span class="muted small">Add vendors first.</span>';
    $('c-hint').textContent = cue ? 'Changing the time notifies everyone on this cue.' : 'Everyone ticked gets notified.';
    $('c-delete').classList.toggle('hidden', !cue);
    cueDlg.showModal();
  }
  cueDlg.addEventListener('close', async () => {
    const f = cueDlg.querySelector('form');
    if (cueDlg.returnValue === 'delete' && editingCue) {
      if (confirm(`Remove "${editingCue.title}"? Its vendors will be told it's cancelled.`)) await act('DELETE', `/cues/${editingCue.id}`, null, 'Cue removed');
      return;
    }
    if (cueDlg.returnValue !== 'save') return;
    const start = Ros.parse(f.time.value);
    if (start === null) { Ros.toast('Time should look like 5:15pm or 17:15'); return openCue(editingCue); }
    const body = {
      title: f.title.value.trim(), start_min: start, duration: Number(f.duration.value || 0), notes: f.notes.value,
      vendor_ids: [...$('c-vendors').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    };
    if (editingCue) await act('PATCH', `/cues/${editingCue.id}`, body, 'Saved');
    else await act('POST', '/cues', body, 'Cue added');
  });

  // ---------- shift dialog ----------

  const shiftDlg = $('shift-dlg');
  let shiftFrom = null;
  function openShift(cue) {
    shiftFrom = cue;
    const f = shiftDlg.querySelector('form');
    f.minutes.value = '';
    shiftDlg.querySelectorAll('#s-quick .btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    $('s-from').textContent = `Moves "${cue.title}" (${Ros.fmt(cue.start_min)}) and every unfinished cue after it.`;
    previewShift();
    shiftDlg.showModal();
  }
  function affected() {
    if (!shiftFrom) return [];
    return state.cues.filter((c) => !c.done_at && (c.start_min > shiftFrom.start_min || (c.start_min === shiftFrom.start_min && c.id >= shiftFrom.id)));
  }
  function previewShift() {
    const mins = Number(shiftDlg.querySelector('form').minutes.value);
    const list = affected();
    const vendors = new Set(list.flatMap((c) => c.vendor_ids));
    $('s-preview').textContent = mins
      ? `${list.length} cues move, ${vendors.size} vendors get a message. "${shiftFrom.title}" becomes ${Ros.fmt(shiftFrom.start_min + mins)}.`
      : `${list.length} cues will move and ${vendors.size} vendors will be told.`;
  }
  $('s-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    shiftDlg.querySelector('form').minutes.value = b.dataset.min;
    shiftDlg.querySelectorAll('#s-quick .btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    previewShift();
  });
  $('s-min').addEventListener('input', previewShift);
  shiftDlg.addEventListener('close', async () => {
    if (shiftDlg.returnValue !== 'save') return;
    const minutes = Math.round(Number(shiftDlg.querySelector('form').minutes.value));
    if (!minutes) return;
    const r = await act('POST', `/cues/${shiftFrom.id}/shift`, { minutes });
    Ros.toast(`Moved ${r.moved} cues. Vendors notified.`);
  });
  $('shift-next').addEventListener('click', () => {
    const now = Ros.nowMin(state.event);
    const open = state.cues.filter((c) => !c.done_at);
    const from = open.find((c) => c.start_min + c.duration > now - 30) || open[0];
    if (!from) return Ros.toast('Every cue is already done.');
    openShift(from);
  });

  // ---------- vendor dialog ----------

  const vDlg = $('vendor-dlg');
  let editingVendor = null;
  function openVendor(v) {
    editingVendor = v;
    const f = vDlg.querySelector('form');
    $('v-dlg-title').textContent = v ? 'Edit vendor' : 'New vendor';
    f.name.value = v?.name || '';
    f.role.value = v?.role || '';
    f.phone.value = v?.phone ? `+${v.phone}` : '';
    f.can_seat.checked = Boolean(v?.can_seat);
    $('v-delete').classList.toggle('hidden', !v);
    vDlg.showModal();
  }
  vDlg.addEventListener('close', async () => {
    const f = vDlg.querySelector('form');
    if (vDlg.returnValue === 'delete' && editingVendor) {
      if (confirm(`Remove ${editingVendor.name}? Their link stops working.`)) await act('DELETE', `/vendors/${editingVendor.id}`, null, 'Vendor removed');
      return;
    }
    if (vDlg.returnValue !== 'save') return;
    const body = { name: f.name.value.trim(), role: f.role.value.trim(), phone: f.phone.value, can_seat: f.can_seat.checked };
    if (editingVendor) await act('PATCH', `/vendors/${editingVendor.id}`, body, 'Saved');
    else await act('POST', '/vendors', body, 'Vendor added. Send them their link.');
  });

  // ---------- events ----------

  $('add-cue').addEventListener('click', () => openCue(null));
  $('add-vendor').addEventListener('click', () => openVendor(null));
  $('cues').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const cue = state.cues.find((c) => c.id === Number(btn.closest('[data-id]').dataset.id));
    if (btn.dataset.act === 'edit') openCue(cue);
    if (btn.dataset.act === 'shift') openShift(cue);
    if (btn.dataset.act === 'done') await act('POST', `/cues/${cue.id}/done`, { done: true });
    if (btn.dataset.act === 'undo') await act('POST', `/cues/${cue.id}/done`, { done: false });
  });
  $('vendors').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const v = state.vendors.find((x) => x.id === Number(btn.closest('[data-id]').dataset.id));
    if (btn.dataset.act === 'copy') {
      try { await navigator.clipboard.writeText(vendorLink(v)); Ros.toast(`Copied ${v.name}'s link`); }
      catch { prompt('Copy this link', vendorLink(v)); }
    }
    if (btn.dataset.act === 'checkin') await act('POST', `/vendors/${v.id}/checkin`, null, `${v.name} marked as here`);
    if (btn.dataset.act === 'edit') openVendor(v);
    if (btn.dataset.act === 'match') openMatch(v);
  });

  // ---------- vendor matching ----------

  const mDlg = $('match-dlg');
  let matchFor = null;
  let matches = [];
  function openMatch(v) {
    matchFor = v;
    $('m-title').textContent = `Find a ${v.role}`;
    $('m-need').value = '';
    mDlg.showModal();
    findMatches();
  }
  async function findMatches() {
    const v = matchFor;
    const need = $('m-need').value.trim();
    $('m-list').innerHTML = '<li class="muted">Looking…</li>';
    $('m-note').textContent = '';
    let r;
    try { r = await Ros.api('GET', `${base}/vendors/${v.id}/matches?need=${encodeURIComponent(need)}`); }
    catch (err) { $('m-list').innerHTML = `<li class="muted">${Ros.esc(err.message)}</li>`; return; }
    if (matchFor !== v) return;
    matches = r.candidates;
    $('m-note').textContent = v.phone ? `${v.name} already has this role. Message someone here to line up a backup, then add them as a new vendor.` : r.source === 'ai' ? 'Matched to what you need by reading couples’ reviews.'
      : need && !r.ai ? 'Ranked by reviews that mention your words.' : '';
    $('m-list').innerHTML = matches.map((c, i) => `<li>
        <div class="grow">
          <div><strong>${Ros.esc(c.name)}</strong> <span class="muted small">${Ros.esc(c.role)}${c.city ? ` · ${Ros.esc(c.city)}` : ''}</span></div>
          <div class="small">${c.rating ? `<span class="rated">${'★'.repeat(Math.round(c.rating))}</span> ${c.rating} from ${c.reviews} verified review${c.reviews === 1 ? '' : 's'}` : '<span class="muted">No reviews yet</span>'}</div>
          <div class="small">${Ros.esc(c.reason)}</div>
          ${c.quote ? `<div class="muted small quote">“${Ros.esc(c.quote)}”</div>` : ''}
        </div>
        <div class="acts">
          <a class="btn sm ghost" href="${c.profile_url}" target="_blank" rel="noopener">Reviews</a>
          <a class="btn sm" href="${waLink(c.phone, `Hi ${c.name}, I'm planning ${state.event.name} on ${Ros.fmtDate(state.event.date)}${state.event.venue ? ` at ${state.event.venue}` : ''}. Are you available as our ${v.role}?`)}" target="_blank" rel="noopener">Ask on WhatsApp</a>
          ${v.phone ? '' : `<button class="btn sm primary" type="button" data-use="${i}">Use</button>`}
        </div>
      </li>`).join('') || `<li class="muted">No ${Ros.esc(v.role)} to suggest yet. Vendors you add to your events, and vendors who list themselves from their page, show up here.</li>`;
  }
  $('m-find').addEventListener('click', findMatches);
  $('m-need').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findMatches(); } });
  $('m-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-use]');
    if (!b) return;
    const c = matches[Number(b.dataset.use)];
    await act('PATCH', `/vendors/${matchFor.id}`, { name: c.name, phone: c.phone }, `${c.name} is now your ${matchFor.role}. Send them their link.`);
    mDlg.close();
  });
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    document.querySelectorAll('.tabs [data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
  });

  // ---------- live connection ----------

  const socket = io({ auth: { planner: token } });
  socket.on('state', (s) => { state = s; Ros.cache.set(cacheKey, s); render(); });
  socket.on('connect', () => $('offline').classList.add('hidden'));
  socket.on('disconnect', () => $('offline').classList.remove('hidden'));
  socket.on('connect_error', () => $('offline').classList.remove('hidden'));
  if (!state) Ros.api('GET', base).then((s) => { state = s; render(); }).catch((err) => { $('ev-name').textContent = err.status === 404 ? 'Event not found' : 'Could not load'; });
  render();
  setInterval(render, 20000);
  RosNav.mount('');
  Ros.registerSW();
})();
