const webpush = require('web-push');
const { fmtTime, fmtShift } = require('../public/js/time');

// Turns timeline changes into one message per affected vendor, then sends it on every channel that vendor has.
class Notifier {
  constructor(store, { vapid, whatsapp, baseUrl } = {}) {
    this.store = store;
    this.vapid = vapid;
    this.whatsapp = whatsapp; // a WhatsApp client, or null
    this.baseUrl = baseUrl;
    if (vapid) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  messagesForMoves(event, { moves = [], shift = null, addedVendors = [], cueId = null }) {
    const perVendor = new Map();
    for (const m of moves) {
      for (const vid of this.store.cueVendorIds(m.cueId)) {
        if (!perVendor.has(vid)) perVendor.set(vid, []);
        perVendor.get(vid).push(m);
      }
    }
    const out = [];
    for (const [vid, ms] of perVendor) {
      let text;
      if (shift && ms.length > 1) {
        const list = ms.slice(0, 4).map((m) => `${m.title} ${fmtTime(m.to)}`).join(', ');
        text = `Timeline moved ${fmtShift(shift)}. Your cues now: ${list}${ms.length > 4 ? ` and ${ms.length - 4} more` : ''}.`;
      } else {
        const m = ms[0];
        text = m.from === null ? `New cue for you: "${m.title}" at ${fmtTime(m.to)}.` : `"${m.title}" moved to ${fmtTime(m.to)} (was ${fmtTime(m.from)}).`;
      }
      out.push({ vendorId: vid, text });
    }
    if (cueId && addedVendors.length) {
      const c = this.store.cue(cueId);
      for (const vid of addedVendors) {
        if (!perVendor.has(vid)) out.push({ vendorId: vid, text: `You've been added to "${c.title}" at ${fmtTime(c.start_min)}.` });
      }
    }
    return out.map((m) => ({ ...m, text: `${event.name}: ${m.text}` }));
  }

  messagesForRemoval(event, { cue, vendorIds }) {
    return vendorIds.map((vendorId) => ({ vendorId, text: `${event.name}: "${cue.title}" (${fmtTime(cue.start_min)}) has been cancelled.` }));
  }

  // Logs each message first so the planner sees it even if a channel fails.
  async send(messages) {
    await Promise.all(messages.map(async ({ vendorId, text }) => {
      const vendor = this.store.vendor(vendorId);
      if (!vendor) return;
      const channels = [];
      if (vendor.push_sub && this.vapid) channels.push(this.sendPush(vendor, text).then((ok) => ok && 'push'));
      if (vendor.phone && this.whatsapp) channels.push(this.sendWhatsApp(vendor, text).then((ok) => ok && 'whatsapp'));
      const sent = (await Promise.all(channels)).filter(Boolean);
      this.store.log(vendor.event_id, 'notify', text, vendor.id, sent.join(',') || 'log');
    }));
  }

  async sendPush(vendor, text) {
    try {
      await webpush.sendNotification(JSON.parse(vendor.push_sub), JSON.stringify({
        title: 'Run-of-show update', body: text, url: `/v/${vendor.token}`,
      }));
      return true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) this.store.savePushSub(vendor, null);
      console.warn(`push to vendor ${vendor.id} failed:`, err.statusCode || err.message);
      return false;
    }
  }

  sendWhatsApp(vendor, text) {
    // With a template the link has to be part of the one variable; plain text can carry it too.
    return this.whatsapp.send(vendor.phone, `${text}\n${this.baseUrl}/v/${vendor.token}`);
  }
}

module.exports = { Notifier };
