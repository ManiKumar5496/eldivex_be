/**
 * accountsCalc.js — money / date helpers shared by the accounts and bookings
 * controllers.
 *
 * Everything here is pure except computeCancellationSettlement, which only
 * reads through the knex connection or transaction the caller passes in (so it
 * sees the caller's locks). No module-level database access.
 *
 * Dates: edx_* date columns are VARCHAR and hold 'YYYY-MM-DD', 'YYYY-MM-DD
 * HH:mm:ss' or ISO strings. parseLocalDate() turns any of them into a local
 * midnight Date; formatLocalDate() turns a Date back into 'YYYY-MM-DD' using the
 * LOCAL calendar (never toISOString(), which is a day behind in IST evenings).
 */

const { BOOKING_STATUS } = require('./bookingStatus');

// Two money figures closer than this are treated as equal (half a paisa).
const MONEY_EPS = 0.005;

const round2 = (n) => {
  const v = Number(n) || 0;
  return Math.round((v + (v >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
};

// Money input → finite Number, or null when it is missing / not a number.
// Callers decide the range (> 0, ≥ 0) and answer 400 on null.
function parseMoney(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Any stored/request date → local midnight Date, or null when unparseable.
function parseLocalDate(value) {
  if (value === null || value === undefined || value === '' || value === 'NA') return null;
  let d;
  if (value instanceof Date) {
    d = value;
  } else {
    const s = String(value).trim();
    const m = DATE_ONLY.exec(s);
    if (m) {
      d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      // Reject overflow such as 2026-02-31.
      return d.getMonth() === Number(m[2]) - 1 ? d : null;
    }
    d = new Date(s); // 'YYYY-MM-DD HH:mm:ss' parses as local, ISO 'Z' as UTC
  }
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatLocalDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Whole days from start to end, both included (DST-safe).
const daysInclusive = (start, end) => Math.round((end - start) / 86400000) + 1;

/**
 * Day ranges inside [from, to] (inclusive local dates) not touched by any of
 * the `covered` intervals ({ start, end } inclusive Dates).
 * Returns [{ start, end, days }] in date order.
 */
function uncoveredSegments(from, to, covered) {
  if (!from || !to || to < from) return [];
  const clipped = (covered || [])
    .filter((c) => c && c.start && c.end && c.end >= c.start && c.end >= from && c.start <= to)
    .map((c) => ({ start: c.start < from ? from : c.start, end: c.end > to ? to : c.end }))
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = from;
  for (const c of clipped) {
    if (c.start > cursor) gaps.push({ start: cursor, end: addDays(c.start, -1) });
    const next = addDays(c.end, 1);
    if (next > cursor) cursor = next;
  }
  if (cursor <= to) gaps.push({ start: cursor, end: to });
  return gaps.map((g) => ({ ...g, days: daysInclusive(g.start, g.end) }));
}

/**
 * Per-invoice paid / credited / balance.
 *
 *   invoices      [{ id, booking_id, inv_start, inv_raised_amnt }]
 *   receipts      [{ booking_id, invoice_id, total_amount }]   approved only
 *   applications  [{ target_invoice_id, amount_applied }]      APPLIED only
 *
 * APPLIED credit-note applications reduce their invoice first. A receipt that
 * names an invoice of its own booking pays that invoice (up to its open
 * amount); unlinked receipts and any overflow are spread FIFO over the
 * booking's invoices ordered by inv_start, id. Money left after the last
 * invoice is unallocated client credit and is not attached to any invoice.
 *
 * Returns Map(String(invoice id) → { amount, paid, credited, balance }).
 */
function allocateInvoicePayments(invoices, receipts, applications) {
  const byId = new Map();
  const byBooking = new Map();
  for (const inv of invoices || []) {
    const e = {
      id: inv.id,
      booking_id: inv.booking_id,
      start: parseLocalDate(inv.inv_start),
      amount: round2(inv.inv_raised_amnt),
      paid: 0,
      credited: 0,
      direct: 0,
    };
    byId.set(String(inv.id), e);
    const key = String(inv.booking_id);
    if (!byBooking.has(key)) byBooking.set(key, []);
    byBooking.get(key).push(e);
  }

  for (const a of applications || []) {
    const e = byId.get(String(a.target_invoice_id));
    if (e) e.credited = round2(e.credited + (Number(a.amount_applied) || 0));
  }

  const pool = new Map(); // booking → money not tied to one of its invoices
  const addPool = (bookingKey, amt) => pool.set(bookingKey, round2((pool.get(bookingKey) || 0) + amt));
  for (const r of receipts || []) {
    const amt = Number(r.total_amount) || 0;
    const e = r.invoice_id != null ? byId.get(String(r.invoice_id)) : null;
    if (e && String(e.booking_id) === String(r.booking_id)) e.direct = round2(e.direct + amt);
    else addPool(String(r.booking_id), amt);
  }

  for (const [bookingKey, list] of byBooking) {
    // Direct receipts first, overflow back to the booking pool.
    for (const e of list) {
      const open = Math.max(0, round2(e.amount - e.credited));
      const applied = Math.min(e.direct, open);
      e.paid = round2(applied);
      if (e.direct - applied > 0) addPool(bookingKey, round2(e.direct - applied));
    }
    // FIFO over the remaining open amounts.
    list.sort((a, b) => {
      const at = a.start ? a.start.getTime() : Infinity;
      const bt = b.start ? b.start.getTime() : Infinity;
      if (at !== bt) return at - bt;
      return Number(a.id) - Number(b.id);
    });
    let left = pool.get(bookingKey) || 0;
    for (const e of list) {
      if (left <= 0) break;
      const open = Math.max(0, round2(e.amount - e.credited - e.paid));
      const take = Math.min(open, left);
      e.paid = round2(e.paid + take);
      left = round2(left - take);
    }
  }

  const out = new Map();
  for (const [id, e] of byId) {
    out.set(id, {
      amount: e.amount,
      paid: e.paid,
      credited: e.credited,
      balance: round2(e.amount - e.credited - e.paid),
    });
  }
  return out;
}

/**
 * One status rule for every invoice list:
 *   balance ≤ 0                    → 'Paid'
 *   past due_date, balance > 0     → 'Overdue'
 *   something paid                 → 'Partially Paid'
 *   otherwise                      → 'Pending'
 * `today` is a local 'YYYY-MM-DD' string.
 */
function invoiceStatus({ balance, paid }, dueDate, today) {
  if (!(balance > MONEY_EPS)) return 'Paid';
  const due = parseLocalDate(dueDate);
  if (due && formatLocalDate(due) < today) return 'Overdue';
  if (paid > MONEY_EPS) return 'Partially Paid';
  return 'Pending';
}

// Statuses in which the service actually ran (days can be billed).
const SERVICE_STARTED_STATUSES = [BOOKING_STATUS.SERVICE_STARTED, BOOKING_STATUS.ON_HOLD, BOOKING_STATUS.SUSPENDED];

/**
 * Cancellation settlement for one booking.
 *
 *   used      = days used × daily rate (start → min(cancel date, service end);
 *               0 when the service never started)
 *   billed    = SUM(edx_invoice.inv_raised_amnt) − Cancellation credit notes
 *               already raised (Pending/Approved), so a second look never
 *               credits the same days twice
 *   used > billed → invoice (used − billed)
 *   billed > used → Pending 'Cancellation' credit note (billed − used)
 *
 *   balance    = used − paid + refunded (client's position once settled;
 *                > 0 owes, < 0 overpaid → refunded later via createRefund)
 *
 * `booking` must be the row as it was BEFORE the cancel (status decides
 * whether the service started). Returns null when the booking has no valid
 * start date / rate or the cancel date is invalid.
 */
async function computeCancellationSettlement(conn, { booking, orgId, cancelDate }) {
  if (!booking || orgId == null) return null;
  const start = parseLocalDate(booking.service_start_date);
  const cancel = parseLocalDate(cancelDate);
  const rate = Number(booking.final_rate) || Number(booking.base_rate) || 0;
  if (!start || !cancel || !(rate > 0)) return null;

  const end = parseLocalDate(booking.service_end_date);
  const lastDay = end && end < cancel ? end : cancel;
  const started = SERVICE_STARTED_STATUSES.includes(String(booking.status));
  const daysUsed = started && start <= lastDay ? daysInclusive(start, lastDay) : 0;
  const amountDue = round2(daysUsed * rate);

  const total = async (q, col) => Number((await q.sum(`${col} as total`).first())?.total) || 0;
  const bookingId = booking.id;
  const billed = await total(conn('edx_invoice').where({ booking_id: bookingId, org_id: orgId }), 'inv_raised_amnt');
  const paid = await total(
    conn('edx_receipts').where({ booking_id: bookingId, org_id: orgId, status: 'Approved' }), 'total_amount');
  const refunded = await total(
    conn('edx_refunds').where({ booking_id: bookingId, org_id: orgId, status: 'COMPLETED' }), 'refund_amount');
  const priorCredit = await total(
    conn('edx_credit_notes')
      .where({ booking_id: bookingId, org_id: orgId, credit_type: 'Cancellation' })
      .whereIn('status', ['Pending', 'Approved']),
    'amount');

  const diff = round2(amountDue - (billed - priorCredit));
  const balance = round2(amountDue - paid + refunded);

  return {
    days_used:                 daysUsed,
    daily_rate:                rate,
    amount_due:                amountDue,
    total_billed:              round2(billed),
    prior_cancellation_credit: round2(priorCredit),
    total_paid:                round2(paid),
    total_refunded:            round2(refunded),
    invoice_amount:            diff > MONEY_EPS ? diff : 0,
    credit_note_amount:        diff < -MONEY_EPS ? round2(-diff) : 0,
    balance,
    refundable:                balance < -MONEY_EPS ? round2(-balance) : 0,
    owing:                     balance > MONEY_EPS ? balance : 0,
  };
}

module.exports = {
  MONEY_EPS,
  round2,
  parseMoney,
  parseLocalDate,
  formatLocalDate,
  addDays,
  daysInclusive,
  uncoveredSegments,
  allocateInvoicePayments,
  invoiceStatus,
  SERVICE_STARTED_STATUSES,
  computeCancellationSettlement,
};
