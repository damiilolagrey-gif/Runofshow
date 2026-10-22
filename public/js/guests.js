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
      return `<tr data-id="${g.id}">
        <td><strong>${Ros.esc(g.name)}</strong><div class="muted small">${g.phone ? `+${Ros.esc(g.phone)} · ` : ''}code ${g.code}${g.source === 'public' ? ' · via RSVP link' : ''}</div></td>
        <td class="num">${g.party_size}</td>
        <td class="hide-sm">${Ros.esc(g.side)}</td>
        <td>${Ros.esc(g.table_label) || '<span class="muted">–</span>'}</td>
        <td>${rsvpPill[g.rsvp]}</td>
        <td class="hide-sm">${g.arrived_at ? `<span class="pill done">${Ros.timeAgo(g.arrived_at)}</span>` : '<span class="muted">–</span>'}</td>
        <td><div class="acts">
          <a class="btn sm" target="_blank" rel="noopener" href="${Ros.waLink(g.phone, msg)}">Send invite</a>
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
  });
})();
