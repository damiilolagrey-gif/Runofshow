const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const webpush = require('web-push');
const { openDb } = require('./db');
const { Store, HttpError } = require('./store');
const { Notifier } = require('./notify');
const templates = require('./templates');
const { Guests } = require('./guests');
const { AsoEbi, Finance } = require('./money');
const { Paystack } = require('./paystack');
const { mountSuite } = require('./suite');
const { Accounts, planConfig } = require('./accounts');
const { mountBilling } = require('./billing');
const { Progress } = require('./progress');
const { Reviews, profileSlug } = require('./reviews');
const { mountShowcase } = require('./showcase');

const PUBLIC = path.join(__dirname, '..', 'public');

function loadVapid(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' };
  }
  if (!dataDir) return null;
  const file = path.join(dataDir, 'vapid.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(webpush.generateVAPIDKeys()));
  }
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')), subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' };
}

function whatsappConfig() {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE, WHATSAPP_TEMPLATE_LANG } = process.env;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return null;
  return { token: WHATSAPP_TOKEN, phoneNumberId: WHATSAPP_PHONE_NUMBER_ID, template: WHATSAPP_TEMPLATE, lang: WHATSAPP_TEMPLATE_LANG };
}

function createApp({ dbFile = ':memory:', dataDir = null, baseUrl = 'http://localhost:3000', vapid = loadVapid(dataDir), whatsapp = whatsappConfig(),
  paystackKey = process.env.PAYSTACK_SECRET_KEY, enforceLimits, plans = planConfig(), fetchImpl } = {}) {
  const store = new Store(openDb(dbFile));
  const guests = new Guests(store);
  const asoebi = new AsoEbi(store);
  const finance = new Finance(store);
  const progress = new Progress(store);
  const reviews = new Reviews(store);
  const paystack = paystackKey ? new Paystack(paystackKey, fetchImpl) : null;
  const accounts = new Accounts(store, { enforce: enforceLimits ?? Boolean(paystack), plans });
  const notifier = new Notifier(store, { vapid, whatsapp, baseUrl, fetchImpl });
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.set('trust proxy', 1);
  mountBilling(app, { store, accounts, paystack, asoebi }); // before the JSON parser: the Paystack webhook needs the raw body
  app.use(express.json({ limit: '300kb' })); // guest imports can be a few hundred lines
  app.use(express.static(PUBLIC, { index: false }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  app.get('/p/:token', (_req, res) => res.sendFile(path.join(PUBLIC, 'planner.html')));
  app.get('/v/:token', (_req, res) => res.sendFile(path.join(PUBLIC, 'vendor.html')));

  // ---- live sync ----

  // The planner sees each vendor's review rating next to their name.
  const plannerView = (eventId) => {
    const view = store.plannerView(eventId);
    const ratings = Object.fromEntries(reviews.forEvent(eventId).map((r) => [r.vendor_id, r.rating]));
    return { ...view, vendors: view.vendors.map((v) => ({ ...v, rating: ratings[v.id] || null })) };
  };

  function broadcast(eventId) {
    io.to(`planner:${eventId}`).emit('state', plannerView(eventId));
    for (const v of store.vendors(eventId)) io.to(`vendor:${v.id}`).emit('state', vendorView(v.id));
  }

  const vendorView = (vendorId) => {
    const view = store.vendorView(vendorId);
    const v = store.vendor(vendorId);
    const review = reviews.forVendor(v.id);
    const slug = profileSlug(v.phone);
    return {
      ...view,
      deal: { fee: v.fee, terms: v.terms, accepted_at: v.accepted_at, payments: finance.payments(v.event_id, v.id) },
      reviews: {
        open: reviews.open(store.event(v.event_id)),
        requested_at: v.review_requested_at,
        review: review && { rating: review.rating, body: review.body, reviewer: review.reviewer, url: `/review/${review.token}` },
        profile_url: slug && `/pro/${slug}`,
      },
    };
  };

  // Broadcast the change at once, then again after notifications are logged.
  async function afterChange(eventId, messages = []) {
    broadcast(eventId);
    for (const m of messages) io.to(`vendor:${m.vendorId}`).emit('notice', m.text);
    if (messages.length) {
      await notifier.send(messages);
      broadcast(eventId);
    }
  }

  io.on('connection', (socket) => {
    const { planner, vendor } = socket.handshake.auth || {};
    if (planner) {
      const ev = store.eventByPlannerToken(planner);
      if (!ev) return socket.disconnect(true);
      socket.join(`planner:${ev.id}`);
      socket.emit('state', plannerView(ev.id));
    } else if (vendor) {
      const v = store.vendorByToken(vendor);
      if (!v) return socket.disconnect(true);
      socket.join(`vendor:${v.id}`);
      socket.emit('state', vendorView(v.id));
    } else if (socket.handshake.auth?.couple || socket.handshake.auth?.gate) {
      const { couple, gate } = socket.handshake.auth;
      const ev = store.db.prepare(`SELECT id FROM events WHERE ${couple ? 'couple_token' : 'gate_token'} = ?`).get(couple || gate);
      if (!ev) return socket.disconnect(true);
      socket.join(`${couple ? 'couple' : 'gate'}:${ev.id}`);
    } else {
      socket.disconnect(true);
    }
  });

  // ---- public ----

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/api/templates', (_req, res) => {
    res.json(Object.entries(templates).map(([id, t]) => ({ id, label: t.label, vendors: t.vendors.length, cues: t.cues.length })));
  });
  app.get('/api/push-key', (_req, res) => res.json({ publicKey: vapid?.publicKey || null }));
  app.post('/api/events', (req, res) => {
    if (!req.planner) throw new HttpError(401, 'Please log in to create an event');
    accounts.assertCanCreateEvent(req.planner, String(req.body?.date || ''));
    const created = store.createEvent(req.body || {});
    progress.seed(created.id, created.type);
    store.db.prepare('UPDATE events SET planner_id = ?, contact_phone = ? WHERE id = ?').run(req.planner.id, req.planner.phone || '', created.id);
    const ev = store.event(created.id);
    res.status(201).json({ id: ev.id, planner_url: `/p/${ev.planner_token}` });
  });

  // ---- planner (token in URL is the credential) ----

  const planner = express.Router({ mergeParams: true });
  planner.use((req, _res, next) => {
    req.ev = store.eventByPlannerToken(req.params.token);
    next(req.ev ? undefined : new HttpError(404, 'Event not found'));
  });
  const id = (req, key = 'id') => Number(req.params[key]);

  planner.get('/', (req, res) => res.json(plannerView(req.ev.id)));

  planner.post('/vendors', wrap(async (req, res) => {
    const v = store.insertVendor(req.ev.id, req.body || {});
    store.log(req.ev.id, 'change', `Added vendor ${v.name} (${v.role})`);
    res.status(201).json({ id: v.id });
    await afterChange(req.ev.id);
  }));
  planner.patch('/vendors/:id', wrap(async (req, res) => {
    store.updateVendor(req.ev.id, id(req), req.body || {});
    res.json({ ok: true });
    await afterChange(req.ev.id);
  }));
  planner.delete('/vendors/:id', wrap(async (req, res) => {
    store.removeVendor(req.ev.id, id(req));
    res.json({ ok: true });
    await afterChange(req.ev.id);
  }));
  planner.post('/vendors/:id/checkin', wrap(async (req, res) => {
    store.checkIn(store.vendorIn(req.ev.id, id(req)));
    res.json({ ok: true });
    await afterChange(req.ev.id);
  }));

  planner.post('/cues', wrap(async (req, res) => {
    const change = store.addCue(req.ev.id, req.body || {});
    res.status(201).json({ id: change.cueId });
    await afterChange(req.ev.id, notifier.messagesForMoves(req.ev, change));
  }));
  planner.patch('/cues/:id', wrap(async (req, res) => {
    const change = store.updateCue(req.ev.id, id(req), req.body || {});
    res.json({ ok: true });
    await afterChange(req.ev.id, notifier.messagesForMoves(req.ev, change));
  }));
  planner.delete('/cues/:id', wrap(async (req, res) => {
    const removed = store.deleteCue(req.ev.id, id(req));
    res.json({ ok: true });
    await afterChange(req.ev.id, notifier.messagesForRemoval(req.ev, removed));
  }));
  planner.post('/cues/:id/shift', wrap(async (req, res) => {
    const change = store.shift(req.ev.id, id(req), Number(req.body?.minutes));
    res.json({ moved: change.moves.length });
    await afterChange(req.ev.id, notifier.messagesForMoves(req.ev, change));
  }));
  planner.post('/cues/:id/done', wrap(async (req, res) => {
    store.setDone(req.ev.id, id(req), Boolean(req.body?.done));
    res.json({ ok: true });
    await afterChange(req.ev.id);
  }));
  app.use('/api/p/:token', planner);

  // ---- vendor ----

  const vendorApi = express.Router({ mergeParams: true });
  vendorApi.use((req, _res, next) => {
    req.vendor = store.vendorByToken(req.params.token);
    next(req.vendor ? undefined : new HttpError(404, 'Link not found'));
  });
  vendorApi.get('/', (req, res) => res.json(vendorView(req.vendor.id)));
  vendorApi.post('/accept', wrap(async (req, res) => {
    if (finance.accept(req.vendor)) store.log(req.vendor.event_id, 'change', `${req.vendor.name} accepted their agreement`, req.vendor.id);
    res.json({ ok: true });
    await afterChange(req.vendor.event_id);
    io.to(`planner:${req.vendor.event_id}`).emit('changed', 'money');
    for (const room of [`planner:${req.vendor.event_id}`, `couple:${req.vendor.event_id}`]) io.to(room).emit('changed', 'progress');
  }));
  vendorApi.post('/review-request', wrap(async (req, res) => {
    if (!req.vendor.review_requested_at) {
      reviews.request(req.vendor);
      store.log(req.vendor.event_id, 'change', `${req.vendor.name} asked the couple for a review`, req.vendor.id);
    }
    res.json({ ok: true });
    await afterChange(req.vendor.event_id);
    io.to(`couple:${req.vendor.event_id}`).emit('changed', 'reviews');
  }));
  vendorApi.post('/checkin', wrap(async (req, res) => {
    store.checkIn(req.vendor);
    res.json({ ok: true });
    await afterChange(req.vendor.event_id);
  }));
  vendorApi.post('/cues/:id/done', wrap(async (req, res) => {
    store.setDone(req.vendor.event_id, id(req), Boolean(req.body?.done), req.vendor);
    res.json({ ok: true });
    await afterChange(req.vendor.event_id);
  }));
  vendorApi.post('/push', wrap(async (req, res) => {
    const sub = req.body?.subscription;
    if (sub && (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint))) throw new HttpError(400, 'Invalid push subscription');
    store.savePushSub(req.vendor, sub || null);
    res.json({ ok: true });
    await afterChange(req.vendor.event_id);
  }));
  app.use('/api/v/:token', vendorApi);

  mountShowcase(app, { reviews });
  mountSuite(app, { store, guests, asoebi, finance, paystack, accounts, progress, reviews, io, broadcast: async (eventId) => broadcast(eventId) });

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status === 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  });

  return { app, server, io, store, notifier, guests, asoebi, finance, accounts, progress, reviews };
}

module.exports = { createApp };
