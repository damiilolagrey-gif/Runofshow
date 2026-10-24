const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { PlanAssistant, normalize } = require('../server/planai');

const AI_PLAN = {
  summary: 'Church in the morning, owambe reception from 2pm.',
  budget_total_naira: 15000000,
  guest_count: 300,
  vendors: [{ name: 'Caterer', role: 'Caterer' }, { name: 'DJ Spinall', role: 'DJ' }, { name: 'MC', role: 'MC' }, { name: 'dup', role: 'dj' }],
  cues: [
    { time: '14:00', duration_min: 60, title: 'Guests arrive, small chops', roles: ['Caterer', 'Juggler'] },
    { time: '10:00', duration_min: 90, title: 'Church service', roles: [] },
    { time: '25:00', duration_min: 10, title: 'Bad time', roles: ['DJ'] },
    { time: '15:30', duration_min: 9999, title: 'Grand entrance', roles: ['MC', 'dj'] },
  ],
  checklist: [{ category: 'Food & drink', title: 'Caterer booked', role: 'Caterer' }, { category: 'Music', title: 'DJ booked', role: 'DJ' }, { category: '', title: 'x', role: '' }],
  budget: [{ category: 'Food & drinks', naira: 4500000, role: 'Caterer' }, { category: 'Venue', naira: 3000000, role: '' }, { category: 'Contingency', naira: 750000, role: '' }],
  guest_info: 'Colours: emerald and gold.',
};

test('normalize keeps only well-formed, bounded pieces of a draft', () => {
  const p = normalize(AI_PLAN);
  assert.deepEqual(p.vendors.map((v) => v.role), ['Caterer', 'DJ', 'MC']);
  assert.deepEqual(p.cues.map((c) => c.title), ['Church service', 'Guests arrive, small chops', 'Grand entrance']); // sorted, bad time dropped
  assert.deepEqual(p.cues[1].roles, ['Caterer']); // unknown role dropped
  assert.deepEqual(p.cues[2].roles, ['MC', 'DJ']); // role names matched case-insensitively
  assert.equal(p.cues[2].duration, 480);
  assert.equal(p.checklist.length, 2);
  // the reviewed draft round-trips through the browser unchanged
  assert.deepEqual(normalize(p).cues, p.cues);
});

async function start(t, planner) {
  const ctx = createApp({ vapid: null, whatsapp: null, paystackKey: null, tickEvery: 0, planner });
  await new Promise((r) => ctx.server.listen(0, r));
  t.after(() => { ctx.io.close(); ctx.server.close(); });
  const base = `http://localhost:${ctx.server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return { ...ctx, call, signup: () => call('POST', '/api/account/signup', { name: 'Tolu Events', email: `p${Math.random()}@example.com`, password: 'longenough' }) };
}

const input = { name: 'Ade & Tolu', type: 'ng-wedding', date: '2026-12-12', venue: 'Eko Hotel', brief: '300 guests, ₦15m budget, emerald and gold' };

test('without an API key the draft comes from the template with a budget split', async (t) => {
  const { call, signup } = await start(t, new PlanAssistant({ apiKey: '' }));
  assert.equal((await call('POST', '/api/events/draft', input)).status, 401);
  await signup();
  assert.equal((await call('GET', '/api/events/draft')).body.ai, false);
  assert.equal((await call('POST', '/api/events/draft', { ...input, brief: ' ' })).status, 400);
  const d = (await call('POST', '/api/events/draft', input)).body;
  assert.equal(d.source, 'template');
  assert.equal(d.vendors.length, 13);
  assert.equal(d.guest_count, 300);
  assert.equal(d.budget.reduce((s, l) => s + l.naira, 0), 15000000);
  assert.equal(d.budget.find((l) => l.category === 'Food & drinks').role, 'Caterer');
});

test('an AI draft becomes the event: vendors, timeline, checklist, budget and guest info', async (t) => {
  const asked = [];
  const client = { beta: { messages: { stream: (req) => {
    asked.push(req);
    return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(AI_PLAN) }] }) };
  } } } };
  const { call, signup, store, finance, progress } = await start(t, new PlanAssistant({ client }));
  await signup();
  const d = (await call('POST', '/api/events/draft', input)).body;
  assert.equal(d.source, 'ai');
  assert.equal(asked[0].model, 'claude-opus-5-5');
  assert.match(asked[0].messages[0].content, /<brief>\n300 guests, ₦15m budget, emerald and gold\n<\/brief>/);

  const created = (await call('POST', '/api/events', { ...input, plan: d })).body;
  const ev = store.event(created.id);
  assert.equal(ev.type, 'ng-wedding');
  assert.equal(ev.guest_info, 'Colours: emerald and gold.');
  const vendors = store.vendors(ev.id);
  assert.deepEqual(vendors.map((v) => v.name), ['Caterer', 'DJ Spinall', 'MC']);
  const cues = store.cues(ev.id);
  assert.deepEqual(cues.map((c) => c.title), ['Church service', 'Guests arrive, small chops', 'Grand entrance']);
  assert.deepEqual(cues[2].vendor_ids.sort(), [vendors[1].id, vendors[2].id].sort());
  const items = progress.items(ev.id);
  assert.equal(items.length, 2);
  assert.equal(items[0].vendor_id, vendors[0].id);
  const money = finance.summary(ev.id);
  assert.equal(money.totals.planned, (4500000 + 3000000 + 750000) * 100);
  assert.equal(money.lines.find((l) => l.category === 'Food & drinks').vendor_id, vendors[0].id);

  // if Claude fails, the planner still gets a template draft
  client.beta.messages.stream = () => ({ finalMessage: async () => { throw new Error('timeout'); } });
  assert.equal((await call('POST', '/api/events/draft', input)).body.source, 'template');
});
