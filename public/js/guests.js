/* global Ros, RosSection */
(() => {
  const $ = (id) => document.getElementById(id);
  let data = { guests: [], stats: {} };
  const rsvpPill = { yes: '<span class="pill ok">Coming</span>', no: '<span class="pill late">Can’t come</span>', pending: '<span class="pill">Not replied</span>' };

  function render() {
    const s = data.stats;
    $('s-invited').textContent = s.invited_people ?? 0;
    $('s-yes').textContent = s.yes_people ?? 0;
    $('s-pending').textContent = s.pending ?? 0;
    $('s-no').textContent = s.no ?? 0;
    $('s-arrived').textContent = `${s.arrived_people ?? 0}`;
    const q = $('q').value.trim().toLowerCase();
    const f = $('filter').value;
    const rows = data.guests.filter((g) => {
      if (q && ![g.name, g.phone, g.table_label, g.code].join(' ').toLowerCase().includes(q)) return false;
      if (f === 'arrived') return Boolean(g.arrived_at);
      if (f === 'notarrived') return g.rsvp === 'yes' && !g.arrived_at;
      return f === 'all' || g.rsvp === f;
    });
    $('empty').classList.toggle('hidden', data.guests.length > 0);
    $('rows').innerHTML = rows.map((g) => {
      const link = `${location.origin}/i/${g.token}`;
      const msg = `Hello ${g.name}, you're invited to ${document.getElementById('ev-name').textContent}. Please RSVP here, and show the QR code at the gate on the day: ${link}`;
      const sent = [g.invited_at && 'invite sent', g.pass_sent_at && 'pass sent'].filter(Boolean).join(' · ');
      return `<tr data-id="${g.id}">
        <td><strong>${Ros.esc(g.name)}</strong><div class="muted small">${g.phone ? `+${Ros.esc(g.phone)} · ` : ''}code ${g.code}${g.source === 'public' ? ' · via RSVP link' : ''}${sent ? ` · ${sent}` : ''}</div></td>
        <td class="num">${g.party_size}</td>
        <td class="hide-sm">${Ros.esc(g.side)}</td>
        <td>${Ros.esc(g.table_label) || '<span class="muted">–</span>'}</td>
        <td>${rsvpPill[g.rsvp]}</td>
        <td class="hide-sm">${g.arrived_at ? `<span class="pill done">${Ros.timeAgo(g.arrived_at)}</span>` : '<span class="muted">–</span>'}</td>
        <td><div class="acts">
          <a class="btn sm" target="_blank" rel="noopener" data-act="invited" href="${Ros.waLink(g.phone, msg)}">Send invite</a>
          <button class="btn sm ghost" data-act="copy" data-link="${link}">Copy link</button>
          <button class="btn sm ghost" data-act="edit">Edit</button>
        </div></td>
      </tr>`;
    }).join('');
  }

  const load = async () => { data = await RosSection.api('GET', '/guests'); render(); };
  const refresh = RosSection.start({ section: 'guests', topics: ['guests'], load });

  const openGuest = RosSection.dialog('guest-dlg', {
    fill(form, g) {
      if (!g) return;
      for (const k of ['name', 'party_size', 'side', 'table_label', 'rsvp']) form[k].value = g[k];
      form.phone.value = g.phone ? `+${g.phone}` : '';
    },
    async save(form, g) {
      const body = Object.fromEntries(new FormData(form));
      if (g) await RosSection.api('PATCH', `/guests/${g.id}`, body);
      else await RosSection.api('POST', '/guests', body);
      refresh();
    },
    async remove(g) {
      if (!confirm(`Remove ${g.name} from the guest list? Their QR code will stop working.`)) return;
      await RosSection.api('DELETE', `/guests/${g.id}`);
      refresh();
    },
  });
  const openImport = RosSection.dialog('import-dlg', {
    fill() {},
    async save(form) {
      const { added } = await RosSection.api('POST', '/guests/import', { text: form.text.value });
      Ros.toast(`Imported ${added} guests`);
      refresh();
    },
  });

  $('add').addEventListener('click', () => openGuest(null));
  $('import').addEventListener('click', () => openImport(null));
  $('q').addEventListener('input', render);
  $('filter').addEventListener('change', render);
  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const g = data.guests.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
    if (b.dataset.act === 'edit') openGuest(g);
    if (b.dataset.act === 'copy') Ros.copy(b.dataset.link, `${g.name}'s invite link`);
    if (b.dataset.act === 'invited') RosSection.api('POST', `/invites/${g.id}/sent`).catch(() => {});
  });

  // ---------- invites and replies ----------

  const ago = (t) => (t ? Ros.timeAgo(t) : '');
  async function loadInvites() {
    const d = await RosSection.api('GET', '/invites');
    const waiting = d.guests.filter((g) => g.rsvp === 'pending');
    const notSent = waiting.filter((g) => g.phone && !g.invited_at).length;
    $('inv-auto').innerHTML = d.whatsapp
      ? `<div class="row"><span class="grow">${notSent} guests with a number haven't had an invite. Replies come back to your WhatsApp business number and ${d.ai ? 'the AI assistant' : 'the assistant'} RSVPs them for you.</span>
          <button class="btn primary" type="button" data-inv="send" ${notSent ? '' : 'disabled'}>Send ${notSent} invites</button>
          <button class="btn" type="button" data-inv="resend" ${waiting.length ? '' : 'disabled'}>Remind everyone not replied</button></div>`
      : '<p class="muted small" style="margin:0">Tap WhatsApp next to each guest to send their invite from your phone. To let guests RSVP by replying, connect a WhatsApp Business number. Your planner can set that up once for all their events.</p>';
    $('inv-list').innerHTML = waiting.map((g) => `<li data-id="${g.id}"><span class="grow"><strong>${Ros.esc(g.name)}</strong>
        <div class="muted small">${g.phone ? `+${Ros.esc(g.phone)}` : 'No number'}${g.invited_at ? ` · invited ${ago(g.invited_at)}` : ''}</div></span>
        ${g.phone ? `<a class="btn sm" target="_blank" rel="noopener" data-inv="manual" href="${Ros.waLink(g.phone, g.text)}">WhatsApp</a>` : ''}</li>`).join('')
      || '<li class="muted">Everyone has replied. 🎉</li>';
    $('inv-replies').innerHTML = d.replies.map((m) => `<li data-id="${m.guest_id}"><span class="grow"><strong>${Ros.esc(m.name)}</strong> <span class="muted small">${ago(m.at)}</span>
        <div class="small">${Ros.esc(m.body)}</div></span>${rsvpPill[m.rsvp]}<button class="btn sm ghost" type="button" data-inv="chat">Chat</button></li>`).join('')
      || `<li class="muted">${d.whatsapp ? 'No replies yet.' : 'Replies show here once a WhatsApp Business number is connected.'}</li>`;
  }
  $('open-invites').addEventListener('click', async () => { await loadInvites(); $('invites-dlg').showModal(); });
  $('invites-dlg').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-inv]');
    if (!b) return;
    const id = b.closest('[data-id]')?.dataset.id;
    if (b.dataset.inv === 'manual') { RosSection.api('POST', `/invites/${id}/sent`).catch(() => {}); return; }
    if (b.dataset.inv === 'chat') { openChat(data.guests.find((g) => g.id === Number(id))); return; }
    b.disabled = true;
    const r = await RosSection.api('POST', '/invites/send', { resend: b.dataset.inv === 'resend' });
    Ros.toast(`Sent ${r.sent} invites${r.failed ? `, ${r.failed} failed` : ''}`);
    loadInvites();
  });

  async function openChat(g) {
    if (!g) return;
    const list = await RosSection.api('GET', `/guests/${g.id}/messages`);
    $('chat-title').textContent = `${g.name} on WhatsApp`;
    $('chat-list').innerHTML = list.map((m) => `<li class="${m.direction}">${Ros.esc(m.body)}<time>${ago(m.at)}</time></li>`).join('') || '<li class="in muted">No messages yet.</li>';
    $('chat-dlg').showModal();
  }

  // ---------- passes on the day ----------

  async function loadPasses() {
    const d = await RosSection.api('GET', '/passes');
    $('pass-auto').checked = d.auto;
    $('pass-time').value = d.time;
    $('pass-auto').disabled = $('pass-time').disabled = !d.whatsapp;
    $('pass-auto-note').textContent = !d.whatsapp ? 'Automatic sending needs a WhatsApp Business number. Until then, send each pass from your phone below.'
      : d.sent_at ? `Sent ${Ros.timeAgo(d.sent_at)}.` : `Goes out on ${Ros.fmtDate(d.date)} at ${d.time} to everyone who said yes and has a number.`;
    const unsent = d.guests.filter((g) => g.phone && !g.pass_sent_at);
    const unseated = d.guests.filter((g) => !g.table_label).length;
    $('pass-summary').innerHTML = `${d.guests.length} coming · ${d.guests.length - unsent.length} sent${unseated ? ` · <span class="neg">${unseated} without a table</span>` : ''}`;
    $('pass-send').classList.toggle('hidden', !d.whatsapp);
    $('pass-send').disabled = !unsent.length;
    $('pass-send').textContent = `Send ${unsent.length} now`;
    $('pass-list').innerHTML = d.guests.map((g) => `<li data-id="${g.id}"><span class="grow"><strong>${Ros.esc(g.name)}</strong>
        <div class="muted small">${g.table_label ? `Table ${Ros.esc(g.table_label)}` : 'No table yet'} · admits ${g.party_size}${g.pass_sent_at ? ` · sent ${ago(g.pass_sent_at)}` : ''}</div></span>
        ${g.phone ? `<a class="btn sm${g.pass_sent_at ? ' ghost' : ''}" target="_blank" rel="noopener" data-pass="manual" href="${Ros.waLink(g.phone, g.text)}">${g.pass_sent_at ? 'Resend' : 'WhatsApp'}</a>` : '<span class="muted small">No number</span>'}</li>`).join('')
      || '<li class="muted">Nobody has said yes yet.</li>';
  }
  $('open-passes').addEventListener('click', async () => { await loadPasses(); $('passes-dlg').showModal(); });
  const savePassSettings = () => RosSection.api('PATCH', '/guest-settings', { passes_auto: $('pass-auto').checked, passes_time: $('pass-time').value }).then(loadPasses);
  $('pass-auto').addEventListener('change', savePassSettings);
  $('pass-time').addEventListener('change', savePassSettings);
  $('pass-send').addEventListener('click', async () => {
    $('pass-send').disabled = true;
    const r = await RosSection.api('POST', '/passes/send');
    Ros.toast(`Sent ${r.sent} passes${r.failed ? `, ${r.failed} failed` : ''}`);
    loadPasses();
  });
  $('pass-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pass]');
    if (b) RosSection.api('POST', `/passes/${b.closest('[data-id]').dataset.id}/sent`).then(loadPasses).catch(() => {});
  });
})();
