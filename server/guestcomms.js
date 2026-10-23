// WhatsApp with guests: invites, the RSVP bot that reads their replies, and passes on the day
// (table number plus the QR link they show at the gate).

const TZ = process.env.EVENT_TIMEZONE || 'Africa/Lagos';

// Today's date and the time of day where the events happen, e.g. { date: '2026-11-14', time: '09:05' }.
function localNow(now = new Date(), timeZone = TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const niceDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

class GuestComms {
  constructor({ store, guests, whatsapp, assistant, baseUrl, onChange }) {
    this.store = store;
    this.guests = guests;
    this.db = store.db;
    this.whatsapp = whatsapp;
    this.assistant = assistant;
    this.baseUrl = baseUrl;
    this.onChange = onChange;
  }

  inviteText(event, g) {
    const when = [niceDate(event.date), event.venue].filter(Boolean).join(' at ');
    const reply = this.whatsapp ? 'Reply YES or NO here to RSVP, and tell us how many of you are coming.' : 'Please RSVP at this link:';
    return `Hello ${g.name}, you're invited to ${event.name} on ${when}. ${reply}\n${this.baseUrl}/i/${g.token}`;
  }

  passText(event, g) {
    const seat = g.table_label ? `Your table is ${g.table_label}.` : 'An usher will show you to your seat.';
    return `Hi ${g.name}, today is ${event.name}! ${seat} Show the QR code at this link at the gate (admits ${g.party_size}):\n${this.baseUrl}/i/${g.token}`;
  }

  log(eventId, guestId, direction, body) {
    this.db.prepare('INSERT INTO guest_messages (event_id, guest_id, direction, body) VALUES (?, ?, ?, ?)').run(eventId, guestId, direction, body);
  }

  messages(eventId, guestId) {
    return this.db.prepare('SELECT direction, body, at FROM guest_messages WHERE event_id = ? AND guest_id = ? ORDER BY id').all(eventId, guestId);
  }

  // Latest message per guest, for the "Replies" list.
  replies(eventId, limit = 50) {
    return this.db.prepare(`SELECT m.body, m.at, g.id AS guest_id, g.name, g.rsvp, g.party_size FROM guest_messages m JOIN guests g ON g.id = m.guest_id
      WHERE m.event_id = ? AND m.direction = 'in' ORDER BY m.id DESC LIMIT ?`).all(eventId, limit);
  }

  // ---- invites ----

  inviteList(event) {
    return this.guests.list(event.id).map((g) => ({ id: g.id, name: g.name, phone: g.phone, rsvp: g.rsvp, invited_at: g.invited_at, text: this.inviteText(event, g) }));
  }

  markInvited(eventId, guestId) {
    const g = this.guests.in(eventId, Number(guestId));
    this.db.prepare('UPDATE guests SET invited_at = COALESCE(invited_at, ?) WHERE id = ?').run(new Date().toISOString(), g.id);
  }

  // Sends every guest with a number who hasn't had an invite (or hasn't replied, with resend).
  async sendInvites(event, { resend = false } = {}) {
    if (!this.whatsapp) return { sent: 0, manual: true };
    const list = this.guests.list(event.id).filter((g) => g.phone && g.rsvp === 'pending' && (resend || !g.invited_at));
    let sent = 0;
    for (const g of list) {
      const text = this.inviteText(event, g);
      if (await this.whatsapp.send(g.phone, text)) {
        this.db.prepare('UPDATE guests SET invited_at = ? WHERE id = ?').run(new Date().toISOString(), g.id);
        this.log(event.id, g.id, 'out', text);
        sent += 1;
      }
    }
    if (sent) this.onChange(event.id, 'guests');
    return { sent, failed: list.length - sent, manual: false };
  }

  // ---- passes on the day ----

  passList(event) {
    return this.guests.list(event.id).filter((g) => g.rsvp === 'yes')
      .map((g) => ({ id: g.id, name: g.name, phone: g.phone, table_label: g.table_label, party_size: g.party_size, pass_sent_at: g.pass_sent_at, text: this.passText(event, g) }));
  }

  markPassSent(eventId, guestId) {
    const g = this.guests.in(eventId, Number(guestId));
    this.db.prepare('UPDATE guests SET pass_sent_at = COALESCE(pass_sent_at, ?) WHERE id = ?').run(new Date().toISOString(), g.id);
  }

  async sendPasses(event, { resend = false } = {}) {
    if (!this.whatsapp) return { sent: 0, manual: true };
    const list = this.guests.list(event.id).filter((g) => g.rsvp === 'yes' && g.phone && (resend || !g.pass_sent_at));
    let sent = 0;
    for (const g of list) {
      const text = this.passText(event, g);
      if (await this.whatsapp.send(g.phone, text)) {
        this.db.prepare('UPDATE guests SET pass_sent_at = ? WHERE id = ?').run(new Date().toISOString(), g.id);
        this.log(event.id, g.id, 'out', text);
        sent += 1;
      }
    }
    this.db.prepare('UPDATE events SET passes_sent_at = COALESCE(passes_sent_at, ?) WHERE id = ?').run(new Date().toISOString(), event.id);
    this.onChange(event.id, 'guests');
    return { sent, failed: list.length - sent, manual: false };
  }

  // Runs every minute: on the event day, at the chosen time, passes go out by themselves.
  async tick(now = new Date()) {
    if (!this.whatsapp) return 0;
    const { date, time } = localNow(now);
    const due = this.db.prepare('SELECT * FROM events WHERE date = ? AND passes_auto = 1 AND passes_sent_at IS NULL AND passes_time <= ?').all(date, time);
    for (const ev of due) {
      const r = await this.sendPasses(ev);
      this.store.log(ev.id, 'change', `Sent ${r.sent} guests their table number and QR pass on WhatsApp`);
    }
    return due.length;
  }

  // ---- incoming WhatsApp messages (the RSVP bot) ----

  // A number can be on several guest lists; the bot answers for their next upcoming event.
  guestForPhone(phone, now = new Date()) {
    const { date } = localNow(now);
    return this.db.prepare(`SELECT g.id FROM guests g JOIN events e ON e.id = g.event_id
      WHERE g.phone = ? AND e.date >= date(?, '-1 day') ORDER BY e.date, g.id LIMIT 1`).get(phone, date);
  }

  async handleWebhook(payload) {
    const msgs = [];
    for (const entry of payload?.entry || []) {
      for (const change of entry.changes || []) {
        for (const m of change.value?.messages || []) msgs.push(m);
      }
    }
    for (const m of msgs) await this.handleMessage(m);
    return msgs.length;
  }

  async handleMessage(m) {
    if (!m?.id || !m.from) return;
    if (this.db.prepare('INSERT OR IGNORE INTO wa_inbound (id) VALUES (?)').run(String(m.id)).changes === 0) return; // retry of one we handled
    const text = m.type === 'text' ? String(m.text?.body || '').slice(0, 2000)
      : m.type === 'button' ? String(m.button?.text || '') : m.type === 'interactive' ? String(m.interactive?.button_reply?.title || '') : '';
    const phone = String(m.from).replace(/\D/g, '');
    const found = this.guestForPhone(phone);
    if (!found) {
      if (text) await this.whatsapp?.sendText(phone, "Hi! I couldn't find your invitation from this number. Please use the link in your invite, or ask the hosts to add this number.");
      return;
    }
    let guest = this.guests.get(found.id);
    const event = this.store.event(guest.event_id);
    if (!text) {
      await this.reply(event, guest, 'Thanks! I can only read text messages. Reply YES or NO to RSVP.');
      return;
    }
    const history = this.messages(event.id, guest.id).slice(-6);
    this.log(event.id, guest.id, 'in', text);

    const out = await this.assistant.read({ event, guest, text, history });
    let reply = out.reply;
    if (out.intent === 'yes') {
      const allowed = guest.invited_party || guest.party_size;
      if (!guest.invited_party) this.db.prepare('UPDATE guests SET invited_party = ? WHERE id = ?').run(allowed, guest.id);
      const asked = out.party_size || allowed;
      const size = Math.min(asked, allowed);
      guest = this.guests.rsvp(guest, { rsvp: 'yes', party_size: size });
      if (asked > size) reply += `\n\nYour invitation admits ${size} ${size === 1 ? 'person' : 'people'}, so I've confirmed ${size}. Please check with the hosts for more.`;
      this.store.log(event.id, 'change', `${guest.name} RSVPed yes on WhatsApp (${size})`);
    } else if (out.intent === 'no') {
      guest = this.guests.rsvp(guest, { rsvp: 'no' });
      this.store.log(event.id, 'change', `${guest.name} can't come (WhatsApp)`);
    }
    await this.reply(event, guest, reply);
    this.onChange(event.id, 'guests');
  }

  async reply(event, guest, text) {
    this.log(event.id, guest.id, 'out', text);
    await this.whatsapp?.sendText(guest.phone, text);
  }
}

module.exports = { GuestComms, localNow };
