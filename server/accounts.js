const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError, normalizePhone } = require('./store');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const DAY = 864e5;

const int = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Prices in kobo. Override with env vars without touching code.
function planConfig(env = process.env) {
  return {
    starter: { label: 'Starter', events: 1, guests: 150, monthly: 0, annually: 0 },
    pro: { label: 'Pro', events: 5, guests: Infinity, monthly: int(env.PRICE_PRO_MONTHLY, 1500000), annually: int(env.PRICE_PRO_YEARLY, 15000000) },
    business: { label: 'Business', events: Infinity, guests: Infinity, monthly: int(env.PRICE_BUSINESS_MONTHLY, 4000000), annually: int(env.PRICE_BUSINESS_YEARLY, 40000000) },
    eventPrice: int(env.PRICE_EVENT, 2000000),
    asoebiFeePercent: int(env.ASOEBI_FEE_PERCENT, 1.5),
  };
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(key, 'base64'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Accounts {
  // `enforce` is off when billing isn't configured, so nobody is capped by a plan they can't buy.
  constructor(store, { enforce, plans = planConfig() }) {
    this.store = store;
    this.db = store.db;
    this.enforce = enforce;
    this.plans = plans;
    this.attempts = new Map();
  }

  // ---------- sign up, log in, sessions ----------

  async signup({ name, email, password, phone }) {
    name = String(name || '').trim().slice(0, 120);
    email = String(email || '').trim().toLowerCase();
    if (!name) throw new HttpError(400, 'Enter your name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (this.byEmail(email)) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
    const { lastInsertRowid } = this.db.prepare('INSERT INTO planners (email, name, phone, password_hash) VALUES (?, ?, ?, ?)')
      .run(email, name, normalizePhone(phone), await hashPassword(String(password)));
    return this.get(lastInsertRowid);
  }

  async login({ email, password }, ip = '') {
    email = String(email || '').trim().toLowerCase();
    const key = `${ip}|${email}`;
    const now = Date.now();
    const recent = (this.attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
    if (recent.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const p = this.byEmail(email);
    if (!p || !(await checkPassword(String(password || ''), p.password_hash))) {
      this.attempts.set(key, [...recent, now]);
      throw new HttpError(401, 'Email or password is wrong');
    }
    this.attempts.delete(key);
    return p;
  }

  createSession(plannerId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, planner_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), plannerId, new Date(Date.now() + SESSION_DAYS * DAY).toISOString());
    return token;
  }

  fromSession(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!row || row.expires_at < new Date().toISOString()) return null;
    return this.get(row.planner_id);
  }

  endSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  get(id) {
    return this.db.prepare('SELECT * FROM planners WHERE id = ?').get(id);
  }

  byEmail(email) {
    return this.db.prepare('SELECT * FROM planners WHERE email = ?').get(String(email || '').toLowerCase());
  }

  // ---------- plans and limits ----------

  // A paid plan counts only while plan_until is in the future.
  planOf(p) {
    if (!p) return 'starter';
    return p.plan !== 'starter' && p.plan_until && p.plan_until > new Date().toISOString() ? p.plan : 'starter';
  }

  limits(p) {
    return this.plans[this.planOf(p)];
  }

  events(plannerId) {
    return this.db.prepare('SELECT * FROM events WHERE planner_id = ? ORDER BY date DESC, id DESC').all(plannerId);
  }

  // Upcoming events that count against the plan; pay-per-event ones don't.
  activeEvents(plannerId) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE planner_id = ? AND date >= ? AND unlocked = 0').get(plannerId, today).n;
  }

  assertCanCreateEvent(p, date) {
    if (!this.enforce) return;
    const today = new Date().toISOString().slice(0, 10);
    if (date < today) return; // logging a past event doesn't use a slot
    const max = this.limits(p).events;
    if (this.activeEvents(p.id) >= max) {
      throw new HttpError(402, `Your ${this.plans[this.planOf(p)].label} plan allows ${max} upcoming event${max === 1 ? '' : 's'} at a time. Upgrade, or unlock an event on its own.`);
    }
  }

  guestCap(event) {
    if (!this.enforce || !event.planner_id || event.unlocked) return Infinity;
    return this.limits(this.get(event.planner_id)).guests;
  }

  assertGuestRoom(event, adding = 1) {
    const cap = this.guestCap(event);
    if (cap === Infinity) return;
    const have = this.db.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').get(event.id).n;
    if (have + adding > cap) {
      throw new HttpError(402, `The free plan allows ${cap} guests per event (you have ${have}). Upgrade to Pro or unlock this event for unlimited guests.`);
    }
  }

  claim(p, plannerToken) {
    const ev = this.store.eventByPlannerToken(plannerToken);
    if (!ev) throw new HttpError(404, 'That planner link does not match an event');
    if (ev.planner_id && ev.planner_id !== p.id) throw new HttpError(409, 'That event already belongs to another account');
    this.db.prepare('UPDATE events SET planner_id = ? WHERE id = ?').run(p.id, ev.id);
    return ev;
  }

  // What the dashboard shows about the signed-in planner.
  me(p) {
    const plan = this.planOf(p);
    const counts = this.db.prepare('SELECT event_id, COUNT(*) AS n FROM guests WHERE event_id IN (SELECT id FROM events WHERE planner_id = ?) GROUP BY event_id').all(p.id);
    const guestsBy = Object.fromEntries(counts.map((c) => [c.event_id, c.n]));
    const fmt = (n) => (n === Infinity ? null : n);
    return {
      planner: { id: p.id, name: p.name, email: p.email, phone: p.phone, created_at: p.created_at },
      plan, plan_label: this.plans[plan].label, plan_interval: plan === 'starter' ? null : p.plan_interval, plan_until: plan === 'starter' ? null : p.plan_until,
      renewing: Boolean(p.subscription_code),
      limits: { events: fmt(this.limits(p).events), guests: fmt(this.limits(p).guests) },
      enforced: this.enforce,
      active_events: this.activeEvents(p.id),
      payout: p.subaccount_code ? { bank: p.payout_bank, account: p.payout_account.replace(/.(?=.{4})/g, '•'), name: p.payout_name } : null,
      events: this.events(p.id).map((e) => ({ id: e.id, name: e.name, date: e.date, venue: e.venue, type: e.type, unlocked: Boolean(e.unlocked), planner_url: `/p/${e.planner_token}`, guests: guestsBy[e.id] || 0 })),
    };
  }

  // ---------- applying payments (called once per Paystack reference) ----------

  recordOnce(reference, row) {
    const r = this.db.prepare('INSERT OR IGNORE INTO billing_payments (reference, planner_id, kind, plan, event_id, amount) VALUES (?, ?, ?, ?, ?, ?)')
      .run(reference, row.planner_id ?? null, row.kind, row.plan ?? null, row.event_id ?? null, row.amount);
    return r.changes === 1;
  }

  extendPlan(plannerId, plan, interval, customerCode) {
    const p = this.get(plannerId);
    const from = Math.max(Date.now(), p.plan === plan && p.plan_until ? Date.parse(p.plan_until) : 0);
    const days = interval === 'annually' ? 365 : 30;
    const until = new Date(from + (days + 2) * DAY).toISOString(); // two days' grace for renewal charges
    this.db.prepare('UPDATE planners SET plan = ?, plan_interval = ?, plan_until = ?, paystack_customer = COALESCE(?, paystack_customer) WHERE id = ?')
      .run(plan, interval, until, customerCode || null, plannerId);
  }

  unlockEvent(eventId) {
    this.db.prepare('UPDATE events SET unlocked = 1 WHERE id = ?').run(eventId);
  }

  setSubscription(plannerId, code) {
    this.db.prepare('UPDATE planners SET subscription_code = ? WHERE id = ?').run(code, plannerId);
  }

  byCustomer(customerCode, email) {
    return (customerCode && this.db.prepare('SELECT * FROM planners WHERE paystack_customer = ?').get(customerCode)) || (email && this.byEmail(email)) || null;
  }

  setPayout(plannerId, { subaccount_code, bank, account, name }) {
    this.db.prepare('UPDATE planners SET subaccount_code = ?, payout_bank = ?, payout_account = ?, payout_name = ? WHERE id = ?')
      .run(subaccount_code, bank, account, name, plannerId);
  }

  setting(key, value) {
    if (value === undefined) return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    return value;
  }
}

module.exports = { Accounts, planConfig };
