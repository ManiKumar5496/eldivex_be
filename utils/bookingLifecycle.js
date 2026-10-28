/**
 * bookingLifecycle.js — what cancelling or holding a booking does besides
 * changing its status: release its caregivers, clear and block attendance for
 * the days it no longer runs, settle the billed days, close the request
 * ticket, and report where the client's account stands.
 *
 * Every write takes the caller's transaction, so a cancel / hold is all or
 * nothing.
 */

const { getCurrentDateTime } = require('./dateTime');
const {
  MONEY_EPS, round2, parseLocalDate, formatLocalDate, addDays, daysInclusive, uncoveredSegments,
} = require('./accountsCalc');
const { computeOutstanding, postCreditNoteToBooking } = require('./accountsLedger');

// edx_booking_hp.status
const HP_ASSIGNMENT = Object.freeze({ SHORTLISTED: 1, INTERVIEW: 2, FINALIZED: 3, ACTIVE: 4, RELEASED: 5 });
const OPEN_ASSIGNMENT_STATUSES = [1, 2, 3, 4];

// edx_hp_registration.hp_reg_status: 1 Pending, 2 Approved, 3 Rejected,
// 4 Terminated, 5 on an active booking, 6 being placed (shortlist → OTP).
const HP_REG = Object.freeze({ APPROVED: 2, ACTIVE_BOOKING: 5, PLACING: 6 });

/**
 * Set each caregiver's registration status from the assignments they still
 * hold: active somewhere → 5, being placed somewhere → 6, otherwise back to
 * Approved (2) so matching offers them again. Pending, rejected and
 * terminated caregivers are never touched.
 */
async function refreshHpRegStatus(trx, { orgId, hpIds, userId }) {
  for (const hpId of [...new Set(hpIds)]) {
    const open = await trx('edx_booking_hp')
      .where({ org_id: orgId, hp_unique_id: hpId })
      .whereIn('status', OPEN_ASSIGNMENT_STATUSES)
      .select('status');
    const statuses = (open || []).map((r) => Number(r.status));
    const target = statuses.includes(HP_ASSIGNMENT.ACTIVE) ? HP_REG.ACTIVE_BOOKING
      : statuses.length ? HP_REG.PLACING
        : HP_REG.APPROVED;
    await trx('edx_hp_registration')
      .where({ hp_reg_id: hpId, org_id: orgId })
      .whereIn('hp_reg_status', [HP_REG.APPROVED, HP_REG.ACTIVE_BOOKING, HP_REG.PLACING])
      .update({ hp_reg_status: target, updated_on: getCurrentDateTime(), updated_by: userId || null });
  }
}

/**
 * Release every caregiver still on the booking (shortlisted through active).
 * The active ones get `lastDay` as their actual end date. Returns the
 * released caregivers' ids.
 */
async function releaseBookingCaregivers(trx, { orgId, bookingId, lastDay, userId }) {
  const rows = await trx('edx_booking_hp')
    .where({ org_id: orgId, bkng_id: bookingId })
    .whereIn('status', OPEN_ASSIGNMENT_STATUSES)
    .select('id', 'hp_unique_id', 'status');
  if (!rows || !rows.length) return [];

  const now = getCurrentDateTime();
  const activeIds = rows.filter((r) => Number(r.status) === HP_ASSIGNMENT.ACTIVE).map((r) => r.id);
  const otherIds = rows.filter((r) => Number(r.status) !== HP_ASSIGNMENT.ACTIVE).map((r) => r.id);
  if (activeIds.length) {
    await trx('edx_booking_hp').whereIn('id', activeIds).update({
      status: HP_ASSIGNMENT.RELEASED, end_date_actual: lastDay, updated_on: now, updated_by: userId || null,
    });
  }
  if (otherIds.length) {
    await trx('edx_booking_hp').whereIn('id', otherIds).update({
      status: HP_ASSIGNMENT.RELEASED, updated_on: now, updated_by: userId || null,
    });
  }

  const hpIds = [...new Set(rows.map((r) => r.hp_unique_id))];
  await refreshHpRegStatus(trx, { orgId, hpIds, userId });
  return hpIds;
}

// Delete attendance marked for the booking on [from, to] (to = null: onwards).
async function clearAttendance(trx, { orgId, bookingId, from, to = null }) {
  const q = trx('edx_hp_attendance')
    .where({ org_id: orgId, booking_id: bookingId })
    .where('att_date', '>=', from);
  if (to) q.where('att_date', '<=', to);
  return Number(await q.del()) || 0;
}

/**
 * Per booking, the days attendance may no longer be marked: after the last
 * service day of a cancelled booking, and inside every hold. Returns
 * Map(bookingId → { closedAfter: Date|null, holds: [{ from, to }] }).
 */
async function loadAttendanceBlocks(conn, orgId, bookingIds) {
  const ids = [...new Set(bookingIds)];
  const blocks = new Map(ids.map((id) => [Number(id), { closedAfter: null, holds: [] }]));
  if (!ids.length) return blocks;

  const [closed, holds] = await Promise.all([
    conn('edx_bookings as b')
      .join('edx_service_closed as sc', 'sc.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .whereIn('b.id', ids)
      .whereIn('b.status', ['3', '6'])
      .select('b.id', 'sc.term_date'),
    conn('edx_hold_booking').where('org_id', orgId).whereIn('booking_id', ids)
      .select('booking_id', 'from_date', 'to_date'),
  ]);
  for (const c of closed || []) {
    const d = parseLocalDate(c.term_date);
    const entry = blocks.get(Number(c.id));
    if (d && entry && (!entry.closedAfter || d < entry.closedAfter)) entry.closedAfter = d;
  }
  for (const h of holds || []) {
    const from = parseLocalDate(h.from_date);
    const to = parseLocalDate(h.to_date);
    const entry = blocks.get(Number(h.booking_id));
    if (from && to && to >= from && entry) entry.holds.push({ from, to });
  }
  return blocks;
}

// Why attendance can't be marked on `attDate` (YYYY-MM-DD), or null.
function attendanceBlockReason(blocks, bookingId, attDate) {
  const entry = blocks.get(Number(bookingId));
  const d = parseLocalDate(attDate);
  if (!entry || !d) return null;
  if (entry.closedAfter && d > entry.closedAfter) {
    return `Booking #${bookingId} was cancelled; its last service day was ${formatLocalDate(entry.closedAfter)}.`;
  }
  const hold = entry.holds.find((h) => d >= h.from && d <= h.to);
  if (hold) {
    return `Booking #${bookingId} is on hold from ${formatLocalDate(hold.from)} to ${formatLocalDate(hold.to)}.`;
  }
  return null;
}

/**
 * Days of [from, to] (Dates) covered by the booking's invoices, and the first
 * covering invoice — only days that were billed need crediting.
 */
async function invoicedDaysIn(conn, orgId, bookingId, from, to) {
  if (!from || !to || to < from) return { days: 0, invoiceId: null };
  const invoices = await conn('edx_invoice')
    .where({ org_id: orgId, booking_id: bookingId })
    .select('id', 'inv_start', 'inv_end');
  const covered = (invoices || [])
    .map((i) => ({ id: i.id, start: parseLocalDate(i.inv_start), end: parseLocalDate(i.inv_end) }))
    .filter((i) => i.start && i.end && i.end >= i.start);
  const gaps = uncoveredSegments(from, to, covered);
  const days = daysInclusive(from, to) - gaps.reduce((s, g) => s + g.days, 0);
  const first = covered
    .filter((i) => i.end >= from && i.start <= to)
    .sort((a, b) => a.start - b.start)[0];
  return { days: Math.max(0, days), invoiceId: first ? first.id : null };
}

/**
 * Credit the hold days after `cancelDate` that were billed: a hold already
 * credits those days, so cancelling must not credit them again.
 */
async function heldCreditAfter(conn, { orgId, bookingId, cancelDate, rate }) {
  const holds = await conn('edx_hold_booking')
    .where({ org_id: orgId, booking_id: bookingId })
    .select('from_date', 'to_date');
  const dayAfter = addDays(cancelDate, 1);
  let days = 0;
  for (const h of holds || []) {
    const from = parseLocalDate(h.from_date);
    const to = parseLocalDate(h.to_date);
    if (!from || !to) continue;
    const start = from > dayAfter ? from : dayAfter;
    if (start <= to) days += (await invoicedDaysIn(conn, orgId, bookingId, start, to)).days;
  }
  return round2(days * rate);
}

/**
 * Raise an approved credit note on the booking and apply it at once (see
 * postCreditNoteToBooking). The amount is capped at what the booking's
 * invoices can still be credited. Returns { id, amount } or null when there is
 * nothing to credit.
 */
async function applySystemCreditNote(trx, {
  orgId, userId, bookingId, invoiceId = null, amount, creditType, creditNoteType, reason, creditDate,
}) {
  let amt = round2(amount);
  if (!(amt > MONEY_EPS)) return null;
  const now = getCurrentDateTime();
  const [id] = await trx('edx_credit_notes').insert({
    booking_id: bookingId,
    invoice_id: invoiceId,
    credit_type: creditType,
    credit_note_type: creditNoteType,
    amount: amt,
    reason,
    status: 'Approved',
    credit_date: creditDate || now,
    org_id: orgId,
    created_by: userId,
    created_on: now,
    updated_by: userId,
    updated_on: now,
  });
  const note = { id, booking_id: bookingId, invoice_id: invoiceId, amount: amt, used_amount: 0 };
  let posted = await postCreditNoteToBooking(trx, { orgId, userId, creditNote: note, notes: 'Applied automatically' });
  if (!posted.ok && posted.creditable > MONEY_EPS) {
    // Credit only what the invoices still have room for.
    amt = round2(posted.creditable);
    await trx('edx_credit_notes').where({ id, org_id: orgId }).update({ amount: amt });
    posted = await postCreditNoteToBooking(trx, {
      orgId, userId, creditNote: { ...note, amount: amt }, notes: 'Applied automatically',
    });
  }
  if (!posted.ok) {
    await trx('edx_credit_notes').where({ id, org_id: orgId }).del();
    return null;
  }
  return { id, amount: amt };
}

// Mark the booking's open tickets whose category name matches `pattern`
// (LIKE) resolved, so the processed request no longer shows as open.
async function resolveOpenTickets(trx, { orgId, bookingId, pattern, userId }) {
  const rows = await trx('edx_support_requests as t')
    .join('edx_support_category as c', 'c.id', 't.support_type_id')
    .where({ 't.org_id': orgId, 'c.org_id': orgId, 't.status': 1 })
    .where('t.booking_details', String(bookingId))
    .whereRaw('LOWER(c.name) LIKE ?', [pattern])
    .select('t.id');
  const ids = (rows || []).map((r) => r.id);
  if (ids.length) {
    await trx('edx_support_requests').whereIn('id', ids)
      .update({ status: 3, updated_by: userId || null, updated_on: getCurrentDateTime() });
  }
  return ids.length;
}

// Where the booking's account stands: what the client still owes, or the
// excess they paid (refund it, or transfer it to another booking).
async function accountPosition(conn, orgId, bookingId) {
  const o = await computeOutstanding(orgId, { bookingId }, conn);
  return {
    outstanding: o.outstandingAmount,
    owing: o.outstandingAmount > MONEY_EPS ? o.outstandingAmount : 0,
    excess: o.outstandingAmount < -MONEY_EPS ? round2(-o.outstandingAmount) : 0,
    total_billed: round2(o.totalBilled),
    total_paid: round2(o.totalPaid),
    total_credited: round2(o.totalCreditNoteApplied),
  };
}

module.exports = {
  HP_ASSIGNMENT,
  HP_REG,
  refreshHpRegStatus,
  releaseBookingCaregivers,
  clearAttendance,
  loadAttendanceBlocks,
  attendanceBlockReason,
  invoicedDaysIn,
  heldCreditAfter,
  applySystemCreditNote,
  resolveOpenTickets,
  accountPosition,
};
