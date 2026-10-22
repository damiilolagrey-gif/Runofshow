const { HttpError, normalizePhone } = require('./store');
const { newToken } = require('./db');

// All amounts are integer kobo. The browser converts to and from naira.
const kobo = (v, field = 'Amount') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e13) throw new HttpError(400, `${field} must be a whole, positive amount`);
  return n;
};
const date = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Dates must look like 2026-11-14');
  return v;
};
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();

// ---------- aso-ebi ----------

class AsoEbi {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  items(eventId, { activeOnly = false } = {}) {
    return this.db.prepare(`SELECT * FROM asoebi_items WHERE event_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY id`).all(eventId);
  }

  item(eventId, id) {
    const it = this.db.prepare('SELECT * FROM asoebi_items WHERE id = ?').get(id);
    if (!it || it.event_id !== eventId) throw new HttpError(404, 'Item not found');
    return it;
  }

  addItem(eventId, b) {
    const name = text(b.name, 120);
    if (!name) throw new HttpError(400, 'Item name is required');
    const { lastInsertRowid } = this.db.prepare('INSERT INTO asoebi_items (event_id, name, description, price, options) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, name, text(b.description, 500), kobo(b.price, 'Price'), cleanOptions(b.options));
    return lastInsertRowid;
  }

  updateItem(eventId, id, b) {
    const it = this.item(eventId, id);
    this.db.prepare('UPDATE asoebi_items SET name = ?, description = ?, price = ?, options = ?, active = ? WHERE id = ?').run(
      text(b.name ?? it.name, 120) || it.name, text(b.description ?? it.description, 500),
      b.price === undefined ? it.price : kobo(b.price, 'Price'), b.options === undefined ? it.options : cleanOptions(b.options),
      b.active === undefined ? it.active : (b.active ? 1 : 0), id,
    );
  }

  orders(eventId) {
    return this.db.prepare(`SELECT o.*, i.name AS item_name FROM asoebi_orders o JOIN asoebi_items i ON i.id = o.item_id
      WHERE o.event_id = ? ORDER BY o.id DESC`).all(eventId);
  }

  order(id) {
    return this.db.prepare('SELECT o.*, i.name AS item_name FROM asoebi_orders o JOIN asoebi_items i ON i.id = o.item_id WHERE o.id = ?').get(id);
  }

  orderIn(eventId, id) {
    const o = this.order(id);
    if (!o || o.event_id !== eventId) throw new HttpError(404, 'Order not found');
    return o;
  }

  orderByToken(token) {
    const o = this.db.prepare('SELECT id FROM asoebi_orders WHERE token = ?').get(token);
    return o ? this.order(o.id) : null;
  }

  placeOrder(event, b) {
    const it = this.item(event.id, Number(b.item_id));
    if (!it.active) throw new HttpError(400, 'This item is no longer available');
    const buyer = text(b.buyer_name, 120);
    const phone = normalizePhone(b.phone);
    if (!buyer || phone.length < 7) throw new HttpError(400, 'Name and phone number are required');
    const options = it.options ? it.options.split(',') : [];
    const option = text(b.option, 60);
    if (options.length && !options.includes(option)) throw new HttpError(400, `Choose one of: ${options.join(', ')}`);
    const qty = Math.min(50, Math.max(1, Number(b.qty) | 0 || 1));
    const { lastInsertRowid } = this.db.prepare('INSERT INTO asoebi_orders (event_id, item_id, buyer_name, phone, option, qty, amount, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(event.id, it.id, buyer, phone, option, qty, it.price * qty, newToken());
    return this.order(lastInsertRowid);
  }

  setPaid(order, paid, ref = null) {
    this.db.prepare('UPDATE asoebi_orders SET paid_at = ?, payment_ref = COALESCE(?, payment_ref) WHERE id = ?').run(paid ? order.paid_at || nowIso() : null, ref, order.id);
  }

  setCollected(order, collected) {
    this.db.prepare('UPDATE asoebi_orders SET collected_at = ? WHERE id = ?').run(collected ? order.collected_at || nowIso() : null, order.id);
  }

  removeOrder(eventId, id) {
    this.orderIn(eventId, id);
    this.db.prepare('DELETE FROM asoebi_orders WHERE id = ?').run(id);
  }

  stats(eventId) {
    return { ...this.db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(qty), 0) AS pieces, COALESCE(SUM(amount), 0) AS ordered,
      COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN amount END), 0) AS paid,
      COALESCE(SUM(paid_at IS NOT NULL), 0) AS paid_orders, COALESCE(SUM(collected_at IS NOT NULL), 0) AS collected
      FROM asoebi_orders WHERE event_id = ?`).get(eventId) };
  }
}

const cleanOptions = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30).join(',');

// ---------- vendor payments and budget ----------

class Finance {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  setVendorDeal(eventId, vendorId, b) {
    const v = this.store.vendorIn(eventId, vendorId);
    const terms = b.terms === undefined ? v.terms : text(b.terms, 4000);
    const fee = b.fee === undefined ? v.fee : kobo(b.fee, 'Fee');
    // Changing what the vendor agreed to means they need to accept again.
    const reaccept = terms !== v.terms || fee !== v.fee;
    this.db.prepare('UPDATE vendors SET fee = ?, terms = ?, accepted_at = CASE WHEN ? THEN NULL ELSE accepted_at END WHERE id = ?').run(fee, terms, reaccept ? 1 : 0, v.id);
  }

  accept(vendor) {
    if (!vendor.terms && !vendor.fee) throw new HttpError(400, 'There is no agreement to accept yet');
    if (vendor.accepted_at) return false;
    this.db.prepare('UPDATE vendors SET accepted_at = ? WHERE id = ?').run(nowIso(), vendor.id);
    return true;
  }

  payments(eventId, vendorId = null) {
    return vendorId
      ? this.db.prepare('SELECT * FROM vendor_payments WHERE vendor_id = ? ORDER BY due_date IS NULL, due_date, id').all(vendorId)
      : this.db.prepare('SELECT * FROM vendor_payments WHERE event_id = ? ORDER BY due_date IS NULL, due_date, id').all(eventId);
  }

  paymentIn(eventId, id) {
    const p = this.db.prepare('SELECT * FROM vendor_payments WHERE id = ?').get(id);
    if (!p || p.event_id !== eventId) throw new HttpError(404, 'Payment not found');
    return p;
  }

  addPayment(eventId, b) {
    const v = this.store.vendorIn(eventId, Number(b.vendor_id));
    const label = text(b.label, 80) || 'Payment';
    this.db.prepare('INSERT INTO vendor_payments (event_id, vendor_id, label, amount, due_date, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventId, v.id, label, kobo(b.amount), date(b.due_date), b.paid ? nowIso() : null);
  }

  updatePayment(eventId, id, b) {
    const p = this.paymentIn(eventId, id);
    const paidAt = b.paid === undefined ? p.paid_at : b.paid ? p.paid_at || nowIso() : null;
    this.db.prepare('UPDATE vendor_payments SET label = ?, amount = ?, due_date = ?, paid_at = ? WHERE id = ?').run(
      text(b.label ?? p.label, 80) || p.label, b.amount === undefined ? p.amount : kobo(b.amount),
      b.due_date === undefined ? p.due_date : date(b.due_date), paidAt, id,
    );
    return { before: p, after: this.paymentIn(eventId, id) };
  }

  removePayment(eventId, id) {
    this.paymentIn(eventId, id);
    this.db.prepare('DELETE FROM vendor_payments WHERE id = ?').run(id);
  }

  budgetLines(eventId) {
    return this.db.prepare('SELECT * FROM budget_lines WHERE event_id = ? ORDER BY category COLLATE NOCASE, id').all(eventId);
  }

  lineIn(eventId, id) {
    const l = this.db.prepare('SELECT * FROM budget_lines WHERE id = ?').get(id);
    if (!l || l.event_id !== eventId) throw new HttpError(404, 'Budget line not found');
    return l;
  }

  addLine(eventId, b) {
    const category = text(b.category, 60);
    if (!category) throw new HttpError(400, 'Category is required');
    const vendorId = b.vendor_id ? this.store.vendorIn(eventId, Number(b.vendor_id)).id : null;
    this.db.prepare('INSERT INTO budget_lines (event_id, category, label, planned, spent, vendor_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventId, category, text(b.label, 120), kobo(b.planned ?? 0, 'Planned'), kobo(b.spent ?? 0, 'Spent'), vendorId);
  }

  updateLine(eventId, id, b) {
    const l = this.lineIn(eventId, id);
    const vendorId = b.vendor_id === undefined ? l.vendor_id : b.vendor_id ? this.store.vendorIn(eventId, Number(b.vendor_id)).id : null;
    this.db.prepare('UPDATE budget_lines SET category = ?, label = ?, planned = ?, spent = ?, vendor_id = ? WHERE id = ?').run(
      text(b.category ?? l.category, 60) || l.category, text(b.label ?? l.label, 120),
      b.planned === undefined ? l.planned : kobo(b.planned, 'Planned'), b.spent === undefined ? l.spent : kobo(b.spent, 'Spent'), vendorId, id,
    );
  }

  removeLine(eventId, id) {
    this.lineIn(eventId, id);
    this.db.prepare('DELETE FROM budget_lines WHERE id = ?').run(id);
  }

  // Vendor-linked lines take their committed and paid figures from the vendor's fee and payments.
  summary(eventId) {
    const vendors = this.store.vendors(eventId);
    const payments = this.payments(eventId);
    const today = new Date().toISOString().slice(0, 10);
    const perVendor = vendors.map((v) => {
      const ps = payments.filter((p) => p.vendor_id === v.id);
      const paid = ps.filter((p) => p.paid_at).reduce((s, p) => s + p.amount, 0);
      const scheduled = ps.reduce((s, p) => s + p.amount, 0);
      // Payments logged without a fee still count as money committed to that vendor.
      const owed = Math.max(v.fee, scheduled);
      return {
        vendor_id: v.id, name: v.name, role: v.role, fee: owed, agreed_fee: v.fee, terms: v.terms, accepted_at: v.accepted_at,
        paid, balance: Math.max(0, owed - paid), unscheduled: Math.max(0, v.fee - scheduled),
        overdue: ps.filter((p) => !p.paid_at && p.due_date && p.due_date < today).reduce((s, p) => s + p.amount, 0),
        payments: ps,
      };
    });
    const byVendor = Object.fromEntries(perVendor.map((v) => [v.vendor_id, v]));
    const lines = this.budgetLines(eventId).map((l) => {
      const v = l.vendor_id && byVendor[l.vendor_id];
      return { ...l, committed: v ? v.fee : l.spent, paid: v ? v.paid : l.spent, vendor_name: v ? `${v.name}` : null };
    });
    // Vendors with a fee but no budget line still count, so the totals never hide a commitment.
    const linked = new Set(lines.map((l) => l.vendor_id).filter(Boolean));
    const unlinked = perVendor.filter((v) => v.fee && !linked.has(v.vendor_id));
    const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
    const upcoming = payments.filter((p) => !p.paid_at).map((p) => ({ ...p, vendor: byVendor[p.vendor_id]?.name, overdue: Boolean(p.due_date && p.due_date < today) }));
    return {
      vendors: perVendor,
      lines,
      unlinked: unlinked.map((v) => ({ vendor_id: v.vendor_id, name: v.name, role: v.role, committed: v.fee, paid: v.paid })),
      upcoming,
      totals: {
        planned: sum(lines, 'planned'),
        committed: sum(lines, 'committed') + sum(unlinked, 'fee'),
        paid: sum(lines, 'paid') + sum(unlinked, 'paid'),
        owed_to_vendors: sum(perVendor, 'balance'),
        overdue: sum(perVendor, 'overdue'),
      },
    };
  }
}

module.exports = { AsoEbi, Finance };
