/* global Ros, RosSection */
(() => {
  const $ = (id) => document.getElementById(id);
  let data = { items: [], orders: [], stats: {} };

  function render() {
    const s = data.stats;
    if (data.billing && !data.paystack) $('share-hint').innerHTML = `Want buyers to pay by card? ${RosSection.mode === 'c' ? 'Ask your planner to add their payout bank account.' : 'Add your payout bank account on <a href="/dashboard">My events</a>.'} Until then they pay by bank transfer and you mark orders paid.`;
    $('s-orders').textContent = s.orders ?? 0;
    $('s-pieces').textContent = s.pieces ?? 0;
    $('s-ordered').textContent = Ros.naira(s.ordered || 0);
    $('s-paid').textContent = Ros.naira(s.paid || 0);
    $('s-collected').textContent = `${s.collected ?? 0}/${s.paid_orders ?? 0}`;

    $('items').innerHTML = data.items.map((it) => `<li data-id="${it.id}">
      <button class="vname" data-act="edit"><div class="name">${Ros.esc(it.name)}</div>
        <div class="muted small">${Ros.naira(it.price)}${it.options ? ` · ${Ros.esc(it.options.split(',').join(', '))}` : ''}</div></button>
      ${it.active ? '<span class="pill ok">On sale</span>' : '<span class="pill">Hidden</span>'}
    </li>`).join('') || '<li class="muted">Add what you’re selling, e.g. gele, fabric, caps.</li>';

    const q = $('q').value.trim().toLowerCase();
    const f = $('filter').value;
    const rows = data.orders.filter((o) => {
      if (q && !`${o.buyer_name} ${o.phone}`.toLowerCase().includes(q)) return false;
      if (f === 'unpaid') return !o.paid_at;
      if (f === 'paid') return Boolean(o.paid_at);
      if (f === 'tocollect') return o.paid_at && !o.collected_at;
      if (f === 'collected') return Boolean(o.collected_at);
      return true;
    });
    $('empty').classList.toggle('hidden', data.orders.length > 0);
    $('rows').innerHTML = rows.map((o) => {
      const remind = `Hello ${o.buyer_name}, a reminder about your aso-ebi order (${o.qty} × ${o.item_name}${o.option ? `, ${o.option}` : ''}): ${Ros.naira(o.amount)}. Details: ${location.origin}/o/${o.token}`;
      return `<tr data-id="${o.id}">
        <td><strong>${Ros.esc(o.buyer_name)}</strong><div class="muted small">${o.phone ? `+${Ros.esc(o.phone)}` : ''}</div></td>
        <td>${o.qty} × ${Ros.esc(o.item_name)}${o.option ? `<div class="muted small">${Ros.esc(o.option)}</div>` : ''}</td>
        <td class="num">${Ros.naira(o.amount)}</td>
        <td>${o.paid_at ? `<button class="btn sm ok" data-act="unpay" title="Mark as not paid">✓ Paid</button>${o.payment_ref ? '<div class="muted small">Card</div>' : ''}` : '<button class="btn sm" data-act="pay">Mark paid</button>'}</td>
        <td>${o.collected_at ? '<button class="btn sm ok" data-act="uncollect">✓ Collected</button>' : `<button class="btn sm" data-act="collect" ${o.paid_at ? '' : 'disabled title="Mark paid first"'}>Collected</button>`}</td>
        <td><div class="acts"><a class="btn sm ghost" target="_blank" rel="noopener" href="${Ros.waLink(o.phone, remind)}">WhatsApp</a><button class="btn sm ghost danger" data-act="delete">Delete</button></div></td>
      </tr>`;
    }).join('');
  }

  const load = async () => { data = await RosSection.api('GET', '/asoebi'); render(); };
  const refresh = RosSection.start({ section: 'asoebi', topics: ['asoebi'], load });

  const openItem = RosSection.dialog('item-dlg', {
    fill(form, it) {
      form.active.checked = it ? Boolean(it.active) : true;
      if (!it) return;
      form.name.value = it.name;
      form.price.value = Ros.nairaInput(it.price);
      form.options.value = it.options.split(',').join(', ');
      form.description.value = it.description;
    },
    async save(form, it) {
      const price = Ros.toKobo(form.price.value);
      if (price === null) return Ros.toast('Enter the price as a number, e.g. 45000');
      const body = { name: form.name.value, price, options: form.options.value, description: form.description.value, active: form.active.checked };
      if (it) await RosSection.api('PATCH', `/asoebi/items/${it.id}`, body);
      else await RosSection.api('POST', '/asoebi/items', body);
      refresh();
    },
  });

  $('add-item').addEventListener('click', () => openItem(null));
  $('items').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act=edit]');
    if (b) openItem(data.items.find((x) => x.id === Number(b.closest('[data-id]').dataset.id)));
  });
  $('q').addEventListener('input', render);
  $('filter').addEventListener('change', render);
  $('rows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const o = data.orders.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
    const act = b.dataset.act;
    if (act === 'pay' || act === 'unpay') await RosSection.api('POST', `/asoebi/orders/${o.id}/paid`, { paid: act === 'pay' });
    if (act === 'collect' || act === 'uncollect') await RosSection.api('POST', `/asoebi/orders/${o.id}/collected`, { collected: act === 'collect' });
    if (act === 'delete') {
      if (!confirm(`Delete ${o.buyer_name}'s order?`)) return;
      await RosSection.api('DELETE', `/asoebi/orders/${o.id}`);
    }
    refresh();
  });
})();
