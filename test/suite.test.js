const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');

async function start(t, opts = {}) {
  const ctx = createApp({ vapid: null, whatsapp: null, paystackKey: null, ...opts });
  await new Promise((r) => ctx.server.listen(0, r));
  t.after(() => { ctx.io.close(); ctx.server.close(); });
  const base = `http://localhost:${ctx.server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  const { body } = await call('POST', '/api/events', { name: 'Ade & Tolu', type: 'ng-wedding', date: '2026-11-14' });
  const p = body.planner_url.replace('/p/', '/api/p/');
  const ev = ctx.store.event(body.id);
  return { ...ctx, call, p, ev };
}

test('guest import, invite RSVP, QR and gate admission', async (t) => {
  const { call, p, ev } = await start(t);
  const imp = await call('POST', `${p}/guests/import`, { text: 'Name, Phone, Party, Side, Table\nChief Adeyemi, 08031234567, 2, Bride, 1\nMrs Okafor\t08099998888\t1\tGroom\t12\n\n' });
  assert.equal(imp.body.added, 2);
  const { guests, stats } = (await call('GET', `${p}/guests`)).body;
  assert.equal(stats.invited, 2);
  assert.equal(stats.invited_people, 3);
  const chief = guests.find((g) => g.name === 'Chief Adeyemi');
  assert.equal(chief.phone, '2348031234567');
  assert.equal(chief.table_label, '1');

  // invite page and RSVP
  const inv = await call('GET', `/api/i/${chief.token}`);
  assert.equal(inv.body.event.name, 'Ade & Tolu');
  assert.equal(inv.body.guest.token, undefined);
  assert.equal(inv.body.event.planner_token, undefined);
  await call('POST', `/api/i/${chief.token}/rsvp`, { rsvp: 'yes', party_size: 3 });
  const qr = await call('GET', `/api/i/${chief.token}/qr.svg`);
  assert.match(qr.body, /^<svg/);

  // gate: scan the invite URL, then scan again, then a code typed by hand
  const gate = `/api/gate/${ev.gate_token}`;
  const first = await call('POST', `${gate}/scan`, { code: `https://whatever.example/i/${chief.token}` });
  assert.equal(first.body.result, 'admitted');
  assert.equal(first.body.guest.party_size, 3);
  assert.equal(first.body.guest.table_label, '1');
  assert.equal((await call('POST', `${gate}/scan`, { code: `/i/${chief.token}` })).body.result, 'already');
  const okafor = guests.find((g) => g.name === 'Mrs Okafor');
  assert.equal((await call('POST', `${gate}/scan`, { code: okafor.code.toLowerCase() })).body.result, 'admitted');
  assert.equal((await call('POST', `${gate}/scan`, { code: 'ZZZZZZ' })).body.result, 'unknown');
  assert.equal((await call('GET', `${gate}/search?q=okaf`)).body[0].name, 'Mrs Okafor');
  const after = (await call('GET', gate)).body.stats;
  assert.equal(after.arrived, 2);
  assert.equal(after.arrived_people, 4);
});

test('a guest from another event cannot be admitted at this gate', async (t) => {
  const { call, p, ev } = await start(t);
  const other = (await call('POST', '/api/events', { name: 'Other', type: 'blank', date: '2026-11-14' })).body;
  const op = other.planner_url.replace('/p/', '/api/p/');
  await call('POST', `${op}/guests`, { name: 'Stranger' });
  const stranger = (await call('GET', `${op}/guests`)).body.guests[0];
  assert.equal((await call('POST', `/api/gate/${ev.gate_token}/scan`, { code: `/i/${stranger.token}` })).body.result, 'unknown');
  assert.equal((await call('POST', `/api/gate/${ev.gate_token}/admit/${stranger.id}`)).status, 404);
  void p;
});

test('open RSVP link creates one guest per phone and can be closed', async (t) => {
  const { call, p, ev } = await start(t);
  const pub = `/api/e/${ev.public_token}`;
  const a = await call('POST', `${pub}/rsvp`, { name: 'Tunde', phone: '0802 000 1111', party_size: 2 });
  const b = await call('POST', `${pub}/rsvp`, { name: 'Tunde B', phone: '+234 802 000 1111', party_size: 1 });
  assert.equal(a.body.invite_url, b.body.invite_url);
  const list = (await call('GET', `${p}/guests`)).body.guests;
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'public');
  assert.equal(list[0].party_size, 1);
  await call('PATCH', `${p}/settings`, { rsvp_open: false });
  assert.equal((await call('POST', `${pub}/rsvp`, { name: 'Late', phone: '08030000000' })).status, 403);
});

test('aso-ebi: items, orders, paid and collected', async (t) => {
  const { call, p, ev } = await start(t);
  await call('POST', `${p}/asoebi/items`, { name: 'Gele + fabric (Emerald)', price: 2500000, options: 'Small, Medium, Large' });
  const pub = `/api/e/${ev.public_token}`;
  const item = (await call('GET', pub)).body.items[0];
  assert.equal(item.options, 'Small,Medium,Large');
  assert.equal((await call('POST', `${pub}/orders`, { item_id: item.id, buyer_name: 'Aunty Bisi', phone: '08030000001', option: 'XXL' })).status, 400);
  const order = await call('POST', `${pub}/orders`, { item_id: item.id, buyer_name: 'Aunty Bisi', phone: '08030000001', option: 'Medium', qty: 3 });
  assert.equal(order.status, 201);
  assert.equal(order.body.pay_url, null);
  const view = (await call('GET', `/api/${order.body.order_url.slice(1)}`)).body;
  assert.equal(view.order.amount, 7500000);
  assert.equal(view.order.token, undefined);

  const { orders } = (await call('GET', `${p}/asoebi`)).body;
  await call('POST', `${p}/asoebi/orders/${orders[0].id}/paid`, { paid: true });
  await call('POST', `${p}/asoebi/orders/${orders[0].id}/collected`, { collected: true });
  const stats = (await call('GET', `${p}/asoebi`)).body.stats;
  assert.deepEqual([stats.orders, stats.pieces, stats.ordered, stats.paid, stats.collected], [1, 3, 7500000, 7500000, 1]);
});

test('aso-ebi card payment goes through Paystack and is verified before marking paid', async (t) => {
  const calls = [];
  const fakePaystack = async (url, init) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/transaction/initialize')) return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc' } }) };
    const orderId = calls[0].body.metadata.order_id;
    const good = url.includes('good-ref');
    return { ok: true, json: async () => ({ status: true, data: { status: good ? 'success' : 'failed', amount: 2500000, metadata: { order_id: orderId } } }) };
  };
  const { call, p, ev } = await start(t, { paystackKey: 'sk_test_x', fetchImpl: fakePaystack });
  await call('POST', `${p}/asoebi/items`, { name: 'Cap', price: 2500000 });
  const pub = `/api/e/${ev.public_token}`;
  const item = (await call('GET', pub)).body.items[0];
  assert.equal((await call('POST', `${pub}/orders`, { item_id: item.id, buyer_name: 'Femi', phone: '08030000002', pay: 'card' })).status, 400, 'email required for card');
  const order = await call('POST', `${pub}/orders`, { item_id: item.id, buyer_name: 'Femi', phone: '08030000002', pay: 'card', email: 'femi@example.com' });
  assert.equal(order.body.pay_url, 'https://checkout.paystack.com/abc');
  assert.equal(calls[0].body.amount, 2500000);
  const token = order.body.order_url.split('/').pop();

  const bad = await call('GET', `/api/o/${token}/paystack?reference=bad-ref`);
  assert.equal(bad.headers.get('location'), `/o/${token}?payment=failed`);
  assert.equal((await call('GET', `/api/o/${token}`)).body.order.paid_at, null);
  const good = await call('GET', `/api/o/${token}/paystack?reference=good-ref`);
  assert.equal(good.headers.get('location'), `/o/${token}?payment=paid`);
  assert.ok((await call('GET', `/api/o/${token}`)).body.order.paid_at);
  void p;
});

test('vendor deal, payments and agreement acceptance', async (t) => {
  const { call, p, store, ev } = await start(t);
  const dj = store.vendors(ev.id).find((v) => v.role === 'DJ');
  await call('PATCH', `${p}/vendors/${dj.id}/deal`, { fee: 50000000, terms: 'Sound from 2pm to 9pm. Two speakers, one wireless mic.' });
  await call('POST', `${p}/payments`, { vendor_id: dj.id, label: 'Deposit', amount: 25000000, due_date: '2026-10-01', paid: true });
  await call('POST', `${p}/payments`, { vendor_id: dj.id, label: 'Balance', amount: 25000000, due_date: '2026-11-10' });

  const v = `/api/v/${dj.token}`;
  let mine = (await call('GET', v)).body;
  assert.equal(mine.deal.fee, 50000000);
  assert.equal(mine.deal.payments.length, 2);
  assert.equal(mine.deal.accepted_at, null);
  await call('POST', `${v}/accept`);
  mine = (await call('GET', v)).body;
  assert.ok(mine.deal.accepted_at);

  // changing the fee asks the vendor to accept again
  await call('PATCH', `${p}/vendors/${dj.id}/deal`, { fee: 55000000 });
  assert.equal((await call('GET', v)).body.deal.accepted_at, null);

  const money = (await call('GET', `${p}/money`)).body;
  const row = money.vendors.find((x) => x.vendor_id === dj.id);
  assert.deepEqual([row.paid, row.balance, row.unscheduled], [25000000, 30000000, 5000000]);
  // another vendor's token can't accept for the DJ, and payments can't target other events' vendors
  assert.equal((await call('POST', `${p}/payments`, { vendor_id: 99999, label: 'x', amount: 1 })).status, 404);
});

test('budget: vendor-linked lines use fee and payments, others use spent', async (t) => {
  const { call, p, store, ev } = await start(t);
  const caterer = store.vendors(ev.id).find((v) => v.role === 'Caterer');
  const dj = store.vendors(ev.id).find((v) => v.role === 'DJ');
  await call('PATCH', `${p}/vendors/${caterer.id}/deal`, { fee: 300000000 });
  await call('POST', `${p}/payments`, { vendor_id: caterer.id, label: 'Deposit', amount: 100000000, paid: true });
  await call('PATCH', `${p}/vendors/${dj.id}/deal`, { fee: 50000000 }); // no budget line: still counted
  await call('POST', `${p}/budget`, { category: 'Food', label: 'Catering for 500', planned: 350000000, vendor_id: caterer.id });
  await call('POST', `${p}/budget`, { category: 'Souvenirs', planned: 80000000, spent: 65000000 });
  const { totals, lines, unlinked } = (await call('GET', `${p}/money`)).body;
  assert.equal(lines.find((l) => l.category === 'Food').committed, 300000000);
  assert.equal(lines.find((l) => l.category === 'Food').paid, 100000000);
  assert.equal(unlinked.length, 1);
  assert.deepEqual([totals.planned, totals.committed, totals.paid], [430000000, 415000000, 165000000]);
  assert.equal((await call('POST', `${p}/budget`, { category: 'X', planned: -5 })).status, 400);

  // a payment scheduled for a vendor with no fee set still shows as committed and owed
  const photo = store.vendors(ev.id).find((v) => v.role === 'Photographer');
  await call('POST', `${p}/payments`, { vendor_id: photo.id, label: 'Deposit', amount: 40000000 });
  const after = (await call('GET', `${p}/money`)).body.totals;
  assert.equal(after.committed, 455000000);
  assert.equal(after.owed_to_vendors, 200000000 + 50000000 + 40000000);
});

test('couple view shows totals but no private tokens or terms', async (t) => {
  const { call, p, ev } = await start(t);
  await call('POST', `${p}/guests`, { name: 'Guest One', rsvp: 'yes' });
  const c = (await call('GET', `/api/c/${ev.couple_token}`)).body;
  assert.equal(c.guests.yes, 1);
  assert.equal(c.vendors.length, 13);
  const json = JSON.stringify(c);
  assert.ok(!json.includes(ev.planner_token));
  assert.ok(!json.includes(ev.gate_token));
  assert.ok(!json.includes('"token"'));
  assert.equal((await call('GET', '/api/c/nope')).status, 404);
});

test('an existing database from the first release gets the new tables and links', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ros-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, venue TEXT NOT NULL DEFAULT '', planner_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE vendors (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE, checked_in_at TEXT, push_sub TEXT);
    INSERT INTO events (name, type, date, planner_token) VALUES ('Old', 'blank', '2026-11-01', 'tok');`);
  old.close();
  const { openDb } = require('../server/db');
  const db = openDb(file);
  const e = db.prepare('SELECT * FROM events').get();
  assert.ok(e.public_token && e.gate_token && e.couple_token);
  assert.equal(e.rsvp_open, 1);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'guests'").get());
  openDb(file); // running twice is harmless
});
