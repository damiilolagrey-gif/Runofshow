// Guests' photos and short videos: they scan a QR code and upload from the phone's browser, the hosts
// see everything in an album, and a live wall loops the photos on a TV at the party.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./store');
const { newToken } = require('./db');

const TYPES = {
  'image/jpeg': ['photo', 'jpg'], 'image/png': ['photo', 'png'], 'image/webp': ['photo', 'webp'], 'image/heic': ['photo', 'heic'], 'image/heif': ['photo', 'heif'],
  'video/mp4': ['video', 'mp4'], 'video/quicktime': ['video', 'mov'], 'video/webm': ['video', 'webm'],
};
const MB = 1024 * 1024;

class Moments {
  // limits: bytes per photo and per video, and for the whole event (the server disk is small)
  constructor(store, { dir, photoMax = 12 * MB, videoMax = 60 * MB, eventMax = Number(process.env.MOMENTS_EVENT_MB || 800) * MB } = {}) {
    this.store = store;
    this.db = store.db;
    this.dir = dir;
    this.limits = { photo: photoMax, video: videoMax, event: eventMax };
  }

  // Events made before this feature have no tokens yet; give them some on first use.
  tokens(event) {
    if (!event.moments_token || !event.wall_token) {
      this.db.prepare('UPDATE events SET moments_token = COALESCE(moments_token, ?), wall_token = COALESCE(wall_token, ?) WHERE id = ?').run(newToken(), newToken(), event.id);
      Object.assign(event, this.db.prepare('SELECT moments_token, wall_token FROM events WHERE id = ?').get(event.id));
    }
    return { moments_token: event.moments_token, wall_token: event.wall_token };
  }

  byUploadToken(token) {
    return token ? this.db.prepare('SELECT * FROM events WHERE moments_token = ?').get(token) : null;
  }

  byWallToken(token) {
    return token ? this.db.prepare('SELECT * FROM events WHERE wall_token = ?').get(token) : null;
  }

  list(eventId, { visibleOnly = false } = {}) {
    return this.db.prepare(`SELECT id, kind, mime, bytes, guest_name, hidden, created_at FROM moments WHERE event_id = ? ${visibleOnly ? 'AND hidden = 0' : ''} ORDER BY id DESC`).all(eventId);
  }

  stats(eventId) {
    const r = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(kind = 'photo'), 0) AS photos, COALESCE(SUM(kind = 'video'), 0) AS videos,
      COUNT(DISTINCT NULLIF(guest_name, '')) AS guests, COALESCE(SUM(bytes), 0) AS bytes FROM moments WHERE event_id = ?`).get(eventId);
    return { ...r, limit_bytes: this.limits.event };
  }

  get(eventId, id) {
    const m = this.db.prepare('SELECT * FROM moments WHERE id = ? AND event_id = ?').get(Number(id), eventId);
    if (!m) throw new HttpError(404, 'Not found');
    return m;
  }

  filePath(m) {
    return path.join(this.dir, String(m.event_id), m.file);
  }

  setHidden(eventId, id, hidden) {
    const m = this.get(eventId, id);
    this.db.prepare('UPDATE moments SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, m.id);
  }

  remove(eventId, id) {
    const m = this.get(eventId, id);
    this.db.prepare('DELETE FROM moments WHERE id = ?').run(m.id);
    fs.rm(this.filePath(m), { force: true }, () => {});
  }

  setOpen(event, open) {
    this.db.prepare('UPDATE events SET moments_open = ? WHERE id = ?').run(open ? 1 : 0, event.id);
  }

  // Streams the request body to disk, refusing it as soon as it passes the size limit.
  async save(event, req) {
    if (!event.moments_open) throw new HttpError(403, 'The hosts have closed uploads for this event');
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const type = TYPES[mime];
    if (!type) throw new HttpError(415, 'Send a photo (JPG, PNG, HEIC) or a video (MP4, MOV)');
    const [kind, ext] = type;
    const max = this.limits[kind];
    const declared = Number(req.get('content-length') || 0);
    if (declared > max) throw new HttpError(413, `That ${kind} is too big. The limit is ${Math.round(max / MB)} MB${kind === 'video' ? ', about 30 seconds' : ''}.`);
    const used = this.stats(event.id).bytes;
    if (used + Math.max(declared, 1) > this.limits.event) throw new HttpError(507, 'This event’s album is full. Ask the hosts to make room.');
    const guestName = decodeURIComponent(String(req.get('x-guest-name') || '')).trim().slice(0, 60);

    const folder = path.join(this.dir, String(event.id));
    await fs.promises.mkdir(folder, { recursive: true });
    const file = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const full = path.join(folder, file);
    const bytes = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(full);
      let n = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(full, { force: true }, () => reject(err));
      };
      req.on('data', (chunk) => {
        n += chunk.length;
        if (n > max) {
          req.unpipe(out);
          req.resume();
          fail(new HttpError(413, `That ${kind} is too big. The limit is ${Math.round(max / MB)} MB.`));
        }
      });
      req.on('error', fail);
      req.on('aborted', () => fail(new HttpError(400, 'The upload was interrupted. Try again.')));
      out.on('error', fail);
      out.on('finish', () => { if (!failed) resolve(n); });
      req.pipe(out);
    });
    if (!bytes) {
      fs.rm(full, { force: true }, () => {});
      throw new HttpError(400, 'The file was empty');
    }
    const { lastInsertRowid } = this.db.prepare('INSERT INTO moments (event_id, kind, mime, file, bytes, guest_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, kind, mime, file, bytes, guestName);
    return this.get(event.id, lastInsertRowid);
  }
}

const publicMoment = ({ id, kind, mime, guest_name, created_at }) => ({ id, kind, mime, guest_name, created_at });

module.exports = { Moments, publicMoment, TYPES };
