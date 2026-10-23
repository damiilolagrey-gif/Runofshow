/* global Ros, RosSection */
(() => {
  const $ = (id) => document.getElementById(id);
  let data = { tables: [], guests: [], stats: {} };

  function render() {
    const s = data.stats;
    $('s-tables').textContent = s.tables;
    $('s-seats').textContent = s.seats;
    $('s-coming').textContent = s.coming_people;
    $('s-seated').textContent = s.seated_people;
    $('s-unseated').textContent = s.unseated_people;
    $('s-unseated-card').classList.toggle('alert', s.unseated_people > 0 && s.tables > 0);
    $('unknown').textContent = s.unknown_tables.length ? `Some guests are at tables that aren’t in the plan yet: ${s.unknown_tables.join(', ')}.`
      : s.seats < s.coming_people ? `You need ${s.coming_people - s.seats} more seats for everyone coming.` : '';
    $('empty').classList.toggle('hidden', data.tables.length > 0);

    const options = (current) => `<option value="">Pick a table</option>${data.tables.map((t) => {
      const left = t.seats - t.seated;
      return `<option value="${Ros.esc(t.label)}" ${t.label === current ? 'selected' : ''}>${Ros.esc(t.label)} · ${left} free</option>`;
    }).join('')}`;
    const showPending = $('show-pending').checked;
    const waiting = data.guests.filter((g) => !g.table_label && (g.rsvp === 'yes' || showPending));
    $('unseated').innerHTML = waiting.map((g) => `<li data-id="${g.id}"><span><strong>${Ros.esc(g.name)}</strong>
        <div class="muted small">${g.party_size} ${g.party_size === 1 ? 'person' : 'people'}${g.side ? ` · ${Ros.esc(g.side)}` : ''}${g.rsvp === 'pending' ? ' · not replied' : ''}</div></span>
        <select data-act="seat" aria-label="Table for ${Ros.esc(g.name)}">${options('')}</select></li>`).join('')
      || '<li class="muted" style="display:block">Everyone coming has a seat. 🎉</li>';

    $('tables').innerHTML = data.tables.map((t) => {
      const at = data.guests.filter((g) => g.table_label === t.label);
      const cls = t.seated > t.seats ? 'over' : t.seated === t.seats ? 'full' : '';
      return `<div class="card table-card ${cls}" data-table="${t.id}">
        <div class="head"><strong>Table ${Ros.esc(t.label)}</strong><span class="count small">${t.seated} / ${t.seats}</span><button class="btn sm ghost" data-act="edit-table">Edit</button></div>
        <div class="bar"><span class="${cls === 'over' ? 'over' : ''}" style="width:${Math.min(100, Math.round((t.seated / t.seats) * 100))}%"></span></div>
        <ul>${at.map((g) => `<li data-id="${g.id}"><span>${Ros.esc(g.name)}${g.party_size > 1 ? ` <span class="muted">+${g.party_size - 1}</span>` : ''}${g.rsvp === 'pending' ? ' <span class="muted small">(not replied)</span>' : ''}</span>
          <select data-act="seat" class="move" aria-label="Move ${Ros.esc(g.name)}">${options(t.label)}<option value="">Remove from table</option></select></li>`).join('')}</ul>
      </div>`;
    }).join('');
  }

  async function load() {
    try {
      data = await RosSection.api('GET', '/tables');
      $('denied').classList.add('hidden');
      $('plan').classList.remove('hidden');
      render();
    } catch (err) {
      if (err.status === 403) {
        $('denied-text').textContent = err.message;
        $('denied').classList.remove('hidden');
        $('plan').classList.add('hidden');
      }
    }
  }
  const refresh = RosSection.start({ section: 'tables', topics: ['guests'], load });

  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-act=seat]');
    if (!sel) return;
    await RosSection.api('POST', '/tables/seat', { guest_id: Number(sel.closest('[data-id]').dataset.id), table_label: sel.value });
    refresh();
  });
  $('show-pending').addEventListener('change', render);
  $('auto').addEventListener('click', async () => {
    const r = await RosSection.api('POST', '/tables/auto');
    Ros.toast(r.left ? `Seated ${r.seated}. ${r.left} didn’t fit: add more tables or seats.` : `Seated ${r.seated} guests`);
    refresh();
  });

  const openTable = RosSection.dialog('table-dlg', {
    fill(form, t) {
      $('table-title').textContent = t ? `Table ${t.label}` : 'New table';
      form.label.value = t?.label || String(data.tables.length + 1);
      form.seats.value = t?.seats || data.tables.at(-1)?.seats || 10;
    },
    async save(form, t) {
      const body = { label: form.label.value, seats: Number(form.seats.value) };
      await RosSection.api(t ? 'PATCH' : 'POST', t ? `/tables/${t.id}` : '/tables', body);
      refresh();
    },
    async remove(t) {
      if (!confirm(`Delete table ${t.label}? Its guests go back to "Need a seat".`)) return;
      await RosSection.api('DELETE', `/tables/${t.id}`);
      refresh();
    },
  });
  const openMany = RosSection.dialog('many-dlg', {
    fill() {},
    async save(form) {
      const r = await RosSection.api('POST', '/tables', { count: Number(form.count.value), seats: Number(form.seats.value) });
      Ros.toast(`Added ${r.added} tables`);
      refresh();
    },
  });
  $('add-table').addEventListener('click', () => openTable(null));
  $('add-many').addEventListener('click', () => openMany(null));
  $('tables').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act=edit-table]');
    if (b) openTable(data.tables.find((t) => t.id === Number(b.closest('[data-table]').dataset.table)));
  });
})();
