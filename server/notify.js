const webpush = require('web-push');
const { fmtTime, fmtShift } = require('../public/js/time');

// Turns timeline changes into one message per affected vendor, then sends it on every channel that vendor has.
class Notifier {
  constructor(store, { vapid, whatsapp, baseUrl, fetchImpl = fetch } = {}) {
    this.store = store;
    this.vapid = vapid;
    this.whatsapp = whatsapp; // { token, phoneNumberId, template, lang } or null
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
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

  // WhatsApp Cloud API. Messages outside a 24h customer window must use an approved template,
  // so set WHATSAPP_TEMPLATE to a template with one body variable ({{1}}) for production.
  async sendWhatsApp(vendor, text) {
    const { token, phoneNumberId, template, lang = 'en' } = this.whatsapp;
    const body = template
      ? { messaging_product: 'whatsapp', to: vendor.phone, type: 'template', template: { name: template, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
      : { messaging_product: 'whatsapp', to: vendor.phone, type: 'text', text: { body: `${text}\n${this.baseUrl}/v/${vendor.token}` } };
    try {
      const res = await this.fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.warn(`whatsapp to vendor ${vendor.id} failed:`, res.status, await res.text());
      return res.ok;
    } catch (err) {
      console.warn(`whatsapp to vendor ${vendor.id} failed:`, err.message);
      return false;
    }
  }
}

module.exports = { Notifier };
