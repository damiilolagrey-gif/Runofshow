/* global Ros, RosSection */
(() => {
  const $ = (id) => document.getElementById(id);
  let data = { vendors: [], lines: [], unlinked: [], upcoming: [], totals: {} };
  const N = Ros.naira;

  function render() {
    const t = data.totals;
    $('t-planned').textContent = N(t.planned || 0);
    $('t-committed').textContent = N(t.committed || 0);
    $('t-committed').classList.toggle('neg', t.planned > 0 && t.committed > t.planned);
    $('t-paid').textContent = N(t.paid || 0);
    $('t-owed').textContent = N(t.owed_to_vendors || 0);
    $('t-overdue').textContent = N(t.overdue || 0);
    $('t-overdue-card').classList.toggle('alert', t.overdue > 0);

    $('vendors').innerHTML = data.vendors.map((v) => {
      const pct = v.fee ? Math.min(100, Math.round((v.paid / v.fee) * 100)) : 0;
      const agreement = !v.fee && !v.terms ? '<span class="pill">No agreement</span>'
        : v.accepted_at ? '<span class="pill ok">Accepted</span>' : '<span class="pill soon">Awaiting accept</span>';
      const pays = v.payments.map((p) => `<div class="row small" data-pay="${p.id}" style="margin-top:4px">
        <span class="grow">${Ros.esc(p.label)} · ${N(p.amount)}${p.due_date ? ` · due ${Ros.fmtDate(p.due_date)}` : ''}</span>
        ${p.paid_at ? '<span class="pill done">Paid</span>' : `<button class="btn sm" data-act="mark-paid">Mark paid</button>`}
        <button class="btn sm ghost" data-act="edit-pay">Edit</button></div>`).join('');
      return `<li data-id="${v.vendor_id}">
        <button class="vname" data-act="deal"><div class="name">${Ros.esc(v.name)}</div>
          <div class="muted small">${v.name === v.role ? '' : `${Ros.esc(v.role)} · `}${v.fee ? `${N(v.paid)} of ${N(v.fee)} paid${v.balance ? ` · ${N(v.balance)} left` : ''}` : 'Tap to set fee and agreement'}</div></button>
        ${agreement}
        ${v.fee ? `<div style="grid-column:1/-1"><div class="bar"><span style="width:${pct}%"></span></div>${v.unscheduled ? `<div class="muted small" style="margin-top:4px">${N(v.unscheduled)} not scheduled yet</div>` : ''}</div>` : ''}
        ${pays ? `<div style="grid-column:1/-1">${pays}</div>` : ''}
      </li>`;
    }).join('') || '<li class="muted">Add vendors on the Timeline page first.</li>';

    $('upcoming').innerHTML = data.upcoming.slice(0, 12).map((p) => `<li data-pay="${p.id}" class="row">
      <span class="grow"><strong>${Ros.esc(p.vendor)}</strong> · ${Ros.esc(p.label)} · ${N(p.amount)}
        <div class="small ${p.overdue ? 'neg' : 'muted'}">${p.due_date ? `${p.overdue ? 'Overdue since' : 'Due'} ${Ros.fmtDate(p.due_date)}` : 'No due date'}</div></span>
      <button class="btn sm" data-act="mark-paid">Mark paid</button></li>`).join('') || '<li class="muted">Nothing unpaid. Add payments with due dates to see them here.</li>';

    const lineRow = (l, linked) => {
      const over = l.planned && l.committed > l.planned;
      return `<tr ${linked ? `data-line="${l.id}" style="cursor:pointer"` : ''}>
        <td><strong>${Ros.esc(l.category || l.name)}</strong><div class="muted small">${Ros.esc(l.label || '')}${l.vendor_name ? `${l.label ? ' · ' : ''}${Ros.esc(l.vendor_name)}` : ''}${linked ? '' : `${Ros.esc(l.role)} · not in budget`}</div></td>
        <td class="num">${l.planned ? N(l.planned) : '–'}</td>
        <td class="num ${over ? 'neg' : ''}">${N(l.committed)}</td>
        <td class="num">${N(l.paid)}</td></tr>`;
    };
    $('lines').innerHTML = data.lines.map((l) => lineRow(l, true)).join('') + data.unlinked.map((u) => lineRow({ ...u, category: u.name }, false)).join('');
    $('lines-empty').classList.toggle('hidden', data.lines.length + data.unlinked.length > 0);
  }

  const load = async () => { data = await RosSection.api('GET', '/money'); render(); };
  const refresh = RosSection.start({ section: 'money', topics: ['money'], load });
  const vendorOptions = (blank) => (blank ? `<option value="">${blank}</option>` : '') + data.vendors.map((v) => `<option value="${v.vendor_id}">${Ros.esc(v.name)}${v.name === v.role ? '' : ` (${Ros.esc(v.role)})`}</option>`).join('');
  const allPayments = () => data.vendors.flatMap((v) => v.payments);

  const openDeal = RosSection.dialog('deal-dlg', {
    fill(form, v) {
      $('deal-title').textContent = `Agreement with ${v.name}`;
      form.fee.value = Ros.nairaInput(v.agreed_fee);
      form.terms.value = v.terms || '';
    },
    async save(form, v) {
      const fee = Ros.toKobo(form.fee.value || 0);
      if (fee === null) return Ros.toast('Enter the fee as a number');
      await RosSection.api('PATCH', `/vendors/${v.vendor_id}/deal`, { fee, terms: form.terms.value });
      refresh();
    },
  });

  const openPay = RosSection.dialog('pay-dlg', {
    fill(form, p) {
      form.vendor_id.innerHTML = vendorOptions();
      form.vendor_id.disabled = Boolean(p);
      if (!p) return;
      form.vendor_id.value = p.vendor_id;
      form.label.value = p.label;
      form.amount.value = Ros.nairaInput(p.amount);
      form.due_date.value = p.due_date || '';
      form.paid.checked = Boolean(p.paid_at);
    },
    async save(form, p) {
      const amount = Ros.toKobo(form.amount.value);
      if (!amount) return Ros.toast('Enter an amount');
      const body = { vendor_id: form.vendor_id.value, label: form.label.value, amount, due_date: form.due_date.value || null, paid: form.paid.checked };
      if (p) await RosSection.api('PATCH', `/payments/${p.id}`, body);
      else await RosSection.api('POST', '/payments', body);
      refresh();
    },
    async remove(p) {
      if (!confirm('Delete this payment?')) return;
      await RosSection.api('DELETE', `/payments/${p.id}`);
      refresh();
    },
  });

  const openLine = RosSection.dialog('line-dlg', {
    fill(form, l) {
      form.vendor_id.innerHTML = vendorOptions('Not a vendor');
      const toggleSpent = () => $('l-spent-field').classList.toggle('hidden', Boolean(form.vendor_id.value));
      form.vendor_id.onchange = toggleSpent;
      if (l) {
        form.category.value = l.category;
        form.label.value = l.label;
        form.planned.value = Ros.nairaInput(l.planned);
        form.spent.value = Ros.nairaInput(l.spent);
        form.vendor_id.value = l.vendor_id || '';
      }
      toggleSpent();
    },
    async save(form, l) {
      const planned = Ros.toKobo(form.planned.value || 0);
      const spent = Ros.toKobo(form.spent.value || 0);
      if (planned === null || spent === null) return Ros.toast('Amounts must be numbers');
      const body = { category: form.category.value, label: form.label.value, planned, spent, vendor_id: form.vendor_id.value || null };
      if (l) await RosSection.api('PATCH', `/budget/${l.id}`, body);
      else await RosSection.api('POST', '/budget', body);
      refresh();
    },
    async remove(l) {
      if (!confirm(`Delete the ${l.category} line?`)) return;
      await RosSection.api('DELETE', `/budget/${l.id}`);
      refresh();
    },
  });

  $('add-pay').addEventListener('click', () => openPay(null));
  $('add-line').addEventListener('click', () => openLine(null));
  $('lines').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-line]');
    if (tr) openLine(data.lines.find((l) => l.id === Number(tr.dataset.line)));
  });
  document.querySelector('main').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const payEl = b.closest('[data-pay]');
    const pay = payEl && allPayments().find((p) => p.id === Number(payEl.dataset.pay));
    if (b.dataset.act === 'mark-paid') { await RosSection.api('PATCH', `/payments/${pay.id}`, { paid: true }); refresh(); }
    if (b.dataset.act === 'edit-pay') openPay(pay);
    if (b.dataset.act === 'deal') openDeal(data.vendors.find((v) => v.vendor_id === Number(b.closest('[data-id]').dataset.id)));
  });
})();
