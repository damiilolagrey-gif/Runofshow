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

    CREATE INDEX IF NOT EXISTS cues_event ON cues(event_id, start_min);
    CREATE INDEX IF NOT EXISTS vendors_event ON vendors(event_id);
    CREATE INDEX IF NOT EXISTS activity_event ON activity(event_id, id);
  `);
  return db;
}

module.exports = { openDb };
