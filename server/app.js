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

function createApp({ dbFile = ':memory:', dataDir = null, baseUrl = 'http://localhost:3000', vapid = loadVapid(dataDir), whatsapp = whatsappConfig(), fetchImpl } = {}) {
  const store = new Store(openDb(dbFile));
  const notifier = new Notifier(store, { vapid, whatsapp, baseUrl, fetchImpl });
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(PUBLIC, { index: false }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  app.get('/p/:token', (_req, res) => res.sendFile(path.join(PUBLIC, 'planner.html')));
  app.get('/v/:token', (_req, res) => res.sendFile(path.join(PUBLIC, 'vendor.html')));

  // ---- live sync ----

  function broadcast(eventId) {
    io.to(`planner:${eventId}`).emit('state', store.plannerView(eventId));
    for (const v of store.vendors(eventId)) io.to(`vendor:${v.id}`).emit('state', store.vendorView(v.id));
  }

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
      socket.emit('state', store.plannerView(ev.id));
    } else if (vendor) {
      const v = store.vendorByToken(vendor);
      if (!v) return socket.disconnect(true);
      socket.join(`vendor:${v.id}`);
      socket.emit('state', store.vendorView(v.id));
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
    const ev = store.createEvent(req.body || {});
    res.status(201).json({ id: ev.id, planner_url: `/p/${ev.planner_token}` });
  });

  // ---- planner (token in URL is the credential) ----

  const planner = express.Router({ mergeParams: true });
  planner.use((req, _res, next) => {
    req.ev = store.eventByPlannerToken(req.params.token);
    next(req.ev ? undefined : new HttpError(404, 'Event not found'));
  });
  const id = (req, key = 'id') => Number(req.params[key]);

  planner.get('/', (req, res) => res.json(store.plannerView(req.ev.id)));

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
  vendorApi.get('/', (req, res) => res.json(store.vendorView(req.vendor.id)));
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

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status === 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  });

  return { app, server, io, store, notifier };
}

module.exports = { createApp };
