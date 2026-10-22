// Paystack checkout for aso-ebi orders. Only active when PAYSTACK_SECRET_KEY is set.
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

  async checkout(order, { email, callbackUrl }) {
    const data = await this.call('POST', '/transaction/initialize', {
      email,
      amount: order.amount,
      currency: 'NGN',
      reference: `ros-${order.id}-${Date.now()}`,
      callback_url: callbackUrl,
      metadata: { order_id: order.id, buyer: order.buyer_name },
    });
    return data.authorization_url;
  }

  // Returns true only when Paystack confirms this exact order was paid in full.
  async verify(reference, order) {
    const data = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return data.status === 'success' && data.amount >= order.amount && Number(data.metadata?.order_id) === order.id;
  }
}

module.exports = { Paystack };
