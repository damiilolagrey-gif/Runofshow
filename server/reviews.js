// Couples rate vendors after the event; vendors share the result as a verified card and a profile.
const crypto = require('node:crypto');
const { HttpError } = require('./store');
const { newToken } = require('./db');

// A vendor's profile groups every event where they used the same phone number.
const profileSlug = (phone) => (phone ? crypto.createHash('sha256').update(`ros-profile:${phone}`).digest('hex').slice(0, 12) : null);

class Reviews {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  // Reviews open on the day of the event.
  open(event) {
    return event.date <= new Date().toISOString().slice(0, 10);
  }

  forVendor(vendorId) {
    return this.db.prepare('SELECT * FROM reviews WHERE vendor_id = ?').get(vendorId) || null;
  }

  forEvent(eventId) {
    return this.db.prepare('SELECT * FROM reviews WHERE event_id = ?').all(eventId);
  }

  byToken(token) {
    return this.db.prepare(`SELECT r.*, v.name AS vendor_name, v.role AS vendor_role, v.phone AS vendor_phone, e.type AS event_type, e.date AS event_date
      FROM reviews r JOIN vendors v ON v.id = r.vendor_id JOIN events e ON e.id = r.event_id WHERE r.token = ?`).get(token);
  }

  save(event, body) {
    if (!this.open(event)) throw new HttpError(400, 'Reviews open on the day of the event');
    const vendor = this.store.vendorIn(event.id, Number(body.vendor_id));
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Choose 1 to 5 stars');
    const text = String(body.body || '').trim().slice(0, 1000);
    const reviewer = String(body.reviewer || '').trim().slice(0, 80);
    this.db.prepare(`INSERT INTO reviews (event_id, vendor_id, rating, body, reviewer, token) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(vendor_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, reviewer = excluded.reviewer,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(event.id, vendor.id, rating, text, reviewer, newToken());
    return { vendor, review: this.forVendor(vendor.id) };
  }

  request(vendor) {
    const ev = this.store.event(vendor.event_id);
    if (!this.open(ev)) throw new HttpError(400, 'You can ask for a review from the day of the event');
    if (!vendor.review_requested_at) this.db.prepare('UPDATE vendors SET review_requested_at = ? WHERE id = ?').run(new Date().toISOString(), vendor.id);
  }

  profile(slug) {
    if (!/^[0-9a-f]{12}$/.test(slug)) return null;
    // Phone numbers aren't indexed by slug, so match in code; vendor counts per deployment are small.
    const vendors = this.db.prepare("SELECT id, name, role, phone FROM vendors WHERE phone != '' ORDER BY id DESC").all().filter((v) => profileSlug(v.phone) === slug);
    if (!vendors.length) return null;
    const ids = vendors.map((v) => v.id);
    const reviews = this.db.prepare(`SELECT r.rating, r.body, r.reviewer, r.token, r.created_at, e.type AS event_type, e.date AS event_date
      FROM reviews r JOIN events e ON e.id = r.event_id WHERE r.vendor_id IN (${ids.map(() => '?').join(',')}) ORDER BY e.date DESC`).all(...ids);
    const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
    return { name: vendors[0].name, role: vendors[0].role, events: vendors.length, reviews, average: Math.round(avg * 10) / 10 };
  }
}

module.exports = { Reviews, profileSlug };
