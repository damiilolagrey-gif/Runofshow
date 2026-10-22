const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');

async function start(t) {
  const ctx = createApp({ vapid: null, whatsapp: null, paystackKey: null });
  await new Promise((r) => ctx.server.listen(0, r));
  t.after(() => { ctx.io.close(); ctx.server.close(); });
  const base = `http://localhost:${ctx.server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  await call('POST', '/api/account/signup', { name: 'Tolu Events', email: `p${Math.random()}@example.com`, password: 'longenough', phone: '08031112222' });
  const event = async (date, name = 'Ade & Tolu') => {
    const { body } = await call('POST', '/api/events', { name, type: 'ng-wedding', date });
    const ev = ctx.store.event(body.id);
    return { ev, p: `/api/p/${ev.planner_token}`, c: `/api/c/${ev.couple_token}`, vendor: (role) => ctx.store.vendors(ev.id).find((v) => v.role === role) };
  };
  return { ...ctx, call, event };
}

const past = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

test('progress checklist: starter items, manual locks, vendor acceptance and the couple view', async (t) => {
  const { call, event } = await start(t);
  const { p, c, vendor } = await event(future);

  let prog = (await call('GET', `${p}/progress`)).body;
  assert.equal(prog.summary.total, 22);
  assert.equal(prog.summary.locked, 0);
  assert.equal(prog.note.contact_phone, '2348031112222'); // from the planner's account

  const venue = prog.items.find((i) => i.title === 'Reception venue booked');
  await call('PATCH', `${p}/progress/${venue.id}`, { locked: true });

  // The DJ item is linked to the DJ and locks itself once the DJ accepts their agreement.
  const dj = vendor('DJ');
  const djItem = prog.items.find((i) => i.title === 'DJ booked');
  assert.equal(djItem.vendor_id, dj.id);
  await call('PATCH', `${p}/vendors/${dj.id}/deal`, { fee: 50000000, terms: 'Sound all day' });
  await call('POST', `/api/v/${dj.token}/accept`);

  await call('POST', `${p}/progress`, { category: 'Transport & extras', title: 'Hotel rooms for family', locked: true });
  await call('PATCH', `${p}/progress/note`, { couple_names: 'Ade & Tolu', couple_note: 'Cake quote is in progress.', contact_phone: '0809 000 1111' });

  prog = (await call('GET', `${p}/progress`)).body;
  assert.equal(prog.summary.total, 23);
  assert.equal(prog.summary.locked, 3);
  assert.equal(prog.items.find((i) => i.id === djItem.id).auto, true);

  const couple = (await call('GET', c)).body;
  assert.equal(couple.progress.percent, 13);
  assert.equal(couple.progress.couple_names, 'Ade & Tolu');
  assert.equal(couple.progress.note, 'Cake quote is in progress.');
  assert.deepEqual(couple.planner, { name: 'Tolu Events', phone: '2348090001111' });
  const music = couple.progress.categories.find((x) => x.name === 'Photo, video & music');
  assert.deepEqual([music.locked, music.total], [1, 5]);

  // Unticking a manual lock works; removing an item drops it from the count.
  await call('PATCH', `${p}/progress/${venue.id}`, { locked: false });
  await call('DELETE', `${p}/progress/${djItem.id}`);
  assert.equal((await call('GET', c)).body.progress.locked, 1);

  // Starter checklist can be added again to an event that has none.
  assert.equal((await call('POST', `${p}/progress/starter`)).body.added, 22);
});

test('reviews open on the event day, and only the couple can write one', async (t) => {
  const { call, event } = await start(t);
  const soon = await event(future);
  const dj = soon.vendor('DJ');
  assert.equal((await call('POST', `/api/v/${dj.token}/review-request`)).status, 400);
  assert.equal((await call('POST', `${soon.c}/reviews`, { vendor_id: dj.id, rating: 5 })).status, 400);
  assert.equal((await call('GET', `/api/v/${dj.token}`)).body.reviews.open, false);
  assert.equal((await call('GET', soon.c)).body.reviews_open, false);
});

test('vendor asks, couple reviews, vendor shares a verified card and profile', async (t) => {
  const { call, event, store } = await start(t);
  const done = await event(past);
  const dj = done.vendor('DJ');
  await call('PATCH', `${done.p}/vendors/${dj.id}`, { phone: '08055554444' });

  assert.equal((await call('POST', `/api/v/${dj.token}/review-request`)).status, 200);
  let couple = (await call('GET', done.c)).body;
  assert.equal(couple.reviews_open, true);
  assert.equal(couple.vendors.find((v) => v.id === dj.id).review_requested, true);

  assert.equal((await call('POST', `${done.c}/reviews`, { vendor_id: dj.id, rating: 6 })).status, 400);
  const other = await event(past, 'Another wedding');
  assert.equal((await call('POST', `${done.c}/reviews`, { vendor_id: other.vendor('DJ').id, rating: 5 })).status, 404);

  await call('POST', `${done.c}/reviews`, { vendor_id: dj.id, rating: 4, body: 'Great <b>vibes</b>', reviewer: 'Ade & Tolu' });
  await call('POST', `${done.c}/reviews`, { vendor_id: dj.id, rating: 5, body: 'Kept the floor full <b>all night</b>', reviewer: 'Ade & Tolu' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 1); // an edit, not a second review

  couple = (await call('GET', done.c)).body;
  assert.equal(couple.vendors.find((v) => v.id === dj.id).review.rating, 5);
  const planner = (await call('GET', done.p)).body;
  assert.equal(planner.vendors.find((v) => v.id === dj.id).rating, 5);

  const mine = (await call('GET', `/api/v/${dj.token}`)).body;
  assert.equal(mine.reviews.review.rating, 5);
  assert.match(mine.reviews.review.url, /^\/review\/[\w-]+$/);
  assert.match(mine.reviews.profile_url, /^\/pro\/[0-9a-f]{12}$/);

  const card = await call('GET', mine.reviews.review.url);
  assert.equal(card.status, 200);
  assert.match(card.body, /<meta property="og:title" content="★★★★★ for DJ"/);
  assert.match(card.body, /Verified review/);
  assert.match(card.body, /&lt;b&gt;all night&lt;\/b&gt;/);
  assert.doesNotMatch(card.body, /<b>all night/);
  assert.doesNotMatch(card.body, /Ade &amp; Tolu&#39;s|Another wedding/); // shows the reviewer's sign-off, not the event name

  // The same phone on another event adds to one profile.
  const odj = other.vendor('DJ');
  await call('PATCH', `${other.p}/vendors/${odj.id}`, { phone: '+234 805 555 4444' });
  await call('POST', `${other.c}/reviews`, { vendor_id: odj.id, rating: 4, reviewer: 'Kemi & Femi' });
  const profile = await call('GET', mine.reviews.profile_url);
  assert.match(profile.body, /4\.5/);
  assert.match(profile.body, /from 2 verified reviews/);
  assert.match(profile.body, /Kemi &amp; Femi/);

  assert.equal((await call('GET', '/pro/000000000000')).status, 404);
  assert.equal((await call('GET', '/review/nope')).status, 404);
});

test('vendor links never carry the couple, gate or planner links', async (t) => {
  const { call, event } = await start(t);
  const { vendor } = await event(future);
  const view = (await call('GET', `/api/v/${vendor('DJ').token}`)).body;
  for (const key of ['planner_token', 'couple_token', 'gate_token', 'public_token', 'couple_note', 'contact_phone']) assert.equal(view.event[key], undefined, key);
});
