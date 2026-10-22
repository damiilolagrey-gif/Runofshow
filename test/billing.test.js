const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../server/app');

const KEY = 'sk_test_secret';

// A stand-in for api.paystack.co that records calls and answers from `txs` (reference -> transaction).
function fakePaystack() {
  const calls = [];
  const txs = {};
  let n = 0;
  const reply = (data) => ({ ok: true, json: async () => ({ status: true, data }) });
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    const path = url.replace('https://api.paystack.co', '');
    if (path === '/plan') return reply({ plan_code: `PLN_${body.name.includes('Pro') ? 'pro' : 'biz'}_${body.interval}` });
    if (path === '/transaction/initialize') return reply({ authorization_url: `https://checkout.paystack.com/${++n}` });
    if (path.startsWith('/transaction/verify/')) {
      const tx = txs[decodeURIComponent(path.split('/').pop())];
      return tx ? reply(tx) : { ok: false, json: async () => ({ status: false, message: 'not found' }) };
    }
    if (path.startsWith('/bank/resolve')) return reply({ account_name: 'TOLU ADEBAYO EVENTS' });
    if (path.startsWith('/bank')) return reply([{ code: '058', name: 'Guaranty Trust Bank' }]);
    if (path === '/subaccount') return reply({ subaccount_code: 'ACCT_new' });
    if (path.startsWith('/subscription/SUB_')) return reply({ email_token: 'tok123' });
    if (path === '/subscription/disable') return reply({});
    throw new Error(`unexpected ${path}`);
  };
  return { impl, calls, txs, lastInit: () => calls.filter((c) => c.url.endsWith('/transaction/initialize')).at(-1).body };
}

async function start(t, opts = {}) {
  const ps = fakePaystack();
  const ctx = createApp({ vapid: null, whatsapp: null, paystackKey: KEY, fetchImpl: ps.impl, ...opts });
  await new Promise((r) => ctx.server.listen(0, r));
  t.after(() => { ctx.io.close(); ctx.server.close(); });
  const base = `http://localhost:${ctx.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: typeof body === 'string' ? body : body && JSON.stringify(body), redirect: 'manual' });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
    };
  };
  return { ...ctx, ps, base, client };
}

const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const signup = (call, email = `p${Math.random()}@example.com`) => call('POST', '/api/account/signup', { name: 'Tolu Events', email, password: 'correct horse' });

test('sign up, log in, log out', async (t) => {
  const { client } = await start(t);
  const a = client();
  assert.equal((await a('POST', '/api/account/signup', { name: 'X', email: 'bad', password: 'correct horse' })).status, 400);
  assert.equal((await a('POST', '/api/account/signup', { name: 'X', email: 'x@example.com', password: 'short' })).status, 400);
  assert.equal((await signup(a, 'Tolu@Example.com')).status, 201);
  assert.equal((await a('GET', '/api/account/me')).body.planner.email, 'tolu@example.com');
  assert.equal((await signup(client(), 'tolu@example.com')).status, 409);

  const b = client();
  assert.equal((await b('GET', '/api/account/me')).status, 401);
  assert.equal((await b('POST', '/api/account/login', { email: 'tolu@example.com', password: 'wrong password' })).status, 401);
  assert.equal((await b('POST', '/api/account/login', { email: 'TOLU@example.com', password: 'correct horse' })).status, 200);
  assert.equal((await b('GET', '/api/account/me')).status, 200);
  await b('POST', '/api/account/logout');
  assert.equal((await b('GET', '/api/account/me')).status, 401);
});

test('logins are throttled after repeated failures', async (t) => {
  const { client } = await start(t);
  await signup(client(), 'slow@example.com');
  const c = client();
  for (let i = 0; i < 10; i++) await c('POST', '/api/account/login', { email: 'slow@example.com', password: 'nope nope' });
  assert.equal((await c('POST', '/api/account/login', { email: 'slow@example.com', password: 'correct horse' })).status, 429);
});

test('creating an event needs an account, and the free plan allows one upcoming event', async (t) => {
  const { client } = await start(t);
  const anon = client();
  assert.equal((await anon('POST', '/api/events', { name: 'X', type: 'blank', date: future(30) })).status, 401);
  const c = client();
  await signup(c);
  assert.equal((await c('POST', '/api/events', { name: 'First', type: 'blank', date: future(30) })).status, 201);
  const second = await c('POST', '/api/events', { name: 'Second', type: 'blank', date: future(40) });
  assert.equal(second.status, 402);
  assert.match(second.body.error, /Starter plan allows 1 upcoming event/);
  assert.equal((await c('POST', '/api/events', { name: 'Last year', type: 'blank', date: '2025-01-01' })).status, 201, 'past events do not use a slot');
  const me = (await c('GET', '/api/account/me')).body;
  assert.equal(me.events.length, 2);
  assert.equal(me.active_events, 1);
});

test('limits are not enforced when payments are not configured', async (t) => {
  const { client } = await start(t, { paystackKey: null });
  const c = client();
  await signup(c);
  assert.equal((await c('POST', '/api/events', { name: 'A', type: 'blank', date: future(30) })).status, 201);
  assert.equal((await c('POST', '/api/events', { name: 'B', type: 'blank', date: future(31) })).status, 201);
});

test('free plan caps guests at 150 per event, across import, add and open RSVP', async (t) => {
  const { client, store } = await start(t);
  const c = client();
  await signup(c);
  const { planner_url } = (await c('POST', '/api/events', { name: 'W', type: 'blank', date: future(30) })).body;
  const p = planner_url.replace('/p/', '/api/p/');
  const lines = (n, from = 0) => Array.from({ length: n }, (_, i) => `Guest ${from + i}, 0803${String(1000000 + from + i)}`).join('\n');
  assert.equal((await c('POST', `${p}/guests/import`, { text: lines(149) })).status, 201);
  assert.equal((await c('POST', `${p}/guests/import`, { text: lines(2, 149) })).status, 402);
  assert.equal((await c('POST', `${p}/guests`, { name: 'One more' })).status, 201);
  assert.equal((await c('POST', `${p}/guests`, { name: 'Too many' })).status, 402);
  const ev = store.eventByPlannerToken(planner_url.split('/').pop());
  const pub = `/api/e/${ev.public_token}/rsvp`;
  assert.equal((await client()('POST', pub, { name: 'New', phone: '09012345678' })).status, 402);
  assert.equal((await client()('POST', pub, { name: 'Guest 3', phone: '08031000003' })).status, 201, 'an existing guest can still answer');
});

test('subscribing to Pro: Paystack checkout, verified callback, applied once', async (t) => {
  const { client, ps, accounts } = await start(t);
  const c = client();
  await signup(c);
  const me0 = (await c('GET', '/api/account/me')).body;
  const sub = await c('POST', '/api/account/subscribe', { plan: 'pro', interval: 'monthly' });
  assert.match(sub.body.pay_url, /^https:\/\/checkout\.paystack\.com\//);
  const init = ps.lastInit();
  assert.equal(init.plan, 'PLN_pro_monthly');
  assert.equal(init.amount, 1500000);
  assert.equal(init.email, me0.planner.email);

  // a forged or underpaid reference changes nothing
  ps.txs.cheap = { status: 'success', reference: 'cheap', amount: 100, metadata: init.metadata, customer: { customer_code: 'CUS_1' } };
  assert.equal((await c('GET', '/api/billing/callback?reference=cheap')).headers.get('location'), '/dashboard?billing=failed');
  assert.equal((await c('GET', '/api/billing/callback?reference=unknown')).headers.get('location'), '/dashboard?billing=failed');
  assert.equal((await c('GET', '/api/account/me')).body.plan, 'starter');

  ps.txs.good = { status: 'success', reference: 'good', amount: 1500000, metadata: init.metadata, customer: { customer_code: 'CUS_1', email: me0.planner.email } };
  assert.equal((await c('GET', '/api/billing/callback?reference=good')).headers.get('location'), '/dashboard?billing=ok');
  const me1 = (await c('GET', '/api/account/me')).body;
  assert.equal(me1.plan, 'pro');
  assert.equal(me1.limits.events, 5);
  assert.equal(me1.limits.guests, null);
  const days = (Date.parse(me1.plan_until) - Date.now()) / 864e5;
  assert.ok(days > 31 && days < 33, `about 32 days, got ${days}`);

  await c('GET', '/api/billing/callback?reference=good'); // the browser can hit the callback twice
  assert.equal((await c('GET', '/api/account/me')).body.plan_until, me1.plan_until);

  // plan codes are created once and reused
  await c('POST', '/api/account/subscribe', { plan: 'pro', interval: 'monthly' });
  assert.equal(ps.calls.filter((x) => x.url.endsWith('/plan')).length, 1);
  assert.equal(accounts.setting('paystack_plan:pro:monthly:1500000'), 'PLN_pro_monthly');
  assert.equal((await c('POST', '/api/account/subscribe', { plan: 'gold' })).status, 400);
});

test('webhook: checks the signature, renews from the plan code, tracks the subscription', async (t) => {
  const { client, ps, base } = await start(t);
  const c = client();
  await signup(c, 'renew@example.com');
  await c('POST', '/api/account/subscribe', { plan: 'business', interval: 'annually' });
  const init = ps.lastInit();
  ps.txs.first = { status: 'success', reference: 'first', amount: 40000000, metadata: init.metadata, customer: { customer_code: 'CUS_9', email: 'renew@example.com' } };
  await c('GET', '/api/billing/callback?reference=first');
  const before = (await c('GET', '/api/account/me')).body.plan_until;

  const hook = async (payload, sign = true) => {
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha512', sign ? KEY : 'wrong').update(raw).digest('hex');
    return (await fetch(`${base}/api/paystack/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body: raw })).status;
  };
  assert.equal(await hook({ event: 'subscription.create', data: { subscription_code: 'SUB_1', customer: { customer_code: 'CUS_9' } } }, false), 401);
  assert.equal(await hook({ event: 'subscription.create', data: { subscription_code: 'SUB_1', customer: { customer_code: 'CUS_9' } } }), 200);
  assert.equal((await c('GET', '/api/account/me')).body.renewing, true);

  // a renewal charge carries no metadata, only the Paystack plan
  ps.txs.renew1 = { status: 'success', reference: 'renew1', amount: 40000000, metadata: {}, plan: { plan_code: 'PLN_biz_annually' }, customer: { customer_code: 'CUS_9', email: 'renew@example.com' } };
  assert.equal(await hook({ event: 'charge.success', data: { reference: 'renew1' } }), 200);
  const after = (await c('GET', '/api/account/me')).body;
  assert.equal(after.plan, 'business');
  assert.ok(Date.parse(after.plan_until) - Date.parse(before) > 360 * 864e5);

  // an aso-ebi card payment confirmed only by webhook still marks the order paid
  const { planner_url } = (await c('POST', '/api/events', { name: 'W', type: 'blank', date: future(30) })).body;
  const p = planner_url.replace('/p/', '/api/p/');
  await c('POST', `${p}/asoebi/items`, { name: 'Cap', price: 500000 });
  const ev = (await c('GET', p)).body.event;
  const item = (await c('GET', `${p}/asoebi`)).body.items[0];
  await client()('POST', `/api/e/${ev.public_token}/orders`, { item_id: item.id, buyer_name: 'Bisi', phone: '08030000009' });
  const order = (await c('GET', `${p}/asoebi`)).body.orders[0];
  ps.txs.aso = { status: 'success', reference: 'aso', amount: 500000, metadata: { kind: 'asoebi', order_id: order.id } };
  assert.equal(await hook({ event: 'charge.success', data: { reference: 'aso' } }), 200);
  assert.ok((await c('GET', `${p}/asoebi`)).body.orders[0].paid_at);

  assert.equal((await c('POST', '/api/account/cancel')).status, 200);
  assert.ok(ps.calls.some((x) => x.url.endsWith('/subscription/disable') && x.body.token === 'tok123'));
  const cancelled = (await c('GET', '/api/account/me')).body;
  assert.equal(cancelled.renewing, false);
  assert.equal(cancelled.plan, 'business', 'stays on the plan until the paid period ends');
});

test('unlocking one event lifts its guest cap and frees the plan slot', async (t) => {
  const { client, ps } = await start(t);
  const c = client();
  await signup(c);
  await c('POST', '/api/events', { name: 'Big one', type: 'blank', date: future(20) });
  const ev = (await c('GET', '/api/account/me')).body.events[0];
  await c('POST', '/api/account/unlock-event', { event_id: ev.id });
  const init = ps.lastInit();
  assert.equal(init.amount, 2000000);
  ps.txs.ev = { status: 'success', reference: 'ev', amount: 2000000, metadata: init.metadata, customer: {} };
  await c('GET', '/api/billing/callback?reference=ev');
  const me = (await c('GET', '/api/account/me')).body;
  assert.equal(me.events[0].unlocked, true);
  assert.equal(me.active_events, 0);
  const p = ev.planner_url.replace('/p/', '/api/p/');
  const lines = Array.from({ length: 200 }, (_, i) => `G${i}`).join('\n');
  assert.equal((await c('POST', `${p}/guests/import`, { text: lines })).status, 201);
  assert.equal((await c('POST', '/api/events', { name: 'Next', type: 'blank', date: future(50) })).status, 201);

  // another planner can't unlock someone else's event
  const other = client();
  await signup(other);
  assert.equal((await other('POST', '/api/account/unlock-event', { event_id: ev.id })).status, 404);
});

test('claiming an event made before accounts existed', async (t) => {
  const { client, store } = await start(t);
  const old = store.createEvent({ name: 'Legacy', type: 'blank', date: future(10) });
  const c = client();
  await signup(c);
  assert.equal((await c('POST', '/api/account/claim', { link: `https://runofshow.onrender.com/p/${old.planner_token}/guests` })).status, 200);
  assert.equal((await c('GET', '/api/account/me')).body.events[0].name, 'Legacy');
  const d = client();
  await signup(d);
  assert.equal((await d('POST', '/api/account/claim', { link: old.planner_token })).status, 409);
  assert.equal((await d('POST', '/api/account/claim', { link: 'nope' })).status, 404);
});

test('payout account: resolves the name and creates a subaccount with the platform fee', async (t) => {
  const { client, ps } = await start(t);
  const c = client();
  await signup(c);
  assert.equal((await c('POST', '/api/account/payout', { bank_code: '058', account_number: '123' })).status, 400);
  await c('GET', '/api/account/banks');
  const r = await c('POST', '/api/account/payout', { bank_code: '058', account_number: '0123456789' });
  assert.equal(r.body.name, 'TOLU ADEBAYO EVENTS');
  const created = ps.calls.find((x) => x.url.endsWith('/subaccount'));
  assert.equal(created.body.percentage_charge, 1.5);
  const me = (await c('GET', '/api/account/me')).body;
  assert.deepEqual(me.payout, { bank: 'Guaranty Trust Bank', account: '••••••6789', name: 'TOLU ADEBAYO EVENTS' });
});
