const crypto = require('node:crypto');
const { HttpError, normalizePhone } = require('./store');
const { newToken } = require('./db');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, so codes can be read out at the gate
const randomCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

class Guests {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  list(eventId) {
    return this.db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY name COLLATE NOCASE').all(eventId);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  }

  in(eventId, id) {
    const g = this.get(id);
    if (!g || g.event_id !== eventId) throw new HttpError(404, 'Guest not found');
    return g;
  }

  byToken(token) {
    return this.db.prepare('SELECT * FROM guests WHERE token = ?').get(token);
  }

  add(eventId, body, source = 'list') {
    const g = clean(body);
    for (let attempt = 0; ; attempt++) {
      try {
        const { lastInsertRowid } = this.db
          .prepare('INSERT INTO guests (event_id, name, phone, party_size, side, table_label, rsvp, rsvp_at, token, code, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(eventId, g.name, g.phone, g.party_size, g.side, g.table_label, g.rsvp, g.rsvp === 'pending' ? null : new Date().toISOString(), newToken(), randomCode(), source);
        return this.get(lastInsertRowid);
      } catch (err) {
        if (attempt < 5 && /UNIQUE/.test(err.message)) continue;
        throw err;
      }
    }
  }

  // One guest per line: name, phone, party size, side, table. Only the name is required.
  import(eventId, text) {
    const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (rows.length > 3000) throw new HttpError(400, 'Import at most 3000 guests at a time');
    const parsed = rows
      .map((line) => line.split(line.includes('\t') ? '\t' : ',').map((c) => c.trim()))
      .filter(([name]) => name && !/^name$/i.test(name))
      .map(([name, phone, party, side, table]) => ({ name, phone, party_size: Number(party) || 1, side, table_label: table }));
    return this.store.tx(() => parsed.map((g) => this.add(eventId, g)).length);
  }

  update(eventId, id, body) {
    const before = this.in(eventId, id);
    const g = clean({ ...before, ...body });
    this.db.prepare('UPDATE guests SET name = ?, phone = ?, party_size = ?, side = ?, table_label = ?, rsvp = ?, rsvp_at = CASE WHEN ? != rsvp THEN ? ELSE rsvp_at END WHERE id = ?')
      .run(g.name, g.phone, g.party_size, g.side, g.table_label, g.rsvp, g.rsvp, new Date().toISOString(), id);
    // The host set the party size, so that becomes what the invite admits.
    if (body.party_size !== undefined && g.party_size !== before.party_size) this.db.prepare('UPDATE guests SET invited_party = NULL WHERE id = ?').run(id);
    return this.get(id);
  }

  remove(eventId, id) {
    this.in(eventId, id);
    this.db.prepare('DELETE FROM guests WHERE id = ?').run(id);
  }

  rsvp(guest, { rsvp, party_size }) {
    if (!['yes', 'no'].includes(rsvp)) throw new HttpError(400, 'Answer yes or no');
    const size = rsvp === 'yes' ? clampParty(party_size ?? guest.party_size) : guest.party_size;
    this.db.prepare('UPDATE guests SET rsvp = ?, party_size = ?, rsvp_at = ? WHERE id = ?').run(rsvp, size, new Date().toISOString(), guest.id);
    return this.get(guest.id);
  }

  // Open RSVP link: a returning phone number gets their existing invite back instead of a duplicate.
  publicRsvp(event, body) {
    if (!event.rsvp_open) throw new HttpError(403, 'RSVPs are closed for this event');
    const phone = normalizePhone(body.phone);
    if (!String(body.name || '').trim() || phone.length < 7) throw new HttpError(400, 'Name and phone number are required');
    const existing = this.db.prepare('SELECT * FROM guests WHERE event_id = ? AND phone = ?').get(event.id, phone);
    if (existing) return this.rsvp(existing, { rsvp: 'yes', party_size: body.party_size });
    return this.add(event.id, { ...body, phone, rsvp: 'yes' }, 'public');
  }

  // A scan is either the invite URL (…/i/<token>) or the short code typed in by hand.
  find(eventId, scanned) {
    const raw = String(scanned || '').trim();
    const token = raw.match(/\/i\/([A-Za-z0-9_-]+)/)?.[1];
    const g = token ? this.byToken(token) : this.db.prepare('SELECT * FROM guests WHERE event_id = ? AND code = ?').get(eventId, raw.toUpperCase());
    return g && g.event_id === eventId ? g : null;
  }

  search(eventId, q) {
    const like = `%${String(q || '').trim()}%`;
    return this.db.prepare('SELECT * FROM guests WHERE event_id = ? AND (name LIKE ? OR phone LIKE ? OR code LIKE ?) ORDER BY name COLLATE NOCASE LIMIT 20')
      .all(eventId, like, like, like);
  }

  admit(guest) {
    if (guest.arrived_at) return { guest, already: true };
    this.db.prepare('UPDATE guests SET arrived_at = ? WHERE id = ?').run(new Date().toISOString(), guest.id);
    return { guest: this.get(guest.id), already: false };
  }

  undoAdmit(eventId, id) {
    this.in(eventId, id);
    this.db.prepare('UPDATE guests SET arrived_at = NULL WHERE id = ?').run(id);
  }

  stats(eventId) {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS invited, COALESCE(SUM(party_size), 0) AS invited_people,
        COALESCE(SUM(rsvp = 'yes'), 0) AS yes, COALESCE(SUM(CASE WHEN rsvp = 'yes' THEN party_size END), 0) AS yes_people,
        COALESCE(SUM(rsvp = 'no'), 0) AS no, COALESCE(SUM(rsvp = 'pending'), 0) AS pending,
        COALESCE(SUM(arrived_at IS NOT NULL), 0) AS arrived, COALESCE(SUM(CASE WHEN arrived_at IS NOT NULL THEN party_size END), 0) AS arrived_people
      FROM guests WHERE event_id = ?`).get(eventId);
    return { ...r };
  }
}

const clampParty = (n) => Math.min(20, Math.max(1, Number(n) | 0 || 1));

function clean(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Guest name is required');
  const rsvp = ['pending', 'yes', 'no'].includes(b.rsvp) ? b.rsvp : 'pending';
  return {
    name: name.slice(0, 120),
    phone: normalizePhone(b.phone),
    party_size: clampParty(b.party_size),
    side: String(b.side || '').trim().slice(0, 40),
    table_label: String(b.table_label || '').trim().slice(0, 40),
    rsvp,
  };
}

// The invite link and QR only need a few event fields; tokens other than the guest's own stay private.
const publicGuest = ({ token: _t, ...g }) => g;

module.exports = { Guests, publicGuest };
