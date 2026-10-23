// The table plan: named tables with a seat count, and guests placed at one by its label.
const { HttpError } = require('./store');

class Seating {
  constructor(store, guests) {
    this.store = store;
    this.guests = guests;
    this.db = store.db;
  }

  tables(eventId) {
    return this.db.prepare('SELECT id, label, seats FROM seating_tables WHERE event_id = ? ORDER BY sort, id').all(eventId);
  }

  // Everyone who is coming or hasn't replied; people who said no don't need a seat.
  plan(eventId) {
    const guests = this.db.prepare("SELECT id, name, party_size, side, table_label, rsvp FROM guests WHERE event_id = ? AND rsvp != 'no' ORDER BY side, name COLLATE NOCASE").all(eventId);
    const tables = this.tables(eventId).map((t) => {
      const at = guests.filter((g) => g.table_label === t.label);
      return { ...t, seated: at.reduce((s, g) => s + g.party_size, 0), guests: at.length };
    });
    const known = new Set(tables.map((t) => t.label));
    const people = (list) => list.reduce((s, g) => s + g.party_size, 0);
    const coming = guests.filter((g) => g.rsvp === 'yes');
    return {
      tables,
      guests,
      stats: {
        tables: tables.length,
        seats: tables.reduce((s, t) => s + t.seats, 0),
        coming_people: people(coming),
        seated_people: people(coming.filter((g) => g.table_label)),
        unseated_people: people(coming.filter((g) => !g.table_label)),
        unknown_tables: [...new Set(guests.map((g) => g.table_label).filter((l) => l && !known.has(l)))],
      },
    };
  }

  table(eventId, id) {
    const t = this.db.prepare('SELECT * FROM seating_tables WHERE id = ? AND event_id = ?').get(id, eventId);
    if (!t) throw new HttpError(404, 'Table not found');
    return t;
  }

  addTable(eventId, b) {
    const label = cleanLabel(b.label);
    const seats = cleanSeats(b.seats);
    const { n } = this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM seating_tables WHERE event_id = ?').get(eventId);
    try {
      return this.db.prepare('INSERT INTO seating_tables (event_id, label, seats, sort) VALUES (?, ?, ?, ?)').run(eventId, label, seats, n).lastInsertRowid;
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(400, `There is already a table called "${label}"`);
      throw err;
    }
  }

  // Adds tables 1..count (skipping labels that exist) so a planner can start with "30 tables of 10".
  addMany(eventId, { count, seats }) {
    const n = Math.min(200, Math.max(1, Number(count) | 0));
    const have = new Set(this.tables(eventId).map((t) => t.label));
    let added = 0;
    this.store.tx(() => {
      for (let i = 1; added < n && i <= 500; i++) {
        if (have.has(String(i))) continue;
        this.addTable(eventId, { label: String(i), seats });
        added += 1;
      }
    });
    return added;
  }

  // Renaming a table moves its guests with it.
  updateTable(eventId, id, b) {
    const t = this.table(eventId, id);
    const label = b.label === undefined ? t.label : cleanLabel(b.label);
    const seats = b.seats === undefined ? t.seats : cleanSeats(b.seats);
    this.store.tx(() => {
      try {
        this.db.prepare('UPDATE seating_tables SET label = ?, seats = ? WHERE id = ?').run(label, seats, t.id);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw new HttpError(400, `There is already a table called "${label}"`);
        throw err;
      }
      if (label !== t.label) this.db.prepare('UPDATE guests SET table_label = ? WHERE event_id = ? AND table_label = ?').run(label, eventId, t.label);
    });
  }

  removeTable(eventId, id) {
    const t = this.table(eventId, id);
    this.store.tx(() => {
      this.db.prepare("UPDATE guests SET table_label = '' WHERE event_id = ? AND table_label = ?").run(eventId, t.label);
      this.db.prepare('DELETE FROM seating_tables WHERE id = ?').run(t.id);
    });
  }

  seat(eventId, guestId, label) {
    const g = this.guests.in(eventId, Number(guestId));
    const value = String(label ?? '').trim().slice(0, 40);
    this.db.prepare('UPDATE guests SET table_label = ? WHERE id = ?').run(value, g.id);
    return g;
  }

  // Fills empty seats with unseated guests who are coming, keeping each side together and each party at one table.
  autoSeat(eventId) {
    const { tables, guests } = this.plan(eventId);
    if (!tables.length) throw new HttpError(400, 'Add some tables first');
    const free = new Map(tables.map((t) => [t.label, t.seats - t.seated]));
    const sideOf = new Map();
    for (const g of guests) if (g.table_label && g.side) sideOf.set(g.table_label, g.side);
    const waiting = guests.filter((g) => g.rsvp === 'yes' && !g.table_label).sort((a, b) => a.side.localeCompare(b.side) || b.party_size - a.party_size);
    const update = this.db.prepare('UPDATE guests SET table_label = ? WHERE id = ?');
    let seated = 0;
    this.store.tx(() => {
      for (const g of waiting) {
        const fits = tables.filter((t) => free.get(t.label) >= g.party_size);
        const pick = fits.find((t) => sideOf.get(t.label) === g.side) || fits.find((t) => !sideOf.has(t.label)) || fits[0];
        if (!pick) continue;
        update.run(pick.label, g.id);
        free.set(pick.label, free.get(pick.label) - g.party_size);
        if (g.side && !sideOf.has(pick.label)) sideOf.set(pick.label, g.side);
        seated += 1;
      }
    });
    return { seated, left: waiting.length - seated };
  }
}

function cleanLabel(v) {
  const label = String(v ?? '').trim().slice(0, 40);
  if (!label) throw new HttpError(400, 'Give the table a name or number');
  return label;
}
const cleanSeats = (v) => Math.min(100, Math.max(1, Number(v) | 0 || 10));

module.exports = { Seating };
