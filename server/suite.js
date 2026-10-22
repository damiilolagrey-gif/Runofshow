// Guests and gate, aso-ebi, vendor payments, budget, and the couple's view.
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { HttpError } = require('./store');

const PUBLIC = path.join(__dirname, '..', 'public');

function mountSuite(app, { store, guests, asoebi, finance, paystack, io, broadcast }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC, file));
  const num = (req, key = 'id') => Number(req.params[key]);
  const origin = (req) => `${req.protocol}://${req.get('host')}`;

  // Tell every screen watching this event which part changed; they refetch what they show.
  const changed = (eventId, topic) => {
    for (const room of [`planner:${eventId}`, `couple:${eventId}`, `gate:${eventId}`]) io.to(room).emit('changed', topic);
  };

  for (const section of ['guests', 'asoebi', 'money']) app.get(`/p/:token/${section}`, page(`${section}.html`));
  app.get('/i/:token', page('invite.html'));
  app.get('/e/:token', page('event.html'));
  app.get('/o/:token', page('order.html'));
  app.get('/gate/:token', page('gate.html'));
  app.get('/c/:token', page('couple.html'));
  app.get('/vendor/jsqr.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));

  const publicEvent = (e) => ({ name: e.name, date: e.date, venue: e.venue, type: e.type });

  // ---------- planner ----------

  const p = express.Router({ mergeParams: true });
  p.use((req, _res, next) => {
    req.ev = store.eventByPlannerToken(req.params.token);
    next(req.ev ? undefined : new HttpError(404, 'Event not found'));
  });

  p.patch('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const e = req.ev;
    if (b.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw new HttpError(400, 'Date must look like 2026-11-14');
    store.db.prepare('UPDATE events SET name = ?, venue = ?, date = ?, rsvp_open = ?, pay_details = ? WHERE id = ?').run(
      String(b.name ?? e.name).trim().slice(0, 120) || e.name, String(b.venue ?? e.venue).slice(0, 200), b.date ?? e.date,
      b.rsvp_open === undefined ? e.rsvp_open : (b.rsvp_open ? 1 : 0), String(b.pay_details ?? e.pay_details).slice(0, 1000), e.id,
    );
    res.json({ ok: true });
    changed(e.id, 'settings');
    await broadcast(e.id);
  }));

  // guests
  p.get('/guests', (req, res) => res.json({ guests: guests.list(req.ev.id), stats: guests.stats(req.ev.id) }));
  p.post('/guests', (req, res) => {
    const g = guests.add(req.ev.id, req.body || {});
    res.status(201).json({ id: g.id });
    changed(req.ev.id, 'guests');
  });
  p.post('/guests/import', (req, res) => {
    const added = guests.import(req.ev.id, req.body?.text);
    store.log(req.ev.id, 'change', `Imported ${added} guests`);
    res.status(201).json({ added });
    changed(req.ev.id, 'guests');
  });
  p.patch('/guests/:id', (req, res) => {
    guests.update(req.ev.id, num(req), req.body || {});
    res.json({ ok: true });
    changed(req.ev.id, 'guests');
  });
  p.delete('/guests/:id', (req, res) => {
    guests.remove(req.ev.id, num(req));
    res.json({ ok: true });
    changed(req.ev.id, 'guests');
  });
  p.post('/guests/:id/arrived', (req, res) => {
    if (req.body?.arrived === false) guests.undoAdmit(req.ev.id, num(req));
    else guests.admit(guests.in(req.ev.id, num(req)));
    res.json({ ok: true });
    changed(req.ev.id, 'guests');
  });

  // aso-ebi
  p.get('/asoebi', (req, res) => res.json({ items: asoebi.items(req.ev.id), orders: asoebi.orders(req.ev.id), stats: asoebi.stats(req.ev.id), paystack: Boolean(paystack) }));
  p.post('/asoebi/items', (req, res) => {
    res.status(201).json({ id: asoebi.addItem(req.ev.id, req.body || {}) });
    changed(req.ev.id, 'asoebi');
  });
  p.patch('/asoebi/items/:id', (req, res) => {
    asoebi.updateItem(req.ev.id, num(req), req.body || {});
    res.json({ ok: true });
    changed(req.ev.id, 'asoebi');
  });
  p.post('/asoebi/orders/:id/paid', (req, res) => {
    asoebi.setPaid(asoebi.orderIn(req.ev.id, num(req)), Boolean(req.body?.paid));
    res.json({ ok: true });
    changed(req.ev.id, 'asoebi');
  });
  p.post('/asoebi/orders/:id/collected', (req, res) => {
    asoebi.setCollected(asoebi.orderIn(req.ev.id, num(req)), Boolean(req.body?.collected));
    res.json({ ok: true });
    changed(req.ev.id, 'asoebi');
  });
  p.delete('/asoebi/orders/:id', (req, res) => {
    asoebi.removeOrder(req.ev.id, num(req));
    res.json({ ok: true });
    changed(req.ev.id, 'asoebi');
  });

  // vendor deals, payments, budget
  p.get('/money', (req, res) => res.json(finance.summary(req.ev.id)));
  const moneyChanged = async (eventId) => {
    changed(eventId, 'money');
    await broadcast(eventId); // vendor pages show their own payments
  };
  p.patch('/vendors/:id/deal', wrap(async (req, res) => {
    finance.setVendorDeal(req.ev.id, num(req), req.body || {});
    res.json({ ok: true });
    await moneyChanged(req.ev.id);
  }));
  p.post('/payments', wrap(async (req, res) => {
    finance.addPayment(req.ev.id, req.body || {});
    res.status(201).json({ ok: true });
    await moneyChanged(req.ev.id);
  }));
  p.patch('/payments/:id', wrap(async (req, res) => {
    const { before, after } = finance.updatePayment(req.ev.id, num(req), req.body || {});
    if (!before.paid_at && after.paid_at) {
      const v = store.vendor(after.vendor_id);
      store.log(req.ev.id, 'change', `Paid ${v.name}: ${after.label}`);
    }
    res.json({ ok: true });
    await moneyChanged(req.ev.id);
  }));
  p.delete('/payments/:id', wrap(async (req, res) => {
    finance.removePayment(req.ev.id, num(req));
    res.json({ ok: true });
    await moneyChanged(req.ev.id);
  }));
  p.post('/budget', (req, res) => {
    finance.addLine(req.ev.id, req.body || {});
    res.status(201).json({ ok: true });
    changed(req.ev.id, 'money');
  });
  p.patch('/budget/:id', (req, res) => {
    finance.updateLine(req.ev.id, num(req), req.body || {});
    res.json({ ok: true });
    changed(req.ev.id, 'money');
  });
  p.delete('/budget/:id', (req, res) => {
    finance.removeLine(req.ev.id, num(req));
    res.json({ ok: true });
    changed(req.ev.id, 'money');
  });
  app.use('/api/p/:token', p);

  // ---------- guest invite ----------

  const invite = express.Router({ mergeParams: true });
  invite.use((req, _res, next) => {
    req.guest = guests.byToken(req.params.token);
    next(req.guest ? undefined : new HttpError(404, 'Invite not found'));
  });
  invite.get('/', (req, res) => {
    const { token: _t, ...g } = req.guest;
    res.json({ event: publicEvent(store.event(g.event_id)), guest: g });
  });
  invite.post('/rsvp', (req, res) => {
    guests.rsvp(req.guest, req.body || {});
    res.json({ ok: true });
    changed(req.guest.event_id, 'guests');
  });
  invite.get('/qr.svg', wrap(async (req, res) => {
    const svg = await QRCode.toString(`${origin(req)}/i/${req.guest.token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'private, max-age=86400').send(svg);
  }));
  app.use('/api/i/:token', invite);

  // ---------- public event page: open RSVP and aso-ebi shop ----------

  const pub = express.Router({ mergeParams: true });
  pub.use((req, _res, next) => {
    req.ev = store.db.prepare('SELECT * FROM events WHERE public_token = ?').get(req.params.token);
    next(req.ev ? undefined : new HttpError(404, 'Event not found'));
  });
  pub.get('/', (req, res) => res.json({
    event: publicEvent(req.ev), rsvp_open: Boolean(req.ev.rsvp_open), pay_details: req.ev.pay_details,
    items: asoebi.items(req.ev.id, { activeOnly: true }), paystack: Boolean(paystack),
  }));
  pub.post('/rsvp', (req, res) => {
    const g = guests.publicRsvp(req.ev, req.body || {});
    res.status(201).json({ invite_url: `/i/${g.token}` });
    changed(req.ev.id, 'guests');
  });
  pub.post('/orders', wrap(async (req, res) => {
    const order = asoebi.placeOrder(req.ev, req.body || {});
    changed(req.ev.id, 'asoebi');
    let pay_url = null;
    if (paystack && req.body?.pay === 'card') {
      if (!/^\S+@\S+\.\S+$/.test(req.body.email || '')) throw new HttpError(400, 'Enter your email to pay by card');
      pay_url = await paystack.checkout(order, { email: req.body.email, callbackUrl: `${origin(req)}/api/o/${order.token}/paystack` });
    }
    res.status(201).json({ order_url: `/o/${order.token}`, pay_url });
  }));
  app.use('/api/e/:token', pub);

  // ---------- an aso-ebi buyer's order ----------

  app.get('/api/o/:token', (req, res, next) => {
    const o = asoebi.orderByToken(req.params.token);
    if (!o) return next(new HttpError(404, 'Order not found'));
    const ev = store.event(o.event_id);
    const { token: _t, event_id: _e, ...order } = o;
    res.json({ event: publicEvent(ev), order, pay_details: ev.pay_details, paystack: Boolean(paystack) });
  });
  app.post('/api/o/:token/pay', wrap(async (req, res) => {
    const o = asoebi.orderByToken(req.params.token);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!paystack) throw new HttpError(400, 'Card payment is not available for this event');
    if (o.paid_at) throw new HttpError(400, 'This order is already paid');
    if (!/^\S+@\S+\.\S+$/.test(req.body?.email || '')) throw new HttpError(400, 'Enter your email to pay by card');
    res.json({ pay_url: await paystack.checkout(o, { email: req.body.email, callbackUrl: `${origin(req)}/api/o/${o.token}/paystack` }) });
  }));
  app.get('/api/o/:token/paystack', wrap(async (req, res) => {
    const o = asoebi.orderByToken(req.params.token);
    if (!o) throw new HttpError(404, 'Order not found');
    let status = 'failed';
    if (paystack && req.query.reference && await paystack.verify(String(req.query.reference), o).catch(() => false)) {
      asoebi.setPaid(o, true, String(req.query.reference));
      changed(o.event_id, 'asoebi');
      status = 'paid';
    }
    res.redirect(`/o/${o.token}?payment=${status}`);
  }));

  // ---------- usher gate ----------

  const gate = express.Router({ mergeParams: true });
  gate.use((req, _res, next) => {
    req.ev = store.db.prepare('SELECT * FROM events WHERE gate_token = ?').get(req.params.token);
    next(req.ev ? undefined : new HttpError(404, 'Gate link not found'));
  });
  const gateGuest = ({ id, name, party_size, side, table_label, rsvp, arrived_at, code }) => ({ id, name, party_size, side, table_label, rsvp, arrived_at, code });
  gate.get('/', (req, res) => res.json({ event: publicEvent(req.ev), stats: guests.stats(req.ev.id) }));
  gate.get('/search', (req, res) => res.json(guests.search(req.ev.id, req.query.q).map(gateGuest)));
  gate.post('/scan', (req, res) => {
    const g = guests.find(req.ev.id, req.body?.code);
    if (!g) return res.json({ result: 'unknown' });
    const { guest, already } = guests.admit(g);
    if (!already) changed(req.ev.id, 'guests');
    res.json({ result: already ? 'already' : 'admitted', guest: gateGuest(guest) });
  });
  gate.post('/admit/:id', (req, res) => {
    const { guest, already } = guests.admit(guests.in(req.ev.id, num(req)));
    if (!already) changed(req.ev.id, 'guests');
    res.json({ result: already ? 'already' : 'admitted', guest: gateGuest(guest) });
  });
  app.use('/api/gate/:token', gate);

  // ---------- couple ----------

  app.get('/api/c/:token', (req, res, next) => {
    const ev = store.db.prepare('SELECT * FROM events WHERE couple_token = ?').get(req.params.token);
    if (!ev) return next(new HttpError(404, 'Link not found'));
    const money = finance.summary(ev.id);
    res.json({
      event: { ...publicEvent(ev), public_token: ev.public_token },
      cues: store.cues(ev.id).map(({ title, start_min, duration, done_at }) => ({ title, start_min, duration, done_at })),
      vendors: store.vendors(ev.id).map(({ name, role, checked_in_at }) => ({ name, role, checked_in_at })),
      guests: guests.stats(ev.id),
      asoebi: asoebi.stats(ev.id),
      money: { totals: money.totals, lines: money.lines, unlinked: money.unlinked, upcoming: money.upcoming,
        vendors: money.vendors.map(({ terms: _t, ...v }) => v) },
    });
  });
}

module.exports = { mountSuite };
