const crypto = require('node:crypto');

// Paystack: aso-ebi checkout, planner subscriptions, one-off event unlocks, payout subaccounts.
// Only active when PAYSTACK_SECRET_KEY is set.
class Paystack {
  constructor(secretKey, fetchImpl = fetch) {
    this.key = secretKey;
    this.fetch = fetchImpl;
  }

  async call(method, path, body) {
    const res = await this.fetch(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.status) throw new Error(data.message || `Paystack error ${res.status}`);
    return data.data;
  }

  // The buyer pays the planner's subaccount; the platform keeps its percentage and the subaccount bears Paystack's fee.
  async checkout(order, { email, callbackUrl, subaccount }) {
    const data = await this.call('POST', '/transaction/initialize', {
      email,
      amount: order.amount,
      currency: 'NGN',
      reference: `ros-${order.id}-${Date.now()}`,
      callback_url: callbackUrl,
      metadata: { kind: 'asoebi', order_id: order.id, buyer: order.buyer_name },
      ...(subaccount ? { subaccount, bearer: 'subaccount' } : {}),
    });
    return data.authorization_url;
  }

  // Returns true only when Paystack confirms this exact order was paid in full.
  async verify(reference, order) {
    const data = await this.transaction(reference);
    return data.status === 'success' && data.amount >= order.amount && Number(data.metadata?.order_id) === order.id;
  }

  initialize(body) {
    return this.call('POST', '/transaction/initialize', { currency: 'NGN', ...body });
  }

  transaction(reference) {
    return this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  }

  createPlan({ name, amount, interval }) {
    return this.call('POST', '/plan', { name, amount, interval, currency: 'NGN' });
  }

  async disableSubscription(code) {
    const sub = await this.call('GET', `/subscription/${encodeURIComponent(code)}`);
    return this.call('POST', '/subscription/disable', { code, token: sub.email_token });
  }

  banks() {
    return this.call('GET', '/bank?country=nigeria&perPage=200');
  }

  resolveAccount(accountNumber, bankCode) {
    return this.call('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  }

  saveSubaccount(existingCode, body) {
    return existingCode ? this.call('PUT', `/subaccount/${encodeURIComponent(existingCode)}`, body) : this.call('POST', '/subaccount', body);
  }

  // Webhooks are signed with HMAC-SHA512 of the raw body using the secret key.
  validSignature(rawBody, signature) {
    if (!signature) return false;
    const expected = crypto.createHmac('sha512', this.key).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

module.exports = { Paystack };
