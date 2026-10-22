// The couple's progress view: a checklist of what's locked in before the day, grouped by category.
const { HttpError, normalizePhone } = require('./store');
const templates = require('./templates');

class Progress {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  // An item linked to a vendor counts as locked once that vendor accepts their agreement.
  items(eventId) {
    return this.db.prepare(`SELECT c.*, v.name AS vendor_name, v.role AS vendor_role, v.accepted_at AS vendor_accepted_at
      FROM checklist c LEFT JOIN vendors v ON v.id = c.vendor_id WHERE c.event_id = ? ORDER BY c.sort, c.id`).all(eventId)
      .map((c) => ({ ...c, locked: Boolean(c.locked_at || c.vendor_accepted_at), auto: Boolean(!c.locked_at && c.vendor_accepted_at) }));
  }

  summary(eventId) {
    const items = this.items(eventId);
    const cats = new Map();
    for (const i of items) {
      if (!cats.has(i.category)) cats.set(i.category, { name: i.category, locked: 0, total: 0, items: [] });
      const c = cats.get(i.category);
      c.total += 1;
      c.locked += i.locked ? 1 : 0;
      c.items.push({ title: i.title, locked: i.locked });
    }
    const locked = items.filter((i) => i.locked).length;
    return { locked, total: items.length, percent: items.length ? Math.round((locked / items.length) * 100) : 0, categories: [...cats.values()] };
  }

  item(eventId, id) {
    const c = this.db.prepare('SELECT * FROM checklist WHERE id = ? AND event_id = ?').get(id, eventId);
    if (!c) throw new HttpError(404, 'Item not found');
    return c;
  }

  vendorId(eventId, value) {
    if (value === null || value === undefined || value === '') return null;
    return this.store.vendorIn(eventId, Number(value)).id;
  }

  add(eventId, b) {
    const category = String(b.category || '').trim().slice(0, 60);
    const title = String(b.title || '').trim().slice(0, 120);
    if (!category || !title) throw new HttpError(400, 'Category and item are required');
    const { n } = this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM checklist WHERE event_id = ?').get(eventId);
    const { lastInsertRowid } = this.db.prepare('INSERT INTO checklist (event_id, category, title, vendor_id, locked_at, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventId, category, title, this.vendorId(eventId, b.vendor_id), b.locked ? new Date().toISOString() : null, n);
    return lastInsertRowid;
  }

  update(eventId, id, b) {
    const c = this.item(eventId, id);
    const lockedAt = b.locked === undefined ? c.locked_at : b.locked ? (c.locked_at || new Date().toISOString()) : null;
    this.db.prepare('UPDATE checklist SET category = ?, title = ?, vendor_id = ?, locked_at = ? WHERE id = ?').run(
      String(b.category ?? c.category).trim().slice(0, 60) || c.category, String(b.title ?? c.title).trim().slice(0, 120) || c.title,
      b.vendor_id === undefined ? c.vendor_id : this.vendorId(eventId, b.vendor_id), lockedAt, c.id,
    );
  }

  remove(eventId, id) {
    this.item(eventId, id);
    this.db.prepare('DELETE FROM checklist WHERE id = ?').run(id);
  }

  // Adds the event type's starter checklist, linking items to this event's vendors by role.
  seed(eventId, type) {
    const tpl = templates[type] || templates['ng-wedding'];
    const byRole = {};
    for (const v of this.store.vendors(eventId)) byRole[v.role] ??= v.id;
    const insert = this.db.prepare('INSERT INTO checklist (event_id, category, title, vendor_id, sort) VALUES (?, ?, ?, ?, ?)');
    const { n } = this.db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM checklist WHERE event_id = ?').get(eventId);
    tpl.checklist.forEach((c, i) => insert.run(eventId, c.category, c.title, (c.role && byRole[c.role]) || null, n + i + 1));
    return tpl.checklist.length;
  }

  setNote(event, b) {
    this.db.prepare('UPDATE events SET couple_names = ?, couple_note = ?, contact_phone = ? WHERE id = ?').run(
      String(b.couple_names ?? event.couple_names).trim().slice(0, 120), String(b.couple_note ?? event.couple_note).trim().slice(0, 1000),
      b.contact_phone === undefined ? event.contact_phone : normalizePhone(b.contact_phone), event.id,
    );
  }
}

module.exports = { Progress };
