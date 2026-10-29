const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { openDb } = require('../server/db');

async function start(t, opts = {}) {
  const momentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-moments-test-'));
  const ctx = createApp({ vapid: null, whatsapp: null, paystackKey: null, tickEvery: 0, aiClient: null, momentsDir, ...opts });
  await new Promise((r) => ctx.server.listen(0, r));
  t.after(() => { ctx.io.close(); ctx.server.close(); fs.rmSync(momentsDir, { recursive: true, force: true }); });
  const base = `http://localhost:${ctx.server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  await call('POST', '/api/account/signup', { name: 'Tolu Events', email: `p${Math.random()}@example.com`, password: 'longenough' });
  const { body } = await call('POST', '/api/events', { name: 'Ade & Tolu', type: 'ng-wedding', date: '2026-12-12', venue: '', plan: { vendors: [], cues: [], checklist: [], budget: [] } });
  const ev = ctx.store.event(body.id);
  const upload = (token, bytes, type = 'image/jpeg', name = 'Bisi Ade') => fetch(`${base}/api/m/${token}/upload`, {
    method: 'POST', headers: { 'Content-Type': type, 'X-Guest-Name': encodeURIComponent(name) }, body: bytes,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { ...ctx, base, call, ev, upload, momentsDir, p: `/api/p/${ev.planner_token}`, c: `/api/c/${ev.couple_token}` };
}

test('guests upload by QR link, hosts see the album, and hidden ones leave the wall', async (t) => {
  const { call, upload, base, p, c, ev, momentsDir } = await start(t);
  const links = (await call('GET', `${p}/moments`)).body;
  assert.match(links.upload_url, /\/m\/[\w-]+$/);
  assert.match(links.wall_url, /\/wall\/[\w-]+$/);
  assert.equal(links.open, true);
  const mt = links.upload_url.split('/').pop();
  const wt = links.wall_url.split('/').pop();

  const guestPage = (await call('GET', `/api/m/${mt}`)).body;
  assert.equal(guestPage.event.name, 'Ade & Tolu');
  assert.equal(guestPage.open, true);
  assert.equal(guestPage.event.planner_token, undefined);

  const photo = await upload(mt, Buffer.from('fake-jpeg-bytes'), 'image/jpeg', 'Bisi Adé');
  assert.equal(photo.status, 201);
  assert.equal(photo.body.kind, 'photo');
  const video = await upload(mt, Buffer.alloc(2048, 1), 'video/mp4', 'Kunle');
  assert.equal(video.status, 201);
  assert.equal(video.body.kind, 'video');

  // The couple sees the same album as the planner.
  const album = (await call('GET', `${c}/moments`)).body;
  assert.equal(album.items.length, 2);
  assert.deepEqual({ photos: album.stats.photos, videos: album.stats.videos, guests: album.stats.guests }, { photos: 1, videos: 1, guests: 2 });
  assert.equal(album.items.find((m) => m.kind === 'photo').guest_name, 'Bisi Adé');
  const file = await fetch(`${base}${p}/moments/${photo.body.id}/file`);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.equal(await file.text(), 'fake-jpeg-bytes');
  const dl = await fetch(`${base}${p}/moments/${photo.body.id}/file?download=1`);
  assert.match(dl.headers.get('content-disposition'), /attachment/);

  // The wall shows both until the hosts hide one.
  assert.equal((await call('GET', `/api/wall/${wt}`)).body.items.length, 2);
  assert.equal((await call('PATCH', `${p}/moments/${video.body.id}`, { hidden: true })).status, 200);
  const wall = (await call('GET', `/api/wall/${wt}`)).body;
  assert.deepEqual(wall.items.map((m) => m.id), [photo.body.id]);
  assert.equal(wall.items[0].file, undefined);
  assert.equal((await fetch(`${base}/api/wall/${wt}/file/${video.body.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/wall/${wt}/file/${photo.body.id}`)).status, 200);
  assert.match((await call('GET', `/api/wall/${wt}/qr.svg`)).body, /<svg/);

  // Deleting removes the file from disk too.
  assert.equal((await call('DELETE', `${p}/moments/${photo.body.id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readdirSync(path.join(momentsDir, String(ev.id))).length, 1);
  assert.equal((await call('GET', `${p}/moments`)).body.items.length, 1);
});

test('uploads refuse the wrong type, files over the limit, a full album and closed uploads', async (t) => {
  const { call, upload, p } = await start(t, { momentsLimits: { photoMax: 100, videoMax: 400, eventMax: 600 } });
  const mt = (await call('GET', `${p}/moments`)).body.upload_url.split('/').pop();

  assert.equal((await upload(mt, Buffer.from('<html>'), 'text/html')).status, 415);
  const big = await upload(mt, Buffer.alloc(101, 1), 'image/png');
  assert.equal(big.status, 413);
  assert.match(big.body.error, /too big/);
  assert.equal((await upload(mt, Buffer.alloc(0), 'image/png')).status, 400);
  assert.equal((await upload(mt, Buffer.alloc(350, 1), 'video/webm')).status, 201);
  assert.equal((await upload(mt, Buffer.alloc(90, 1), 'image/webp')).status, 201);
  assert.equal((await upload(mt, Buffer.alloc(300, 1), 'video/mp4')).status, 507);
  assert.equal((await call('GET', `${p}/moments`)).body.items.length, 2);

  assert.equal((await call('PATCH', `${p}/moments-settings`, { open: false })).status, 200);
  assert.equal((await call('GET', `/api/m/${mt}`)).body.open, false);
  assert.equal((await upload(mt, Buffer.alloc(10, 1), 'image/jpeg')).status, 403);
});

test('moment links are private to their event', async (t) => {
  const { call, upload, p } = await start(t);
  assert.equal((await call('GET', '/api/m/not-a-token')).status, 404);
  assert.equal((await call('GET', '/api/wall/not-a-token')).status, 404);
  const { upload_url: u, wall_url: w } = (await call('GET', `${p}/moments`)).body;
  const mt = u.split('/').pop();
  const wt = w.split('/').pop();
  // The upload link can't read the album or the wall.
  const m = await upload(mt, Buffer.from('x'), 'image/jpeg');
  assert.equal((await call('GET', `/api/wall/${mt}`)).status, 404);
  assert.equal((await call('GET', `/api/m/${mt}/file/${m.body.id}`)).status, 404);
  // The wall link can't upload.
  assert.equal((await upload(wt, Buffer.from('x'), 'image/jpeg')).status, 404);
});

test('events made before photo sharing get their links on first use', async () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  assert.ok(cols.includes('moments_token') && cols.includes('wall_token') && cols.includes('moments_open'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'moments'").get());
});
