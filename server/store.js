const templates = require('./templates');
const { newToken: token } = require('./db');
const { fmtTime } = require('../public/js/time');


// Nigerian local numbers (0803...) become 234803...; anything else keeps its digits.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) return '234' + digits.slice(1);
  return digits;
}

class Store {
  constructor(db) {
    this.db = db;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- events ----

  createEvent({ name, type = 'blank', date, venue = '' }) {
    const tpl = templates[type];
    if (!tpl) throw new HttpError(400, `Unknown event type "${type}"`);
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'Name and date (YYYY-MM-DD) are required');
    return this.tx(() => {
      const { lastInsertRowid: eventId } = this.db
        .prepare('INSERT INTO events (name, type, date, venue, planner_token, public_token, gate_token, couple_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, type, date, venue, token(), token(), token(), token());
      const roleToVendor = {};
      for (const v of tpl.vendors) roleToVendor[v.role] = this.insertVendor(eventId, v).id;
      for (const c of tpl.cues) {
        this.insertCue(eventId, { ...c, vendor_ids: c.roles.map((r) => roleToVendor[r]).filter(Boolean) });
      }
      return this.event(eventId);
    });
  }

  event(id) {
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  }

  eventByPlannerToken(t) {
    return this.db.prepare('SELECT * FROM events WHERE planner_token = ?').get(t);
  }

  // ---- vendors ----

  insertVendor(eventId, { name, role, phone = '' }) {
    if (!name || !role) throw new HttpError(400, 'Vendor name and role are required');
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO vendors (event_id, name, role, phone, token) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, name, role, normalizePhone(phone), token());
    return this.vendor(lastInsertRowid);
  }

  vendor(id) {
    return this.db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  }

  vendorByToken(t) {
    return this.db.prepare('SELECT * FROM vendors WHERE token = ?').get(t);
  }

  vendors(eventId) {
    return this.db.prepare('SELECT * FROM vendors WHERE event_id = ? ORDER BY id').all(eventId);
  }

  updateVendor(eventId, vendorId, { name, role, phone, can_seat }) {
    const v = this.vendorIn(eventId, vendorId);
    this.db.prepare('UPDATE vendors SET name = ?, role = ?, phone = ?, can_seat = ? WHERE id = ?').run(
      name ?? v.name, role ?? v.role, phone === undefined ? v.phone : normalizePhone(phone), can_seat === undefined ? v.can_seat : (can_seat ? 1 : 0), v.id,
    );
    return this.vendor(v.id);
  }

  removeVendor(eventId, vendorId) {
    this.vendorIn(eventId, vendorId);
    this.db.prepare('DELETE FROM vendors WHERE id = ?').run(vendorId);
  }

  vendorIn(eventId, vendorId) {
    const v = this.vendor(vendorId);
    if (!v || v.event_id !== eventId) throw new HttpError(404, 'Vendor not found');
    return v;
  }

  checkIn(vendor) {
    if (vendor.checked_in_at) return false;
    this.db.prepare("UPDATE vendors SET checked_in_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(vendor.id);
    this.log(vendor.event_id, 'checkin', `${vendor.name} checked in`, vendor.id);
    return true;
  }

  savePushSub(vendor, sub) {
    this.db.prepare('UPDATE vendors SET push_sub = ? WHERE id = ?').run(sub ? JSON.stringify(sub) : null, vendor.id);
  }

  // ---- cues ----

  insertCue(eventId, { title, start_min, duration = 15, notes = '', vendor_ids = [] }) {
    if (!title || !Number.isInteger(start_min)) throw new HttpError(400, 'Cue title and start time are required');
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO cues (event_id, title, start_min, duration, notes) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, title, start_min, duration, notes);
    this.setCueVendors(eventId, lastInsertRowid, vendor_ids);
    return lastInsertRowid;
  }

  setCueVendors(eventId, cueId, vendorIds) {
    this.db.prepare('DELETE FROM cue_vendors WHERE cue_id = ?').run(cueId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO cue_vendors (cue_id, vendor_id) VALUES (?, ?)');
    for (const vid of vendorIds) {
      this.vendorIn(eventId, Number(vid));
      ins.run(cueId, Number(vid));
    }
  }

  cue(id) {
    return this.db.prepare('SELECT * FROM cues WHERE id = ?').get(id);
  }

  cueIn(eventId, cueId) {
    const c = this.cue(cueId);
    if (!c || c.event_id !== eventId) throw new HttpError(404, 'Cue not found');
    return c;
  }

  cues(eventId) {
    const rows = this.db.prepare('SELECT * FROM cues WHERE event_id = ? ORDER BY start_min, id').all(eventId);
    const links = this.db
      .prepare('SELECT cv.cue_id, cv.vendor_id FROM cue_vendors cv JOIN cues c ON c.id = cv.cue_id WHERE c.event_id = ?')
      .all(eventId);
    const byCue = {};
    for (const l of links) (byCue[l.cue_id] ||= []).push(l.vendor_id);
    return rows.map((c) => ({ ...c, vendor_ids: byCue[c.id] || [] }));
  }

  cueVendorIds(cueId) {
    return this.db.prepare('SELECT vendor_id FROM cue_vendors WHERE cue_id = ?').all(cueId).map((r) => r.vendor_id);
  }

  // Returns the list of time moves so the caller can notify the owners.
  addCue(eventId, body) {
    const id = this.tx(() => this.insertCue(eventId, normalizeCueBody(body)));
    const c = this.cue(id);
    this.log(eventId, 'change', `Added "${c.title}" at ${fmtTime(c.start_min)}`);
    return { cueId: id, moves: [{ cueId: id, title: c.title, from: null, to: c.start_min }] };
  }

  updateCue(eventId, cueId, body) {
    const before = this.cueIn(eventId, cueId);
    const beforeVendors = this.cueVendorIds(cueId);
    const b = normalizeCueBody({ ...before, vendor_ids: beforeVendors, ...body });
    this.tx(() => {
      this.db.prepare('UPDATE cues SET title = ?, start_min = ?, duration = ?, notes = ? WHERE id = ?')
        .run(b.title, b.start_min, b.duration, b.notes, cueId);
      this.setCueVendors(eventId, cueId, b.vendor_ids);
    });
    const moves = [];
    if (b.start_min !== before.start_min) {
      moves.push({ cueId, title: b.title, from: before.start_min, to: b.start_min });
      this.log(eventId, 'change', `"${b.title}" moved to ${fmtTime(b.start_min)} (was ${fmtTime(before.start_min)})`);
    } else if (b.title !== before.title || b.notes !== before.notes || b.duration !== before.duration) {
      this.log(eventId, 'change', `"${b.title}" details updated`);
    }
    const added = b.vendor_ids.filter((v) => !beforeVendors.includes(v));
    return { moves, addedVendors: added, cueId };
  }

  deleteCue(eventId, cueId) {
    const c = this.cueIn(eventId, cueId);
    const vendorIds = this.cueVendorIds(cueId);
    this.db.prepare('DELETE FROM cues WHERE id = ?').run(cueId);
    this.log(eventId, 'change', `Removed "${c.title}"`);
    return { cue: c, vendorIds };
  }

  // Moves this cue and every later cue that isn't done by `minutes`.
  shift(eventId, fromCueId, minutes) {
    if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > 720) throw new HttpError(400, 'Shift must be a whole number of minutes, up to 12 hours');
    const from = this.cueIn(eventId, fromCueId);
    const targets = this.db
      .prepare('SELECT * FROM cues WHERE event_id = ? AND done_at IS NULL AND (start_min > ? OR (start_min = ? AND id >= ?)) ORDER BY start_min, id')
      .all(eventId, from.start_min, from.start_min, from.id);
    const upd = this.db.prepare('UPDATE cues SET start_min = ? WHERE id = ?');
    this.tx(() => { for (const c of targets) upd.run(Math.max(0, c.start_min + minutes), c.id); });
    const dir = minutes > 0 ? 'later' : 'earlier';
    this.log(eventId, 'change', `Timeline moved ${Math.abs(minutes)} min ${dir} from "${from.title}" (${targets.length} cues)`);
    return { moves: targets.map((c) => ({ cueId: c.id, title: c.title, from: c.start_min, to: Math.max(0, c.start_min + minutes) })), shift: minutes, fromTitle: from.title };
  }

  setDone(eventId, cueId, done, vendor = null) {
    const c = this.cueIn(eventId, cueId);
    if (vendor && !this.cueVendorIds(cueId).includes(vendor.id)) throw new HttpError(403, 'This cue is not assigned to you');
    if (done === Boolean(c.done_at)) return false;
    this.db.prepare("UPDATE cues SET done_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END, done_by = ? WHERE id = ?")
      .run(done ? 1 : 0, done && vendor ? vendor.id : null, cueId);
    const who = vendor ? vendor.name : 'Planner';
    this.log(eventId, 'done', done ? `${who} marked "${c.title}" done` : `${who} reopened "${c.title}"`, vendor?.id ?? null);
    return true;
  }

  // ---- activity ----

  log(eventId, kind, message, vendorId = null, channel = null) {
    this.db.prepare('INSERT INTO activity (event_id, kind, message, vendor_id, channel) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, kind, message, vendorId, channel);
  }

  activity(eventId, limit = 60) {
    return this.db.prepare('SELECT * FROM activity WHERE event_id = ? ORDER BY id DESC LIMIT ?').all(eventId, limit);
  }

  // ---- views sent to clients ----

  plannerView(eventId) {
    const event = this.event(eventId);
    return {
      event,
      vendors: this.vendors(eventId).map(({ push_sub, ...v }) => ({ ...v, push_enabled: Boolean(push_sub) })),
      cues: this.cues(eventId),
      activity: this.activity(eventId),
    };
  }

  vendorView(vendorId) {
    const vendor = this.vendor(vendorId);
    // Only what a vendor needs: the other event links (couple, gate, planner) are credentials.
    const { id, name, type, date, venue } = this.event(vendor.event_id);
    const event = { id, name, type, date, venue };
    const names = Object.fromEntries(this.vendors(vendor.event_id).map((v) => [v.id, `${v.name}`]));
    const cues = this.cues(vendor.event_id)
      .filter((c) => c.vendor_ids.includes(vendor.id))
      .map(({ vendor_ids, ...c }) => ({ ...c, with: vendor_ids.filter((id) => id !== vendor.id).map((id) => names[id]) }));
    const notices = this.db
      .prepare("SELECT message, at FROM activity WHERE vendor_id = ? AND kind = 'notify' ORDER BY id DESC LIMIT 10")
      .all(vendor.id);
    const { token: _t, push_sub, ...self } = vendor;
    return { event, vendor: { ...self, push_enabled: Boolean(push_sub) }, cues, notices };
  }
}

function normalizeCueBody(b) {
  if (!Number.isInteger(Number(b.start_min)) || Number(b.start_min) < 0) throw new HttpError(400, 'Cue start time is invalid');
  if (!String(b.title || '').trim()) throw new HttpError(400, 'Cue title is required');
  return {
    title: String(b.title || '').trim(),
    start_min: Number(b.start_min),
    duration: Math.max(0, Number(b.duration ?? 15) | 0),
    notes: String(b.notes || ''),
    vendor_ids: (b.vendor_ids || []).map(Number),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { Store, HttpError, normalizePhone };
