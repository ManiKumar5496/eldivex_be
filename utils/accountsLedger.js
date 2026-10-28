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
const { round2 } = require('./accountsCalc');

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

module.exports = {
  LEDGER_CREDIT_TYPES,
  LEDGER_DEBIT_TYPES,
  LEDGER_NET_CREDIT_SQL,
  createTransactionEntry,
  outstandingBookingScope,
  billedAndPaid,
  computeOutstanding,
};
