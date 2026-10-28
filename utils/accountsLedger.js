/**
 * accountsLedger.js — edx_transaction_ledger posting + the one outstanding
 * formula every accounts screen and guard uses.
 *
 *   outstanding = billed (edx_invoice)
 *               − approved receipts (edx_receipts)
 *               − ledger WRITE_OFF − CREDIT_NOTE_APPLIED − INTERNAL_TRANSFER_IN
 *               + ledger INTERNAL_TRANSFER_OUT + REFUND
 *
 * Invoices and receipts are never posted to the ledger, so billed / paid come
 * from their source tables; only adjustments are ledger based (COMPLETED rows).
 * Every function takes the knex connection or transaction to read through, so
 * guards can re-check under the caller's row locks.
 */

const db = require('../config/db');
const { getCurrentDateTime } = require('./dateTime');
const { round2, MONEY_EPS, parseLocalDate } = require('./accountsCalc');

// Ledger types that lower (credit) / raise (debit) what the client owes.
const LEDGER_CREDIT_TYPES = ['WRITE_OFF', 'CREDIT_NOTE_APPLIED', 'INTERNAL_TRANSFER_IN'];
const LEDGER_DEBIT_TYPES  = ['INTERNAL_TRANSFER_OUT', 'REFUND'];

// SQL for the net ledger credit of a group of rows (MySQL 5.7 safe), used by
// list queries that join a grouped derived table.
const LEDGER_NET_CREDIT_SQL =
  'SUM(CASE ' +
  `WHEN transaction_type IN (${LEDGER_CREDIT_TYPES.map((t) => `'${t}'`).join(',')}) THEN amount ` +
  `WHEN transaction_type IN (${LEDGER_DEBIT_TYPES.map((t) => `'${t}'`).join(',')}) THEN -amount ` +
  'ELSE 0 END)';

async function createTransactionEntry(trxOrDb, {
  orgId, clientId, bookingId, invoiceId, transactionType, direction, amount,
  referenceId, referenceType, description, notes, createdBy, createdOn,
}) {
  const amt = round2(amount);
  const clientRows = await trxOrDb('edx_transaction_ledger')
    .where({ org_id: orgId, client_id: clientId, status: 'COMPLETED' })
    .sum({ total_debit: trxOrDb.raw('CASE WHEN direction="DEBIT" THEN amount ELSE 0 END') })
    .sum({ total_credit: trxOrDb.raw('CASE WHEN direction="CREDIT" THEN amount ELSE 0 END') })
    .first();
  const prevClientBalance = (parseFloat(clientRows?.total_debit) || 0) - (parseFloat(clientRows?.total_credit) || 0);
  const newClientBalance = direction === 'DEBIT' ? prevClientBalance + amt : prevClientBalance - amt;

  let newBookingBalance = null;
  if (bookingId) {
    const bkRows = await trxOrDb('edx_transaction_ledger')
      .where({ org_id: orgId, booking_id: bookingId, status: 'COMPLETED' })
      .sum({ total_debit: trxOrDb.raw('CASE WHEN direction="DEBIT" THEN amount ELSE 0 END') })
      .sum({ total_credit: trxOrDb.raw('CASE WHEN direction="CREDIT" THEN amount ELSE 0 END') })
      .first();
    const prevBkBalance = (parseFloat(bkRows?.total_debit) || 0) - (parseFloat(bkRows?.total_credit) || 0);
    newBookingBalance = direction === 'DEBIT' ? prevBkBalance + amt : prevBkBalance - amt;
  }

  const [id] = await trxOrDb('edx_transaction_ledger').insert({
    org_id: orgId,
    client_id: clientId,
    booking_id: bookingId || null,
    invoice_id: invoiceId || null,
    transaction_type: transactionType,
    direction,
    amount: amt,
    reference_id: referenceId || null,
    reference_type: referenceType || null,
    status: 'COMPLETED',
    description: description || null,
    notes: notes || null,
    running_balance_client: round2(newClientBalance),
    running_balance_booking: newBookingBalance === null ? null : round2(newBookingBalance),
    created_by: createdBy || null,
    created_on: createdOn || getCurrentDateTime(),
  });
  return id;
}

// Booking ids in scope: one client's bookings, or a single booking, in the org.
function outstandingBookingScope(conn, orgId, { clientId, bookingId }) {
  const q = conn('edx_bookings').where('org_id', orgId).select('id');
  if (clientId != null) q.where('user_id', clientId);
  if (bookingId != null) q.where('id', bookingId);
  return q;
}

async function billedAndPaid(orgId, scope, conn = db) {
  const [inv, rec] = await Promise.all([
    conn('edx_invoice')
      .whereIn('booking_id', outstandingBookingScope(conn, orgId, scope))
      .sum('inv_raised_amnt as total')
      .first(),
    conn('edx_receipts')
      .whereIn('booking_id', outstandingBookingScope(conn, orgId, scope))
      .where('status', 'Approved')
      .sum('total_amount as total')
      .first(),
  ]);
  return { billed: parseFloat(inv?.total) || 0, paid: parseFloat(rec?.total) || 0 };
}

/**
 * Outstanding for a client ({ clientId }) or a booking ({ bookingId }).
 * Returns the same keys getClientOutstanding / getBookingOutstanding expose.
 */
async function computeOutstanding(orgId, scope, conn = db) {
  const ledgerQ = conn('edx_transaction_ledger').where({ org_id: orgId, status: 'COMPLETED' });
  if (scope.clientId != null) ledgerQ.where('client_id', scope.clientId);
  if (scope.bookingId != null) ledgerQ.where('booking_id', scope.bookingId);
  const rows = await ledgerQ
    .select('transaction_type', 'direction', conn.raw('SUM(amount) as total'))
    .groupBy('transaction_type', 'direction');

  const totals = {};
  (rows || []).forEach((r) => {
    totals[r.transaction_type] = (totals[r.transaction_type] || 0) + (parseFloat(r.total) || 0);
  });

  const { billed: totalBilled, paid: totalPaid } = await billedAndPaid(orgId, scope, conn);
  const totalWriteOff = totals.WRITE_OFF || 0;
  const totalCreditNoteApplied = totals.CREDIT_NOTE_APPLIED || 0;
  const totalRefunded = totals.REFUND || 0;
  const totalInternalTransferIn = totals.INTERNAL_TRANSFER_IN || 0;
  const totalInternalTransferOut = totals.INTERNAL_TRANSFER_OUT || 0;
  const outstandingAmount = round2(
    totalBilled - totalPaid - totalWriteOff - totalCreditNoteApplied
    - totalInternalTransferIn + totalInternalTransferOut + totalRefunded);

  return {
    totalBilled,
    totalPaid,
    totalWriteOff,
    totalCreditNoteApplied,
    totalRefunded,
    totalInternalTransferIn,
    totalInternalTransferOut,
    outstandingAmount,
  };
}

/**
 * Credit an approved credit note's remaining amount to its own booking: the
 * invoice it names first, then the booking's other invoices oldest first, each
 * up to what the invoice billed less credit already applied to it. Posts one
 * CREDIT_NOTE_APPLIED ledger entry and one edx_credit_note_applications row per
 * invoice touched, and marks the note applied.
 *
 * The booking's outstanding drops at once. When the client had already paid,
 * it goes below zero: that excess is what a refund or a credit-balance
 * transfer to another booking of the same client moves on.
 *
 * Writes nothing and returns { ok: false, creditable } when the booking's
 * invoices can't take the whole amount. Run inside the caller's transaction
 * with the credit note row locked; the booking row is locked here.
 */
async function postCreditNoteToBooking(trx, { orgId, userId, creditNote, notes }) {
  const amount = round2(creditNote.remaining_amount ?? creditNote.amount);
  const booking = await trx('edx_bookings')
    .where({ id: creditNote.booking_id, org_id: orgId })
    .forUpdate()
    .first('id', 'user_id');
  if (!booking) return { ok: false, creditable: 0, invoiceCount: 0 };

  const invoices = await trx('edx_invoice')
    .where({ booking_id: booking.id, org_id: orgId })
    .select('id', 'inv_raised_amnt', 'inv_start');
  const time = (inv) => parseLocalDate(inv.inv_start)?.getTime() ?? Infinity;
  const named = (inv) => String(inv.id) === String(creditNote.invoice_id);
  (invoices || []).sort((a, b) =>
    (named(b) - named(a)) || (time(a) - time(b)) || (a.id - b.id));

  const creditedRows = invoices?.length
    ? await trx('edx_credit_note_applications')
      .whereIn('target_invoice_id', invoices.map((i) => i.id))
      .where('status', 'APPLIED')
      .select('target_invoice_id', trx.raw('SUM(amount_applied) as total'))
      .groupBy('target_invoice_id')
    : [];
  const credited = new Map((creditedRows || []).map((r) => [String(r.target_invoice_id), Number(r.total) || 0]));

  // How much each invoice can still take, in the order above.
  let left = amount;
  const plan = [];
  let creditable = 0;
  for (const inv of invoices || []) {
    const room = Math.max(0, round2((Number(inv.inv_raised_amnt) || 0) - (credited.get(String(inv.id)) || 0)));
    creditable = round2(creditable + room);
    const take = round2(Math.min(left, room));
    if (take > 0) { plan.push({ invoiceId: inv.id, amount: take }); left = round2(left - take); }
  }
  if (left > MONEY_EPS) return { ok: false, creditable, invoiceCount: (invoices || []).length };

  const now = getCurrentDateTime();
  const entryIds = [];
  for (const p of plan) {
    const entryId = await createTransactionEntry(trx, {
      orgId, clientId: booking.user_id, bookingId: booking.id, invoiceId: p.invoiceId,
      transactionType: 'CREDIT_NOTE_APPLIED', direction: 'CREDIT', amount: p.amount,
      referenceId: creditNote.id, referenceType: 'CREDIT_NOTE',
      description: `Credit note #${creditNote.id} applied to invoice #${p.invoiceId}`,
      createdBy: userId,
    });
    entryIds.push(entryId);
    await trx('edx_credit_note_applications').insert({
      org_id: orgId, credit_note_id: creditNote.id,
      target_booking_id: booking.id, target_invoice_id: p.invoiceId,
      amount_applied: p.amount, status: 'APPLIED',
      applied_by: userId, applied_at: now,
      ledger_entry_id: entryId, notes: notes || null,
    });
  }

  await trx('edx_credit_notes').where({ id: creditNote.id, org_id: orgId }).update({
    remaining_amount: 0,
    used_amount: round2((Number(creditNote.used_amount) || 0) + amount),
    extended_status: 'FULLY_APPLIED',
    transaction_entry_id: creditNote.transaction_entry_id || entryIds[0] || null,
    updated_by: userId,
    updated_on: now,
  });
  return { ok: true, amount, bookingId: booking.id, entryIds };
}

module.exports = {
  LEDGER_CREDIT_TYPES,
  LEDGER_DEBIT_TYPES,
  LEDGER_NET_CREDIT_SQL,
  createTransactionEntry,
  postCreditNoteToBooking,
  outstandingBookingScope,
  billedAndPaid,
  computeOutstanding,
};
