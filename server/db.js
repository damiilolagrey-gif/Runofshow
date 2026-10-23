const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL,
      date          TEXT NOT NULL,          -- YYYY-MM-DD, local to the venue
      venue         TEXT NOT NULL DEFAULT '',
      planner_token TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id            INTEGER PRIMARY KEY,
      event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL,
      phone         TEXT NOT NULL DEFAULT '',  -- E.164 digits, used for WhatsApp
      token         TEXT NOT NULL UNIQUE,
      checked_in_at TEXT,
      push_sub      TEXT                       -- JSON PushSubscription
    );

    CREATE TABLE IF NOT EXISTS cues (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      start_min  INTEGER NOT NULL,             -- minutes after midnight on the event date (may pass 1440)
      duration   INTEGER NOT NULL DEFAULT 15,
      notes      TEXT NOT NULL DEFAULT '',
      done_at    TEXT,
      done_by    INTEGER REFERENCES vendors(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS cue_vendors (
      cue_id    INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      PRIMARY KEY (cue_id, vendor_id)
    );

    CREATE TABLE IF NOT EXISTS activity (
      id        INTEGER PRIMARY KEY,
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      kind      TEXT NOT NULL,                 -- change | checkin | done | notify
      message   TEXT NOT NULL,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      channel   TEXT,                          -- push | whatsapp | log (for notify rows)
      at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS guests (
      id          INTEGER PRIMARY KEY,
      event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL DEFAULT '',
      party_size  INTEGER NOT NULL DEFAULT 1,
      side        TEXT NOT NULL DEFAULT '',     -- e.g. Bride, Groom, Family
      table_label TEXT NOT NULL DEFAULT '',
      rsvp        TEXT NOT NULL DEFAULT 'pending', -- pending | yes | no
      rsvp_at     TEXT,
      token       TEXT NOT NULL UNIQUE,         -- private invite link
      code        TEXT NOT NULL,                -- short code inside the QR, unique per event
      arrived_at  TEXT,
      source      TEXT NOT NULL DEFAULT 'list', -- list | public
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (event_id, code)
    );

    CREATE TABLE IF NOT EXISTS asoebi_items (
      id          INTEGER PRIMARY KEY,
      event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price       INTEGER NOT NULL,             -- kobo
      options     TEXT NOT NULL DEFAULT '',     -- comma-separated sizes or colours
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS asoebi_orders (
      id           INTEGER PRIMARY KEY,
      event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      item_id      INTEGER NOT NULL REFERENCES asoebi_items(id) ON DELETE RESTRICT,
      buyer_name   TEXT NOT NULL,
      phone        TEXT NOT NULL DEFAULT '',
      option       TEXT NOT NULL DEFAULT '',
      qty          INTEGER NOT NULL DEFAULT 1,
      amount       INTEGER NOT NULL,            -- kobo, price * qty at order time
      token        TEXT NOT NULL UNIQUE,
      paid_at      TEXT,
      payment_ref  TEXT,
      collected_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS vendor_payments (
      id        INTEGER PRIMARY KEY,
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      label     TEXT NOT NULL,                  -- Deposit, Balance…
      amount    INTEGER NOT NULL,               -- kobo
      due_date  TEXT,                           -- YYYY-MM-DD
      paid_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS budget_lines (
      id        INTEGER PRIMARY KEY,
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      category  TEXT NOT NULL,
      label     TEXT NOT NULL DEFAULT '',
      planned   INTEGER NOT NULL DEFAULT 0,     -- kobo
      spent     INTEGER NOT NULL DEFAULT 0,     -- kobo, for costs not tied to a vendor
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS planners (
      id               INTEGER PRIMARY KEY,
      email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name             TEXT NOT NULL,
      phone            TEXT NOT NULL DEFAULT '',
      password_hash    TEXT NOT NULL,
      plan             TEXT NOT NULL DEFAULT 'starter', -- starter | pro | business
      plan_interval    TEXT,                            -- monthly | annually
      plan_until       TEXT,                            -- paid plan is active until this time
      paystack_customer TEXT,
      subscription_code TEXT,
      subaccount_code  TEXT,                            -- where their aso-ebi card money settles
      payout_bank      TEXT NOT NULL DEFAULT '',
      payout_account   TEXT NOT NULL DEFAULT '',
      payout_name      TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      planner_id INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    -- Every Paystack reference we've acted on, so a callback and a webhook for the same payment apply once.
    CREATE TABLE IF NOT EXISTS billing_payments (
      reference  TEXT PRIMARY KEY,
      planner_id INTEGER REFERENCES planners(id) ON DELETE SET NULL,
      kind       TEXT NOT NULL,                 -- plan | event
      plan       TEXT,
      event_id   INTEGER,
      amount     INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- The couple's rating of a vendor, written only from the couple's page so it can be shown as verified.
    CREATE TABLE IF NOT EXISTS reviews (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      vendor_id  INTEGER NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
      rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      body       TEXT NOT NULL DEFAULT '',
      reviewer   TEXT NOT NULL DEFAULT '',
      token      TEXT NOT NULL UNIQUE,      -- public share link for the review card
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- What's locked in before the day, shown to the couple as a progress view.
    CREATE TABLE IF NOT EXISTS checklist (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      category   TEXT NOT NULL,
      title      TEXT NOT NULL,
      vendor_id  INTEGER REFERENCES vendors(id) ON DELETE SET NULL, -- locks itself once this vendor accepts their agreement
      locked_at  TEXT,
      sort       INTEGER NOT NULL DEFAULT 0
    );

    -- Tables for the seating plan; guests point at one by its label (guests.table_label).
    CREATE TABLE IF NOT EXISTS seating_tables (
      id       INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      label    TEXT NOT NULL,
      seats    INTEGER NOT NULL DEFAULT 10,
      sort     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (event_id, label)
    );

    -- WhatsApp conversation with each guest, in both directions.
    CREATE TABLE IF NOT EXISTS guest_messages (
      id        INTEGER PRIMARY KEY,
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      guest_id  INTEGER REFERENCES guests(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,               -- in | out
      body      TEXT NOT NULL,
      at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS guest_messages_guest ON guest_messages(guest_id, id);

    -- WhatsApp retries webhooks, so each incoming message id is handled once.
    CREATE TABLE IF NOT EXISTS wa_inbound (id TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));

    CREATE INDEX IF NOT EXISTS checklist_event ON checklist(event_id, sort);
    CREATE INDEX IF NOT EXISTS cues_event ON cues(event_id, start_min);
    CREATE INDEX IF NOT EXISTS guests_event ON guests(event_id, name);
    CREATE INDEX IF NOT EXISTS orders_event ON asoebi_orders(event_id, id);
    CREATE INDEX IF NOT EXISTS vpay_event ON vendor_payments(event_id, vendor_id);
    CREATE INDEX IF NOT EXISTS budget_event ON budget_lines(event_id);
    CREATE INDEX IF NOT EXISTS vendors_event ON vendors(event_id);
    CREATE INDEX IF NOT EXISTS activity_event ON activity(event_id, id);
  `);
  migrate(db);
  return db;
}

// Columns added after the first release. SQLite can't ADD COLUMN IF NOT EXISTS, so check first.
function migrate(db) {
  const addColumns = (table, cols) => {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  addColumns('events', [
    ['public_token', 'TEXT'],   // RSVP and aso-ebi links anyone can open
    ['gate_token', 'TEXT'],     // usher scanner
    ['couple_token', 'TEXT'],   // couple's read-only view
    ['rsvp_open', 'INTEGER NOT NULL DEFAULT 1'],
    ['pay_details', "TEXT NOT NULL DEFAULT ''"], // bank transfer instructions shown to aso-ebi buyers
  ]);
  addColumns('vendors', [
    ['review_requested_at', 'TEXT'],
    ['fee', 'INTEGER NOT NULL DEFAULT 0'], // kobo
    ['terms', "TEXT NOT NULL DEFAULT ''"],
    ['accepted_at', 'TEXT'],
  ]);
  addColumns('events', [
    ['planner_id', 'INTEGER REFERENCES planners(id) ON DELETE SET NULL'], // null for events made before accounts
    ['unlocked', 'INTEGER NOT NULL DEFAULT 0'],                         // paid for on its own (pay-per-event)
    ['couple_names', "TEXT NOT NULL DEFAULT ''"],  // greeting on the couple's page
    ['couple_note', "TEXT NOT NULL DEFAULT ''"],   // "Note from your planner"
    ['contact_phone', "TEXT NOT NULL DEFAULT ''"], // "Message your planner" WhatsApp number
    ['guest_info', "TEXT NOT NULL DEFAULT ''"],    // dress code, parking, colours: shown on invites and used by the RSVP bot
    ['passes_auto', 'INTEGER NOT NULL DEFAULT 1'],  // send table numbers and QR passes on the morning of the event
    ['passes_time', "TEXT NOT NULL DEFAULT '09:00'"],
    ['passes_sent_at', 'TEXT'],
  ]);
  addColumns('guests', [
    ['invited_at', 'TEXT'],
    ['pass_sent_at', 'TEXT'],
    ['invited_party', 'INTEGER'], // party size on the invite, kept when the guest RSVPs for fewer
  ]);
  addColumns('vendors', [
    ['can_seat', 'INTEGER NOT NULL DEFAULT 0'], // may see the guest list and edit the table plan
  ]);
  const fill = db.prepare('UPDATE events SET public_token = ?, gate_token = ?, couple_token = ? WHERE id = ?');
  for (const { id } of db.prepare('SELECT id FROM events WHERE public_token IS NULL').all()) {
    fill.run(newToken(), newToken(), newToken(), id);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS events_public ON events(public_token);
    CREATE UNIQUE INDEX IF NOT EXISTS events_gate ON events(gate_token);
    CREATE UNIQUE INDEX IF NOT EXISTS events_couple ON events(couple_token);
  `);
}

const newToken = () => crypto.randomBytes(9).toString('base64url');

module.exports = { openDb, newToken };
