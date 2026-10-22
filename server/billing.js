// Planner accounts: sign up / log in, dashboard data, subscriptions, pay-per-event, aso-ebi payouts.
const path = require('node:path');
const express = require('express');
const { HttpError } = require('./store');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'ros_session';

function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function mountBilling(app, { store, accounts, paystack, asoebi }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC, file));
  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const plans = accounts.plans;

  const setSession = (req, res, plannerId) => {
    res.cookie(COOKIE, accounts.createSession(plannerId), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 864e5, path: '/',
    });
  };

  // Every request learns who is signed in, if anyone.
  app.use((req, _res, next) => {
    req.planner = accounts.fromSession(readCookie(req, COOKIE));
    next();
  });
  const needLogin = (req, _res, next) => next(req.planner ? undefined : new HttpError(401, 'Please log in'));

  for (const p of ['/signup', '/login']) app.get(p, page('account.html'));
  app.get('/dashboard', (req, res) => (req.planner ? res.sendFile(path.join(PUBLIC, 'dashboard.html')) : res.redirect('/login?next=/dashboard')));
  app.get('/pricing', page('pricing.html'));

  const priceList = () => ({
    enabled: Boolean(paystack),
    plans: ['starter', 'pro', 'business'].map((id) => ({
      id, label: plans[id].label, monthly: plans[id].monthly, annually: plans[id].annually,
      events: plans[id].events === Infinity ? null : plans[id].events, guests: plans[id].guests === Infinity ? null : plans[id].guests,
    })),
    event_price: plans.eventPrice,
    asoebi_fee_percent: plans.asoebiFeePercent,
  });
  app.get('/api/pricing', (_req, res) => res.json(priceList()));

  const acct = express.Router();
  acct.use(express.json({ limit: '20kb' }));
  acct.post('/signup', wrap(async (req, res) => {
    const p = await accounts.signup(req.body || {});
    setSession(req, res, p.id);
    res.status(201).json({ ok: true });
  }));
  acct.post('/login', wrap(async (req, res) => {
    const p = await accounts.login(req.body || {}, req.ip);
    setSession(req, res, p.id);
    res.json({ ok: true });
  }));
  acct.post('/logout', (req, res) => {
    accounts.endSession(readCookie(req, COOKIE));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  acct.get('/me', needLogin, (req, res) => res.json({ ...accounts.me(req.planner), pricing: priceList() }));
  acct.post('/claim', needLogin, (req, res) => {
    const token = String(req.body?.link || '').trim().split('/p/').pop().split(/[/?#]/)[0];
    const ev = accounts.claim(req.planner, token);
    res.json({ ok: true, name: ev.name });
  });

  // ---------- subscriptions ----------

  // Paystack plans are created on first use and remembered, one per price, so changing a price makes a new plan.
  async function planCode(plan, interval) {
    const amount = plans[plan][interval];
    const key = `paystack_plan:${plan}:${interval}:${amount}`;
    const known = accounts.setting(key);
    if (known) return known;
    const created = await paystack.createPlan({ name: `Run of Show ${plans[plan].label} (${interval})`, amount, interval });
    return accounts.setting(key, created.plan_code);
  }

  const needBilling = (_req, _res, next) => next(paystack ? undefined : new HttpError(503, 'Payments are not set up yet'));

  acct.post('/subscribe', needLogin, needBilling, wrap(async (req, res) => {
    const plan = req.body?.plan;
    const interval = req.body?.interval === 'annually' ? 'annually' : 'monthly';
    if (!['pro', 'business'].includes(plan)) throw new HttpError(400, 'Choose Pro or Business');
    const data = await paystack.initialize({
      email: req.planner.email,
      amount: plans[plan][interval],
      plan: await planCode(plan, interval),
      callback_url: `${origin(req)}/api/billing/callback`,
      metadata: { kind: 'plan', planner_id: req.planner.id, plan, interval },
    });
    res.json({ pay_url: data.authorization_url });
  }));

  acct.post('/cancel', needLogin, needBilling, wrap(async (req, res) => {
    if (!req.planner.subscription_code) throw new HttpError(400, 'There is no renewing subscription');
    await paystack.disableSubscription(req.planner.subscription_code);
    accounts.setSubscription(req.planner.id, null);
    res.json({ ok: true, until: req.planner.plan_until });
  }));

  acct.post('/unlock-event', needLogin, needBilling, wrap(async (req, res) => {
    const ev = store.event(Number(req.body?.event_id));
    if (!ev || ev.planner_id !== req.planner.id) throw new HttpError(404, 'Event not found');
    if (ev.unlocked) throw new HttpError(400, 'This event is already unlocked');
    const data = await paystack.initialize({
      email: req.planner.email,
      amount: plans.eventPrice,
      callback_url: `${origin(req)}/api/billing/callback`,
      metadata: { kind: 'event', planner_id: req.planner.id, event_id: ev.id },
    });
    res.json({ pay_url: data.authorization_url });
  }));

  // ---------- aso-ebi payouts: the planner's own bank account as a Paystack subaccount ----------

  let bankCache = null;
  acct.get('/banks', needLogin, needBilling, wrap(async (_req, res) => {
    bankCache ||= (await paystack.banks()).map((b) => ({ code: b.code, name: b.name }));
    res.json(bankCache);
  }));
  acct.post('/payout', needLogin, needBilling, wrap(async (req, res) => {
    const bankCode = String(req.body?.bank_code || '');
    const account = String(req.body?.account_number || '').replace(/\D/g, '');
    if (!bankCode || account.length !== 10) throw new HttpError(400, 'Choose a bank and enter your 10-digit account number');
    let resolved;
    try { resolved = await paystack.resolveAccount(account, bankCode); }
    catch { throw new HttpError(400, 'Could not find that account. Check the number and bank.'); }
    const bankName = (bankCache || []).find((b) => b.code === bankCode)?.name || bankCode;
    const sub = await paystack.saveSubaccount(req.planner.subaccount_code, {
      business_name: req.planner.name, settlement_bank: bankCode, account_number: account,
      percentage_charge: plans.asoebiFeePercent, primary_contact_email: req.planner.email,
    });
    accounts.setPayout(req.planner.id, { subaccount_code: sub.subaccount_code || req.planner.subaccount_code, bank: bankName, account, name: resolved.account_name });
    res.json({ ok: true, name: resolved.account_name });
  }));
  app.use('/api/account', acct);

  // ---------- applying payments ----------

  // Shared by the browser callback and the webhook. Trusts only what Paystack's own records say.
  function apply(tx) {
    if (tx.status !== 'success') return false;
    const m = tx.metadata || {};
    const p = accounts.get(Number(m.planner_id)) || accounts.byCustomer(tx.customer?.customer_code, tx.customer?.email);
    if (!p) return false;
    if (m.kind === 'event') {
      const ev = store.event(Number(m.event_id));
      if (!ev || ev.planner_id !== p.id || tx.amount < plans.eventPrice) return false;
      if (accounts.recordOnce(tx.reference, { planner_id: p.id, kind: 'event', event_id: ev.id, amount: tx.amount })) accounts.unlockEvent(ev.id);
      return true;
    }
    // First payment carries our metadata; renewals carry only the Paystack plan, so map it back.
    let { plan, interval } = m;
    if (!plan && tx.plan) {
      const code = typeof tx.plan === 'string' ? tx.plan : tx.plan.plan_code;
      for (const id of ['pro', 'business']) for (const iv of ['monthly', 'annually']) {
        if (accounts.setting(`paystack_plan:${id}:${iv}:${plans[id][iv]}`) === code) { plan = id; interval = iv; }
      }
    }
    if (!['pro', 'business'].includes(plan) || tx.amount < plans[plan][interval]) return false;
    if (accounts.recordOnce(tx.reference, { planner_id: p.id, kind: 'plan', plan, amount: tx.amount })) {
      accounts.extendPlan(p.id, plan, interval, tx.customer?.customer_code);
    }
    return true;
  }

  app.get('/api/billing/callback', wrap(async (req, res) => {
    let ok = false;
    if (paystack && req.query.reference) {
      try { ok = apply(await paystack.transaction(String(req.query.reference))); } catch { ok = false; }
    }
    res.redirect(`/dashboard?billing=${ok ? 'ok' : 'failed'}`);
  }));

  // Raw body is needed to check the signature, so this route parses its own body.
  app.post('/api/paystack/webhook', express.raw({ type: '*/*', limit: '200kb' }), wrap(async (req, res) => {
    if (!paystack || !paystack.validSignature(req.body, req.get('x-paystack-signature'))) return res.status(401).end();
    const evt = JSON.parse(req.body.toString('utf8'));
    const d = evt.data || {};
    if (evt.event === 'charge.success' && d.reference) {
      // Re-fetch from Paystack rather than trusting the payload's amounts.
      const tx = await paystack.transaction(d.reference).catch(() => null);
      if (tx?.metadata?.kind === 'asoebi') {
        // Covers buyers who closed the tab before Paystack redirected them back.
        const order = asoebi.order(Number(tx.metadata.order_id));
        if (order && !order.paid_at && tx.status === 'success' && tx.amount >= order.amount) asoebi.setPaid(order, true, tx.reference);
      } else if (tx) {
        apply(tx);
      }
    } else if (evt.event === 'subscription.create' && d.subscription_code) {
      const p = accounts.byCustomer(d.customer?.customer_code, d.customer?.email);
      if (p) accounts.setSubscription(p.id, d.subscription_code);
    } else if (['subscription.disable', 'subscription.not_renew'].includes(evt.event)) {
      const p = accounts.byCustomer(d.customer?.customer_code, d.customer?.email);
      if (p && p.subscription_code === d.subscription_code) accounts.setSubscription(p.id, null);
    }
    res.sendStatus(200);
  }));
}

module.exports = { mountBilling, readCookie };
