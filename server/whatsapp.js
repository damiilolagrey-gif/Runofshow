// WhatsApp Cloud API (Meta): outgoing messages and the incoming-message webhook signature.
const crypto = require('node:crypto');

class WhatsApp {
  // config: { token, phoneNumberId, template, lang, appSecret, verifyToken }
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  // A reply inside the 24h window after a guest writes in can be plain text.
  sendText(to, text) {
    return this.post({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } });
  }

  // Messages we start (invites, passes, vendor alerts) need an approved template outside that window.
  // WHATSAPP_TEMPLATE is a template whose body is one variable ({{1}}), so it can carry any text.
  send(to, text) {
    const { template, lang = 'en' } = this.config;
    if (!template) return this.sendText(to, text);
    return this.post({ messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } });
  }

  async post(body) {
    try {
      const res = await this.fetch(`https://graph.facebook.com/v21.0/${this.config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.warn(`whatsapp to ${body.to} failed:`, res.status, await res.text());
      return res.ok;
    } catch (err) {
      console.warn(`whatsapp to ${body.to} failed:`, err.message);
      return false;
    }
  }

  validSignature(raw, header) {
    if (!this.config.appSecret || !header) return false;
    const expected = `sha256=${crypto.createHmac('sha256', this.config.appSecret).update(raw).digest('hex')}`;
    return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  }
}

module.exports = { WhatsApp };
