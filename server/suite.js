// Guests and gate, aso-ebi, vendor payments, budget, and the couple's view.
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { HttpError, normalizePhone } = require('./store');

const PUBLIC = path.join(__dirname, '..', 'public');

function mountSuite(app, { store, guests, asoebi, finance, paystack, accounts, progress, reviews, seating, comms, assistant, io, broadcast }) {
  // Card payment for aso-ebi needs the event's planner to have a payout account, so the money reaches them.
  const payoutFor = (ev) => {
    const owner = ev.planner_id && accounts.get(ev.planner_id);
    return paystack && owner?.subaccount_code ? owner.subaccount_code : null;
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC, file));
  const num = (req, key = 'id') => Number(req.params[key]);
  const origin = (req) => `${req.protocol}://${req.get('host')}`;

  // Tell every screen watching this event which part changed; they refetch what they show.
  const changed = (eventId, topic) => {
    for (const room of [`planner:${eventId}`, `couple:${eventId}`, `gate:${eventId}`, `seating:${eventId}`]) io.to(room).emit('changed', topic);
  };

  for (const section of ['guests', 'asoebi', 'money', 'progress', 'tables']) app.get(`/p/:token/${section}`, page(`${section}.html`));
  for (const section of ['guests', 'asoebi', 'tables']) app.get(`/c/:token/${section}`, page(`${section}.html`));
  app.get('/v/:token/tables', page('tables.html'));
  app.get('/i/:token', page('invite.html'));
  app.get('/e/:token', page('event.html'));
  app.get('/o/:token', page('order.html'));
  app.get('/gate/:token', page('gate.html'));
  app.get('/c/:token', page('couple.html'));
  app.get('/vendor/jsqr.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));

  const publicEvent = (e) => ({ name: e.name, date: e.date, venue: e.venue, type: e.type, guest_info: e.guest_info });

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

  // progress checklist the couple sees
  p.get('/progress', (req, res) => {
    const e = req.ev;
    res.json({ items: progress.items(e.id), summary: progress.summary(e.id), vendors: store.vendors(e.id).map(({ id, name, role, accepted_at }) => ({ id, name, role, accepted_at })),
      note: { couple_names: e.couple_names, couple_note: e.couple_note, contact_phone: e.contact_phone } });
  });
  p.post('/progress', (req, res) => {
    const id = progress.add(req.ev.id, req.body || {});
    res.status(201).json({ id });
    changed(req.ev.id, 'progress');
  });
  p.post('/progress/starter', (req, res) => {
    res.status(201).json({ added: progress.seed(req.ev.id, req.ev.type) });
    changed(req.ev.id, 'progress');
  });
  p.patch('/progress/note', (req, res) => {
    progress.setNote(req.ev, req.body || {});
    res.json({ ok: true });
    changed(req.ev.id, 'progress');
  });
  p.patch('/progress/:id', (req, res) => {
    progress.update(req.ev.id, num(req), req.body || {});
    res.json({ ok: true });
    changed(req.ev.id, 'progress');
  });
  p.delete('/progress/:id', (req, res) => {
    progress.remove(req.ev.id, num(req));
    res.json({ ok: true });
    changed(req.ev.id, 'progress');
  });

  // ---------- guests, aso-ebi and the table plan: the planner and the couple both run these ----------

  function ownerRoutes(r) {
    // guests
    r.get('/guests', (req, res) => res.json({ guests: guests.list(req.ev.id), stats: guests.stats(req.ev.id) }));
    r.post('/guests', (req, res) => {
      accounts.assertGuestRoom(req.ev);
      const g = guests.add(req.ev.id, req.body || {});
      res.status(201).json({ id: g.id });
      changed(req.ev.id, 'guests');
    });
    r.post('/guests/import', (req, res) => {
      accounts.assertGuestRoom(req.ev, String(req.body?.text || '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*name\s*[,\t]/i.test(l)).length);
      const added = guests.import(req.ev.id, req.body?.text);
      store.log(req.ev.id, 'change', `Imported ${added} guests`);
      res.status(201).json({ added });
      changed(req.ev.id, 'guests');
    });
    r.patch('/guests/:id', (req, res) => {
      guests.update(req.ev.id, num(req), req.body || {});
      res.json({ ok: true });
      changed(req.ev.id, 'guests');
    });
    r.delete('/guests/:id', (req, res) => {
      guests.remove(req.ev.id, num(req));
      res.json({ ok: true });
      changed(req.ev.id, 'guests');
    });
    r.post('/guests/:id/arrived', (req, res) => {
      if (req.body?.arrived === false) guests.undoAdmit(req.ev.id, num(req));
      else guests.admit(guests.in(req.ev.id, num(req)));
      res.json({ ok: true });
      changed(req.ev.id, 'guests');
    });

    // aso-ebi
    r.get('/asoebi', (req, res) => res.json({ items: asoebi.items(req.ev.id), orders: asoebi.orders(req.ev.id), stats: asoebi.stats(req.ev.id), paystack: Boolean(payoutFor(req.ev)), billing: Boolean(paystack) }));
    r.post('/asoebi/items', (req, res) => {
      res.status(201).json({ id: asoebi.addItem(req.ev.id, req.body || {}) });
      changed(req.ev.id, 'asoebi');
    });
    r.patch('/asoebi/items/:id', (req, res) => {
      asoebi.updateItem(req.ev.id, num(req), req.body || {});
      res.json({ ok: true });
      changed(req.ev.id, 'asoebi');
    });
    r.post('/asoebi/orders/:id/paid', (req, res) => {
      asoebi.setPaid(asoebi.orderIn(req.ev.id, num(req)), Boolean(req.body?.paid));
      res.json({ ok: true });
      changed(req.ev.id, 'asoebi');
    });
    r.post('/asoebi/orders/:id/collected', (req, res) => {
      asoebi.setCollected(asoebi.orderIn(req.ev.id, num(req)), Boolean(req.body?.collected));
      res.json({ ok: true });
      changed(req.ev.id, 'asoebi');
    });
    r.delete('/asoebi/orders/:id', (req, res) => {
      asoebi.removeOrder(req.ev.id, num(req));
      res.json({ ok: true });
      changed(req.ev.id, 'asoebi');
    });

    // table plan
    r.get('/tables', (req, res) => res.json(seating.plan(req.ev.id)));
    seatingRoutes(r);

    // invites and replies
    r.get('/invites', (req, res) => res.json({ guests: comms.inviteList(req.ev), replies: comms.replies(req.ev.id), whatsapp: Boolean(comms.whatsapp), ai: assistant.usesAI }));
    r.post('/invites/send', wrap(async (req, res) => res.json(await comms.sendInvites(req.ev, { resend: Boolean(req.body?.resend) }))));
    r.post('/invites/:id/sent', (req, res) => {
      comms.markInvited(req.ev.id, num(req));
      res.json({ ok: true });
      changed(req.ev.id, 'guests');
    });
    r.get('/guests/:id/messages', (req, res) => res.json(comms.messages(req.ev.id, guests.in(req.ev.id, num(req)).id)));

    // passes on the day: table number and QR link
    r.get('/passes', (req, res) => {
      const e = req.ev;
      res.json({ guests: comms.passList(e), whatsapp: Boolean(comms.whatsapp), auto: Boolean(e.passes_auto), time: e.passes_time, sent_at: e.passes_sent_at, date: e.date });
    });
    r.post('/passes/send', wrap(async (req, res) => res.json(await comms.sendPasses(req.ev, { resend: Boolean(req.body?.resend) }))));
    r.post('/passes/:id/sent', (req, res) => {
      comms.markPassSent(req.ev.id, num(req));
      res.json({ ok: true });
      changed(req.ev.id, 'guests');
    });

    // what guests see and the bot knows, plus RSVP and aso-ebi settings
    r.patch('/guest-settings', (req, res) => {
      const b = req.body || {};
      const e = req.ev;
      if (b.passes_time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.passes_time)) throw new HttpError(400, 'Time must look like 09:00');
      store.db.prepare('UPDATE events SET guest_info = ?, rsvp_open = ?, pay_details = ?, passes_auto = ?, passes_time = ? WHERE id = ?').run(
        String(b.guest_info ?? e.guest_info).slice(0, 1500), b.rsvp_open === undefined ? e.rsvp_open : (b.rsvp_open ? 1 : 0),
        String(b.pay_details ?? e.pay_details).slice(0, 1000), b.passes_auto === undefined ? e.passes_auto : (b.passes_auto ? 1 : 0), b.passes_time ?? e.passes_time, e.id,
      );
      res.json({ ok: true });
      changed(e.id, 'settings');
    });
  }

  // The planner, the couple and vendors they trust with seating can all change the plan.
  function seatingRoutes(r) {
    const seatChanged = (eventId) => changed(eventId, 'guests');
    r.post('/tables', (req, res) => {
      const b = req.body || {};
      const out = b.count ? { added: seating.addMany(req.ev.id, b) } : { id: seating.addTable(req.ev.id, b) };
      res.status(201).json(out);
      seatChanged(req.ev.id);
    });
    r.post('/tables/auto', (req, res) => {
      res.json(seating.autoSeat(req.ev.id));
      seatChanged(req.ev.id);
    });
    r.post('/tables/seat', (req, res) => {
      seating.seat(req.ev.id, req.body?.guest_id, req.body?.table_label);
      res.json({ ok: true });
      seatChanged(req.ev.id);
    });
    r.patch('/tables/:id', (req, res) => {
      seating.updateTable(req.ev.id, num(req), req.body || {});
      res.json({ ok: true });
      seatChanged(req.ev.id);
    });
    r.delete('/tables/:id', (req, res) => {
      seating.removeTable(req.ev.id, num(req));
      res.json({ ok: true });
      seatChanged(req.ev.id);
    });
  }
  ownerRoutes(p);

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

  // ---------- the couple (or whoever owns the event) runs guests, aso-ebi and seating too ----------

  const c = express.Router({ mergeParams: true });
  c.use((req, _res, next) => {
    req.ev = store.db.prepare('SELECT * FROM events WHERE couple_token = ?').get(req.params.token);
    next(req.ev ? undefined : new HttpError(404, 'Link not found'));
  });
  ownerRoutes(c);
  app.use('/api/c/:token', c);

  // ---------- vendors the planner trusts with the table plan ----------

  const seatVendor = express.Router({ mergeParams: true });
  seatVendor.use('/tables', (req, _res, next) => {
    const v = store.vendorByToken(req.params.token);
    if (!v) return next(new HttpError(404, 'Link not found'));
    if (!v.can_seat) return next(new HttpError(403, 'Ask the planner to give you access to the table plan'));
    req.ev = store.event(v.event_id);
    next();
  });
  seatVendor.get('/tables', (req, res) => res.json({ ...seating.plan(req.ev.id), event: publicEvent(req.ev) }));
  seatingRoutes(seatVendor);
  app.use('/api/v/:token', seatVendor);

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
    items: asoebi.items(req.ev.id, { activeOnly: true }), paystack: Boolean(payoutFor(req.ev)),
  }));
  pub.post('/rsvp', (req, res) => {
    if (!guests.db.prepare('SELECT 1 FROM guests WHERE event_id = ? AND phone = ?').get(req.ev.id, normalizePhone(req.body?.phone))) accounts.assertGuestRoom(req.ev);
    const g = guests.publicRsvp(req.ev, req.body || {});
    res.status(201).json({ invite_url: `/i/${g.token}` });
    changed(req.ev.id, 'guests');
  });
  pub.post('/orders', wrap(async (req, res) => {
    const order = asoebi.placeOrder(req.ev, req.body || {});
    changed(req.ev.id, 'asoebi');
    let pay_url = null;
    const subaccount = payoutFor(req.ev);
    if (subaccount && req.body?.pay === 'card') {
      if (!/^\S+@\S+\.\S+$/.test(req.body.email || '')) throw new HttpError(400, 'Enter your email to pay by card');
      pay_url = await paystack.checkout(order, { email: req.body.email, callbackUrl: `${origin(req)}/api/o/${order.token}/paystack`, subaccount });
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
    res.json({ event: publicEvent(ev), order, pay_details: ev.pay_details, paystack: Boolean(payoutFor(ev)) });
  });
  app.post('/api/o/:token/pay', wrap(async (req, res) => {
    const o = asoebi.orderByToken(req.params.token);
    if (!o) throw new HttpError(404, 'Order not found');
    const subaccount = payoutFor(store.event(o.event_id));
    if (!subaccount) throw new HttpError(400, 'Card payment is not available for this event');
    if (o.paid_at) throw new HttpError(400, 'This order is already paid');
    if (!/^\S+@\S+\.\S+$/.test(req.body?.email || '')) throw new HttpError(400, 'Enter your email to pay by card');
    res.json({ pay_url: await paystack.checkout(o, { email: req.body.email, callbackUrl: `${origin(req)}/api/o/${o.token}/paystack`, subaccount }) });
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

  const coupleEvent = (token) => {
    const ev = store.db.prepare('SELECT * FROM events WHERE couple_token = ?').get(token);
    if (!ev) throw new HttpError(404, 'Link not found');
    return ev;
  };

  app.get('/api/c/:token', (req, res) => {
    const ev = coupleEvent(req.params.token);
    const money = finance.summary(ev.id);
    const owner = ev.planner_id && accounts.get(ev.planner_id);
    const byVendor = Object.fromEntries(reviews.forEvent(ev.id).map((r) => [r.vendor_id, r]));
    res.json({
      event: { ...publicEvent(ev), public_token: ev.public_token, gate_token: ev.gate_token, rsvp_open: ev.rsvp_open, pay_details: ev.pay_details, guest_info: ev.guest_info },
      planner: { name: owner?.name || '', phone: ev.contact_phone || owner?.phone || '' },
      progress: { ...progress.summary(ev.id), couple_names: ev.couple_names, note: ev.couple_note },
      reviews_open: reviews.open(ev),
      cues: store.cues(ev.id).map(({ title, start_min, duration, done_at }) => ({ title, start_min, duration, done_at })),
      vendors: store.vendors(ev.id).map(({ id, name, role, checked_in_at, review_requested_at }) => {
        const r = byVendor[id];
        return { id, name, role, checked_in_at, review_requested: Boolean(review_requested_at), review: r ? { rating: r.rating, body: r.body, reviewer: r.reviewer } : null };
      }),
      guests: guests.stats(ev.id),
      asoebi: asoebi.stats(ev.id),
      money: { totals: money.totals, lines: money.lines, unlinked: money.unlinked, upcoming: money.upcoming,
        vendors: money.vendors.map(({ terms: _t, ...v }) => v) },
    });
  });
  app.post('/api/c/:token/reviews', wrap(async (req, res) => {
    const ev = coupleEvent(req.params.token);
    const { vendor } = reviews.save(ev, req.body || {});
    store.log(ev.id, 'change', `The couple reviewed ${vendor.name}`, vendor.id);
    res.status(201).json({ ok: true });
    changed(ev.id, 'reviews');
    await broadcast(ev.id);
  }));
}

module.exports = { mountSuite };
