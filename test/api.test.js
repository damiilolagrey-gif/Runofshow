const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../server/app');

async function start(opts = {}) {
  const ctx = createApp({ vapid: null, whatsapp: null, ...opts });
  await new Promise((r) => ctx.server.listen(0, r));
  const base = `http://localhost:${ctx.server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await call('POST', '/api/account/signup', { name: 'Tolu Events', email: `p${Math.random()}@example.com`, password: 'longenough' });
  return { ...ctx, base, call, close: () => { ctx.io.close(); ctx.server.close(); } };
}

async function wedding(t) {
  const s = await start();
  t.after(s.close);
  const { body } = await s.call('POST', '/api/events', { name: 'Ade & Tolu', type: 'ng-wedding', date: '2026-11-14' });
  const p = body.planner_url.replace('/p/', '/api/p/');
  const view = (await s.call('GET', p)).body;
  const byRole = Object.fromEntries(view.vendors.map((v) => [v.role, v]));
  const cue = (title) => view.cues.find((c) => c.title === title);
  return { s, p, view, byRole, cue };
}

test('creating from the wedding template sets up 13 vendors and their cues', async (t) => {
  const { view, byRole, cue } = await wedding(t);
  assert.equal(view.vendors.length, 13);
  assert.equal(view.cues.length, 16);
  assert.ok(cue('First dance').vendor_ids.includes(byRole.DJ.id));
});

test('a vendor only sees their own cues', async (t) => {
  const { s, view, byRole } = await wedding(t);
  const dj = (await s.call('GET', `/api/v/${byRole.DJ.token}`)).body;
  const expected = view.cues.filter((c) => c.vendor_ids.includes(byRole.DJ.id)).map((c) => c.title);
  assert.deepEqual(dj.cues.map((c) => c.title), expected);
  assert.equal(dj.event.planner_token, undefined);
  assert.equal(dj.vendor.token, undefined);
});

test('shifting moves this cue and later unfinished cues, and tells each owner once', async (t) => {
  const { s, p, byRole, cue } = await wedding(t);
  const entrance = cue('Grand entrance of the couple');
  await s.call('POST', `/api/p/${'x'}/cues/1/shift`, { minutes: 40 }).then((r) => assert.equal(r.status, 404));
  await s.call('POST', `${p}/cues/${cue('Cake cutting and toast').id}/done`, { done: true });
  const r = await s.call('POST', `${p}/cues/${entrance.id}/shift`, { minutes: 40 });
  assert.equal(r.status, 200);
  const after = (await s.call('GET', p)).body;
  const find = (title) => after.cues.find((c) => c.title === title);
  assert.equal(find('Grand entrance of the couple').start_min, entrance.start_min + 40);
  assert.equal(find('First dance').start_min, cue('First dance').start_min + 40);
  assert.equal(find('Cake cutting and toast').start_min, cue('Cake cutting and toast').start_min, 'done cues stay put');
  assert.equal(find('MC opens the reception').start_min, cue('MC opens the reception').start_min, 'earlier cues stay put');

  const notes = after.activity.filter((a) => a.kind === 'notify');
  const djNotes = notes.filter((a) => a.vendor_id === byRole.DJ.id);
  assert.equal(djNotes.length, 1);
  assert.match(djNotes[0].message, /Timeline moved 40 min later\. Your cues now: .*First dance 5:55pm/);
  assert.equal(notes.some((a) => a.vendor_id === byRole.Makeup.id), false, 'makeup has no moved cues');
});

test('moving one cue sends "moved to" to its owners', async (t) => {
  const { s, p, byRole, cue } = await wedding(t);
  await s.call('PATCH', `${p}/cues/${cue('First dance').id}`, { start_min: 20 * 60 + 10 });
  const dj = (await s.call('GET', `/api/v/${byRole.DJ.token}`)).body;
  assert.equal(dj.notices[0].message, 'Ade & Tolu: "First dance" moved to 8:10pm (was 5:15pm).');
});

test('vendors check in and can only mark their own cues done', async (t) => {
  const { s, p, byRole, cue } = await wedding(t);
  const dj = `/api/v/${byRole.DJ.token}`;
  assert.equal((await s.call('POST', `${dj}/checkin`)).status, 200);
  assert.equal((await s.call('POST', `${dj}/cues/${cue('Sound check').id}/done`, { done: true })).status, 200);
  assert.equal((await s.call('POST', `${dj}/cues/${cue('Food service').id}/done`, { done: true })).status, 403);
  const after = (await s.call('GET', p)).body;
  assert.ok(after.vendors.find((v) => v.id === byRole.DJ.id).checked_in_at);
  assert.ok(after.cues.find((c) => c.title === 'Sound check').done_at);
  assert.equal(after.cues.find((c) => c.title === 'Sound check').done_by, byRole.DJ.id);
});

test('planner and vendor sockets receive live state', async (t) => {
  const { s, p, byRole, cue } = await wedding(t);
  const plannerToken = p.split('/').pop();
  const connect = (auth) => new Promise((resolve) => {
    const c = ioClient(s.base, { auth, transports: ['websocket'] });
    t.after(() => c.close());
    c.once('state', () => resolve(c));
  });
  const planner = await connect({ planner: plannerToken });
  const dj = await connect({ vendor: byRole.DJ.token });
  const gotNotice = new Promise((r) => dj.once('notice', r));
  const plannerSaw = new Promise((r) => planner.on('state', (st) => st.cues.find((c) => c.title === 'First dance').start_min === 1210 && r()));
  await s.call('PATCH', `${p}/cues/${cue('First dance').id}`, { start_min: 1210 });
  assert.match(await gotNotice, /First dance" moved to 8:10pm/);
  await plannerSaw;
});

test('WhatsApp goes out through the Cloud API when configured', async (t) => {
  const sent = [];
  const s = await start({ whatsapp: { token: 'tkn', phoneNumberId: '123' }, fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true }; } });
  t.after(s.close);
  const { body } = await s.call('POST', '/api/events', { name: 'Gala', type: 'blank', date: '2026-11-14' });
  const p = body.planner_url.replace('/p/', '/api/p/');
  const v = (await s.call('POST', `${p}/vendors`, { name: 'DJ Spinall', role: 'DJ', phone: '0803 123 4567' })).body;
  await s.call('POST', `${p}/cues`, { title: 'Walk-in music', start_min: 1080, vendor_ids: [v.id] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://graph.facebook.com/v21.0/123/messages');
  assert.equal(sent[0].body.to, '2348031234567');
  assert.match(sent[0].body.text.body, /New cue for you: "Walk-in music" at 6:00pm/);
});

test('bad input is rejected with a clear message', async (t) => {
  const { s, p } = await wedding(t);
  assert.equal((await s.call('POST', '/api/events', { name: 'x', type: 'nope', date: '2026-01-01' })).status, 400);
  assert.equal((await s.call('POST', `${p}/cues`, { title: 'x', start_min: 'abc' })).status, 400);
  assert.equal((await s.call('POST', `${p}/cues/99999/shift`, { minutes: 10 })).status, 404);
});
