const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../server/app');
const { Assistant } = require('../server/assistant');
const { localNow } = require('../server/guestcomms');

const SECRET = 'app-secret';

async function start(t, { whatsapp = true, assistant = new Assistant({ apiKey: '' }), date = '2026-11-14' } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://graph.facebook.com/')) sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  const ctx = createApp({
    vapid: null, paystackKey: null, tickEvery: 0, assistant, fetchImpl, baseUrl: 'https://ros.example',
    whatsapp: whatsapp ? { token: 'tkn', phoneNumberId: '555', appSecret: SECRET, verifyToken: 'verify-me' } : null,
  });
  await new Promise((r) => ctx.server.listen(0, r));
  t.after(() => { ctx.io.close(); ctx.server.close(); });
  const base = `http://localhost:${ctx.server.address().port}`;
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const raw = typeof body === 'string' ? body : body && JSON.stringify(body);
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: raw, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  await call('POST', '/api/account/signup', { name: 'Tolu Events', email: `p${Math.random()}@example.com`, password: 'longenough' });
  const { body } = await call('POST', '/api/events', { name: 'Ade & Tolu', type: 'ng-wedding', date, venue: 'Eko Hotel' });
  const ev = ctx.store.event(body.id);
  const webhook = (payload) => {
    const raw = JSON.stringify(payload);
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
    return call('POST', '/api/whatsapp/webhook', raw, { 'x-hub-signature-256': sig });
  };
  const textFrom = (from, text, id = crypto.randomUUID()) => ({ entry: [{ changes: [{ value: { messages: [{ id, from, type: 'text', text: { body: text } }] } }] }] });
  return { ...ctx, call, ev, sent, webhook, textFrom, p: `/api/p/${ev.planner_token}`, c: `/api/c/${ev.couple_token}` };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test('the couple runs the guest list and aso-ebi from their own page', async (t) => {
  const { call, p, c } = await start(t);
  assert.equal((await call('POST', `${c}/guests/import`, { text: 'Chief Adeyemi, 08031234567, 2, Bride\nMrs Okafor, 08099998888, 1, Groom' })).body.added, 2);
  await call('POST', `${c}/asoebi/items`, { name: 'Gele', price: 2500000 });
  await call('PATCH', `${c}/guest-settings`, { guest_info: 'Dress code: emerald and gold', rsvp_open: false });

  const planner = (await call('GET', `${p}/guests`)).body;
  assert.equal(planner.guests.length, 2); // same list the planner sees
  assert.equal((await call('GET', `${p}/asoebi`)).body.items[0].name, 'Gele');
  const couple = (await call('GET', c)).body;
  assert.equal(couple.event.guest_info, 'Dress code: emerald and gold');
  assert.equal(couple.event.rsvp_open, 0);
  // the guest's invite shows the hosts' information
  assert.equal((await call('GET', `/api/i/${planner.guests[0].token}`)).body.event.guest_info, 'Dress code: emerald and gold');
  assert.equal((await call('GET', '/api/c/nope/guests')).status, 404);
});

test('table plan: tables, seating, auto-seat by side, renames and vendor access', async (t) => {
  const { call, p, c, store, ev } = await start(t);
  await call('POST', `${c}/guests/import`, { text: [
    'Chief Adeyemi, 08031234567, 4, Bride', 'Mrs Okafor, 08099998888, 2, Groom', 'Uncle Femi, , 3, Bride',
    'Aunty Kemi, , 2, Groom', 'Not Coming, , 1, Bride',
  ].join('\n') });
  const list = (await call('GET', `${c}/guests`)).body.guests;
  const id = (name) => list.find((g) => g.name === name).id;
  for (const n of ['Chief Adeyemi', 'Mrs Okafor', 'Uncle Femi', 'Aunty Kemi']) await call('PATCH', `${c}/guests/${id(n)}`, { rsvp: 'yes' });
  await call('PATCH', `${c}/guests/${id('Not Coming')}`, { rsvp: 'no' });

  assert.equal((await call('POST', `${c}/tables`, { count: 2, seats: 6 })).body.added, 2);
  await call('POST', `${p}/tables`, { label: 'VIP', seats: 4 });
  assert.equal((await call('POST', `${p}/tables`, { label: 'VIP' })).status, 400);
  await call('POST', `${c}/tables/seat`, { guest_id: id('Chief Adeyemi'), table_label: 'VIP' });

  const auto = (await call('POST', `${c}/tables/auto`)).body;
  assert.deepEqual(auto, { seated: 3, left: 0 });
  let plan = (await call('GET', `${p}/tables`)).body;
  const tableOf = (n) => plan.guests.find((g) => g.name === n).table_label;
  assert.equal(tableOf('Chief Adeyemi'), 'VIP');
  assert.equal(tableOf('Mrs Okafor'), tableOf('Aunty Kemi')); // the groom's side sits together
  assert.notEqual(tableOf('Uncle Femi'), tableOf('Mrs Okafor'));
  assert.equal(plan.stats.coming_people, 11);
  assert.equal(plan.stats.seated_people, 11);
  assert.equal(plan.guests.some((g) => g.name === 'Not Coming'), false);

  // renaming a table moves its guests; deleting one sends them back to "need a seat"
  const vip = plan.tables.find((t2) => t2.label === 'VIP');
  await call('PATCH', `${c}/tables/${vip.id}`, { label: 'Top table' });
  plan = (await call('GET', `${c}/tables`)).body;
  assert.equal(tableOf('Chief Adeyemi'), 'Top table');
  await call('DELETE', `${c}/tables/${vip.id}`);
  plan = (await call('GET', `${c}/tables`)).body;
  assert.equal(tableOf('Chief Adeyemi'), '');

  // vendors only once the planner allows it, and without phone numbers or invite links
  const usher = store.vendors(ev.id).find((v) => v.role === 'Ushers');
  assert.equal((await call('GET', `/api/v/${usher.token}/tables`)).status, 403);
  await call('PATCH', `${p}/vendors/${usher.id}`, { can_seat: true });
  const seen = (await call('GET', `/api/v/${usher.token}/tables`)).body;
  assert.equal(seen.guests.length, 4);
  const json = JSON.stringify(seen);
  assert.ok(!json.includes('2348031234567') && !json.includes('"token"') && !json.includes('"code"'));
  await call('POST', `/api/v/${usher.token}/tables/seat`, { guest_id: id('Chief Adeyemi'), table_label: '1' });
  assert.equal(store.db.prepare('SELECT table_label FROM guests WHERE id = ?').get(id('Chief Adeyemi')).table_label, '1');
  assert.equal((await call('GET', '/api/v/nope/tables')).status, 404);
});

test('WhatsApp RSVP bot: signed webhook, RSVP from a reply, party cap, retries and strangers', async (t) => {
  const { call, c, webhook, textFrom, sent, store } = await start(t, { date: localNow().date });
  await call('POST', `${c}/guests`, { name: 'Chief Adeyemi', phone: '08031234567', party_size: 2 });

  // Meta's one-time verification, and unsigned posts are refused
  assert.equal((await call('GET', '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42')).body, '42');
  assert.equal((await call('GET', '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status, 403);
  assert.equal((await call('POST', '/api/whatsapp/webhook', JSON.stringify(textFrom('2348031234567', 'yes')))).status, 401);

  const msg = textFrom('2348031234567', 'Yes o, we go come. 3 of us', 'wamid.1');
  assert.equal((await webhook(msg)).status, 200);
  await settle();
  let g = (await call('GET', `${c}/guests`)).body.guests[0];
  assert.equal(g.rsvp, 'yes');
  assert.equal(g.party_size, 2); // the invite admits 2
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '2348031234567');
  assert.match(sent[0].text.body, /admits 2 people, so I've confirmed 2/);

  await webhook(msg); // Meta retried the same message
  await settle();
  assert.equal(sent.length, 1);

  await webhook(textFrom('2348031234567', "Sorry, I can't make it again"));
  await settle();
  g = (await call('GET', `${c}/guests`)).body.guests[0];
  assert.equal(g.rsvp, 'no');
  const convo = (await call('GET', `${c}/guests/${g.id}/messages`)).body;
  assert.deepEqual(convo.map((m) => m.direction), ['in', 'out', 'in', 'out']);
  assert.equal((await call('GET', `${c}/invites`)).body.replies.length, 2);

  await webhook(textFrom('2348000000000', 'hello'));
  await settle();
  assert.match(sent.at(-1).text.body, /couldn't find your invitation/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM wa_inbound').get().n, 3);
});

test('the AI assistant answers questions from the hosts\' information', async (t) => {
  const asked = [];
  const client = { beta: { messages: { create: async (req) => {
    asked.push(req);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ intent: 'question', party_size: 0, reply: 'Dress code is emerald and gold.' }) }] };
  } } } };
  const { call, c, webhook, textFrom, sent } = await start(t, { assistant: new Assistant({ client }), date: localNow().date });
  await call('POST', `${c}/guests`, { name: 'Mrs Okafor', phone: '08099998888' });
  await call('PATCH', `${c}/guest-settings`, { guest_info: 'Dress code: emerald and gold' });
  await webhook(textFrom('2348099998888', 'What colour should I wear?'));
  await settle();
  assert.equal(sent.at(-1).text.body, 'Dress code is emerald and gold.');
  assert.equal(asked[0].model, 'claude-opus-5-5');
  assert.equal(asked[0].output_config.format.type, 'json_schema');
  assert.match(asked[0].messages[0].content, /Dress code: emerald and gold/);
  assert.match(asked[0].messages[0].content, /<guest_message>\nWhat colour should I wear\?\n<\/guest_message>/);
  assert.equal((await call('GET', `${c}/guests`)).body.guests[0].rsvp, 'pending');

  // if Claude fails, the keyword reader still RSVPs the guest
  client.beta.messages.create = async () => { throw new Error('network down'); };
  await webhook(textFrom('2348099998888', 'Yes I will be there'));
  await settle();
  assert.equal((await call('GET', `${c}/guests`)).body.guests[0].rsvp, 'yes');
});

test('invites go out once by WhatsApp, or are marked sent by hand without it', async (t) => {
  const { call, c, sent } = await start(t);
  await call('POST', `${c}/guests/import`, { text: 'Chief Adeyemi, 08031234567\nNo Phone\nMrs Okafor, 08099998888' });
  const r = (await call('POST', `${c}/invites/send`)).body;
  assert.equal(r.sent, 2);
  assert.match(sent[0].text.body, /you're invited to Ade & Tolu on Saturday 14 November at Eko Hotel\. Reply YES or NO here/);
  assert.match(sent[0].text.body, /https:\/\/ros\.example\/i\//);
  assert.equal((await call('POST', `${c}/invites/send`)).body.sent, 0); // already invited
  assert.equal((await call('POST', `${c}/invites/send`, { resend: true })).body.sent, 2);
});

test('without WhatsApp, invites and passes are sent by hand', async (t) => {
  const { call, c } = await start(t, { whatsapp: false });
  await call('POST', `${c}/guests`, { name: 'Chief Adeyemi', phone: '08031234567', rsvp: 'yes' });
  assert.deepEqual((await call('POST', `${c}/invites/send`)).body, { sent: 0, manual: true });
  const passes = (await call('GET', `${c}/passes`)).body;
  assert.equal(passes.whatsapp, false);
  assert.match(passes.guests[0].text, /An usher will show you to your seat/);
  await call('POST', `${c}/passes/${passes.guests[0].id}/sent`);
  assert.ok((await call('GET', `${c}/passes`)).body.guests[0].pass_sent_at);
});

test('passes with table number and QR link go out on the event morning, once', async (t) => {
  const { call, c, sent, comms, ev, store } = await start(t, { date: '2026-11-14' });
  await call('POST', `${c}/guests/import`, { text: 'Chief Adeyemi, 08031234567, 2\nMrs Okafor, 08099998888, 1\nAunty Kemi, 08055556666, 1' });
  const list = (await call('GET', `${c}/guests`)).body.guests;
  for (const g of list.filter((x) => x.name !== 'Aunty Kemi')) await call('PATCH', `${c}/guests/${g.id}`, { rsvp: 'yes' });
  await call('POST', `${c}/tables`, { label: '12', seats: 10 });
  await call('POST', `${c}/tables/seat`, { guest_id: list.find((g) => g.name === 'Chief Adeyemi').id, table_label: '12' });
  await call('PATCH', `${c}/guest-settings`, { passes_time: '08:30' });
  assert.equal((await call('PATCH', `${c}/guest-settings`, { passes_time: '25:00' })).status, 400);

  // Lagos is UTC+1: 07:00Z is 08:00 there (too early), 07:45Z is 08:45 (time to send)
  assert.equal(await comms.tick(new Date('2026-11-13T09:00:00Z')), 0);
  assert.equal(await comms.tick(new Date('2026-11-14T07:00:00Z')), 0);
  assert.equal(await comms.tick(new Date('2026-11-14T07:45:00Z')), 1);
  assert.equal(sent.length, 2); // only guests who said yes
  const chief = sent.find((m) => m.to === '2348031234567').text.body;
  assert.match(chief, /today is Ade & Tolu! Your table is 12\. Show the QR code at this link at the gate \(admits 2\)/);
  assert.match(chief, /https:\/\/ros\.example\/i\/[\w-]+/);
  assert.equal(await comms.tick(new Date('2026-11-14T08:00:00Z')), 0); // not again
  assert.ok(store.event(ev.id).passes_sent_at);

  // a guest who says yes later can still get theirs from the button
  await call('PATCH', `${c}/guests/${list.find((g) => g.name === 'Aunty Kemi').id}`, { rsvp: 'yes' });
  assert.equal((await call('POST', `${c}/passes/send`)).body.sent, 1);
});
