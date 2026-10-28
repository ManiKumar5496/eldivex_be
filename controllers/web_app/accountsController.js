/**
 * accountsController.js — Phase 2.4 + Advanced Accounts
 *
 * Tables used:
 *   edx_bookings, edx_client_app_users, edx_web_app_users, edx_patient, edx_master_services,
 *   edx_branches, edx_invoice, edx_receipts, edx_write_offs,
 *   edx_credit_notes, edx_insurance_claims, edx_period_closing,
 *   edx_payment_reminders, edx_payment_links, edx_rate_history
 */

const db = require('../../config/db');
const logger = require('../../logger');
const applyBranchFilter = require('../../utils/applyBranchFilter');
const { getCurrentDateTime, toMysqlDate, mysqlDateAddDays } = require('../../utils/dateTime');
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope');
const {
  MONEY_EPS, round2, parseMoney, parseLocalDate, formatLocalDate, uncoveredSegments,
  allocateInvoicePayments, invoiceStatus, computeCancellationSettlement,
} = require('../../utils/accountsCalc');
const {
  LEDGER_NET_CREDIT_SQL,
  createTransactionEntry: _createTransactionEntry,
  computeOutstanding: _computeOutstanding,
  postCreditNoteToBooking: _postCreditNoteToBooking,
} = require('../../utils/accountsLedger');
const { bookingStatusLabel } = require('../../utils/bookingStatus');
const withTransaction = require('../../utils/withTransaction');
const { sendEmail } = require('../../utils/emailService');
const { paymentReminder, creditNoteGenerated, paymentReceiptEmail } = require('../../utils/emailTemplates');
const { getOrgBrand } = require('../../utils/orgBrand');
const { notifyOrgAdmins } = require('../../utils/notify');
const { getClientContact } = require('../../utils/clientContact');
const { guardOrgHandlers } = require('../../utils/requestOrg');
const crypto = require('crypto');

// Every accounts error carries the same text under both `error` and `message`
// (front ends read either). Field names of requests are unchanged.
const errBody = (text, extra = {}) => ({ ...extra, error: text, message: text });

// Allowed enum values — mirror the column ENUMs in migrations 006 / 010.
const CREDIT_TYPES     = ['Hold', 'Cancellation', 'Overpayment', 'Other'];
const WRITE_OFF_TYPES  = ['BAD_DEBT', 'BILLING_ERROR', 'GOODWILL', 'ADJUSTMENT'];
const REFUND_CHANNELS  = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'GATEWAY_REVERSAL'];
const REFUND_REASONS   = ['SERVICE_NOT_DELIVERED', 'PARTIAL_DELIVERY', 'OVERPAYMENT', 'QUALITY_ISSUE', 'GOODWILL', 'CREDIT_NOTE_CASHOUT'];
const TRANSFER_TYPES   = ['OVERPAYMENT_TRANSFER', 'RECEIPT_REALLOCATION', 'CREDIT_BALANCE_TRANSFER', 'SERVICE_SWITCH'];

// Refund states that already commit (or have spent) the booking's money.
const REFUND_COMMITTED_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED'];
const REFUND_IN_FLIGHT_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING'];

const fmt2 = (n) => round2(n).toFixed(2);
const enumError = (field, allowed) => errBody(`${field} must be one of: ${allowed.join(', ')}`);

// Body value that must agree with the booking when it is sent at all.
const disagrees = (bodyValue, bookingValue) =>
  bodyValue !== undefined && bodyValue !== null && bodyValue !== '' &&
  String(bodyValue) !== String(bookingValue);

// ── 1. Get Active Clients ─────────────────────────────────────────────────────

/**
 * GET /api/getActiveClients
 * Returns bookings with aggregated billing totals.
 * Respects branch_access from JWT.
 *
 * outstanding_amount uses the shared formula (utils/accountsLedger): billed −
 * approved receipts − net ledger credits (write-offs, applied credit notes,
 * transfers in) + ledger debits (transfers out, refunds). Each total comes from
 * a per-booking grouped derived table (MySQL 5.7 safe — no correlated refs).
 * No default row cap: limit / offset apply only when passed.
 */
const getActiveClients = async (req, res) => {
  try {
    const user = req.login_data;
    const orgId = getOrgId(req);
    const orgBookingIds = () => db('edx_bookings').select('id').where('org_id', orgId);

    // NOTE: orgQuery() returns a query builder with no .alias() method.
    // Use db('table as alias').where() directly for aliased main table queries.
    let query = db('edx_bookings as b')
      .where('b.org_id', orgId)
      .leftJoin('edx_client_app_users as u', 'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',         'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
      .leftJoin('edx_branches as br',        'b.branch_id', 'br.br_id')
      .leftJoin(
        db('edx_invoice')
          .select('booking_id')
          .sum('inv_raised_amnt as total_billed')
          .whereIn('booking_id', orgBookingIds())
          .groupBy('booking_id')
          .as('inv'),
        'inv.booking_id', 'b.id'
      )
      .leftJoin(
        db('edx_receipts')
          .select('booking_id')
          .sum('total_amount as total_paid')
          .where('status', 'Approved')
          .whereIn('booking_id', orgBookingIds())
          .groupBy('booking_id')
          .as('rec'),
        'rec.booking_id', 'b.id'
      )
      .leftJoin(
        db('edx_transaction_ledger')
          .select('booking_id', db.raw(`${LEDGER_NET_CREDIT_SQL} as ledger_credit`))
          .where({ org_id: orgId, status: 'COMPLETED' })
          .whereNotNull('booking_id')
          .groupBy('booking_id')
          .as('led'),
        'led.booking_id', 'b.id'
      )
      .select(
        'b.id',
        'b.id as booking_id',
        'b.user_id',
        'b.branch_id',
        'b.service_type_id',
        'b.service_start_date',
        'b.service_end_date',
        'b.final_rate',
        'b.status',
        'u.user_name as client_name',
        'u.phone_number as client_mobile',
        'u.user_email as client_email',
        'p.patient_name',
        'ms.name as service_name',
        'br.br_name as branch_name',
        db.raw("COALESCE(NULLIF(TRIM(br.br_city), ''), NULLIF(TRIM(u.user_service_city), '')) as city"),
        db.raw('COALESCE(inv.total_billed, 0) as total_billed'),
        db.raw('COALESCE(rec.total_paid, 0) as total_paid'),
        db.raw('COALESCE(inv.total_billed, 0) - COALESCE(rec.total_paid, 0) - COALESCE(led.ledger_credit, 0) as outstanding_amount')
      )
      .orderBy('b.id', 'desc');

    // Apply branch access filter
    query = applyBranchFilter(query, user, 'b.branch_id');

    // Optional status filter
    if (req.query.status) {
      query = query.where('b.status', req.query.status);
    }

    // Optional pagination — only when the caller asks for it.
    const limit  = parseInt(req.query.limit, 10);
    const offset = parseInt(req.query.offset, 10);
    if (Number.isFinite(limit) && limit > 0) query = query.limit(limit);
    if (Number.isFinite(offset) && offset > 0) query = query.offset(offset);

    const data = await query;
    res.json(data.map((r) => ({ ...r, status_label: bookingStatusLabel(r.status), city: r.city ?? null })));
  } catch (err) {
    logger.error(`Error getActiveClients: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching active clients.'));
  }
};

// ── 2. Create Provisional Receipt ────────────────────────────────────────────

/**
 * POST /api/createReceipt
 * Body: { booking_id, user_id, amount, tax_amount, payment_mode,
 *         transaction_id, remarks, receipt_date, period_from, period_to }
 */
const createProvisionalReceipt = async (req, res) => {
  try {
    const {
      booking_id,
      user_id,
      amount,
      tax_amount = 0,
      payment_mode = 'Cash',
      transaction_id,
      remarks,
      receipt_date,
      period_from,
      period_to,
      invoice_id,
    } = req.body;

    if (!booking_id || !amount) {
      return res.status(400).json(errBody('booking_id and amount are required.'));
    }

    const amt = parseMoney(amount);
    if (amt === null || amt <= 0) {
      return res.status(400).json(errBody('Amount must be a number greater than zero.'));
    }
    const tax = parseMoney(tax_amount ?? 0);
    if (tax === null || tax < 0) {
      return res.status(400).json(errBody('tax_amount must be zero or more.'));
    }

    const orgId = getOrgId(req);

    // Guard: booking must not be cancelled (status 6)
    const booking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first();
    if (!booking) {
      return res.status(404).json(errBody('Booking not found.'));
    }
    if (String(booking.status) === '6') {
      return res.status(400).json(errBody('Cannot create receipt for a cancelled booking.'));
    }

    // The invoice this payment settles must be this booking's.
    if (invoice_id) {
      const inv = await db('edx_invoice').where({ id: invoice_id, booking_id }).first('id');
      if (!inv) return res.status(400).json(errBody('invoice_id does not belong to this booking.'));
    }

    // Guard: the month the money is received in must not be closed. (Not the
    // service period — a late payment for a closed month's invoice is fine.)
    const receivedOn = parseLocalDate(receipt_date) || parseLocalDate(formatLocalDate(new Date()));
    {
      const periodMonth = receivedOn.getMonth() + 1;
      const periodYear  = receivedOn.getFullYear();
      const closedPeriod = await db('edx_period_closing')
        .where({ org_id: orgId, period_month: periodMonth, period_year: periodYear, status: 'Closed' })
        .first();
      if (closedPeriod) {
        return res.status(400).json(errBody(
          `Period ${periodMonth}/${periodYear} is closed. No new entries allowed.`,
        ));
      }
    }

    const total_amount = round2(amt + tax);

    // Generate receipt_number before insert using current org count
    const countRow = await db('edx_receipts').where({ org_id: orgId }).count('id as cnt').first();
    const receipt_number = `RCP-${orgId}-${String((Number(countRow.cnt) || 0) + 1).padStart(6, '0')}`;

    // Record payment directly as Approved — no provisional/pending step needed
    const [id] = await db('edx_receipts').insert(withOrg(req, {
      receipt_number,
      booking_id,
      invoice_id:     invoice_id     || null,
      user_id:        user_id        || null,
      amount:         round2(amt),
      tax_amount:     round2(tax),
      total_amount,
      payment_mode:   payment_mode   || 'Cash',
      transaction_id: transaction_id || null,
      remarks:        remarks        || null,
      receipt_date:   receipt_date   || getCurrentDateTime(),
      period_from:    toMysqlDate(period_from),
      period_to:      toMysqlDate(period_to),
      status:         'Approved',
      created_by:     req.login_data.id,
      created_on:     getCurrentDateTime(),
    }));

    const receipt = await db('edx_receipts').where({ id, org_id: getOrgId(req) }).first();
    res.status(201).json({ message: 'Payment recorded successfully.', id, data: receipt });

    notifyOrgAdmins(getOrgId(req), {
      type:  'receipt',
      title: `Payment received — ₹${Number(total_amount).toLocaleString('en-IN')}`,
      body:  `Receipt ${receipt_number} recorded for booking #${booking_id} (${payment_mode || 'Cash'}).`,
      data:  { receipt_id: id, booking_id, route: 'accounts' },
    });

    // ── Send payment receipt email to client (fire-and-forget) ──────────────
    setImmediate(async () => {
      try {
        const [user, org, meta] = await Promise.all([
          getClientContact(booking.user_id, orgId), // client id → edx_client_app_users
          getOrgBrand(db, orgId),
          db('edx_bookings as b')
            .where({ 'b.id': booking_id, 'b.org_id': orgId })
            .leftJoin('edx_patient as p', 'b.patient_id', 'p.id')
            .first('p.patient_name'),
        ]);
        if (user && user.user_email) {
          const tpl = paymentReceiptEmail({
            org,
            clientName:    user.user_name || 'Client',
            receiptNumber: receipt_number,
            receiptDate:   receipt?.receipt_date || getCurrentDateTime(),
            bookingId:     booking_id,
            patientName:   meta?.patient_name,
            amount:        Number(amount),
            taxAmount:     Number(tax_amount),
            totalAmount:   total_amount,
            paymentMode:   payment_mode,
            transactionId: transaction_id,
            periodFrom:    period_from,
            periodTo:      period_to,
          });
          await sendEmail({ to: user.user_email, fromName: org?.name, ...tpl });
        }
      } catch (emailErr) {
        logger.warn(`[email] Payment receipt email failed for receipt ${receipt_number}: ${emailErr.message}`);
      }
    });
  } catch (err) {
    logger.error(`Error createProvisionalReceipt: ${err.message}`);
    res.status(500).json(errBody('An error occurred while recording payment.'));
  }
};

// ── 3. Update Receipt Status ──────────────────────────────────────────────────

/**
 * PATCH /api/updateReceiptStatus
 * Body: { id, status }  — status: 'Approved' | 'Cancelled'
 */
const updateReceiptStatus = async (req, res) => {
  try {
    const { id, status } = req.body;

    if (!id || !status) {
      return res.status(400).json(errBody('id and status are required.'));
    }

    if (!['Approved', 'Cancelled'].includes(status)) {
      return res.status(400).json(errBody('status must be Approved or Cancelled.'));
    }

    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const receipt = await db('edx_receipts')
      .where({ id })
      .andWhere('org_id', orgId)
      .first();
    if (!receipt) {
      return res.status(404).json(errBody('Receipt not found.'));
    }

    // Pending → Approved / Cancelled; a recorded (Approved) payment can be
    // cancelled to correct a mistake.
    const allowed = { Pending: ['Approved', 'Cancelled'], Approved: ['Cancelled'] };
    if (!allowed[receipt.status]?.includes(status)) {
      return res.status(400).json(errBody(
        `Receipt is already ${receipt.status}. No changes allowed.`,
      ));
    }

    if (receipt.status === 'Approved') {
      // Reversing money already counted as paid: maker-checker, and never
      // below what has been committed to refunds from this booking.
      if (_isOwnRequest(receipt, userId)) {
        return res.status(403).json(errBody('You cannot cancel a payment you recorded.'));
      }
      if (receipt.booking_id) {
        const refundable = await _refundableBalance(db, orgId, receipt.booking_id);
        if (refundable - round2(receipt.total_amount) < -MONEY_EPS) {
          return res.status(400).json(errBody(
            'Refunds have already been raised against this payment. Reject or reverse them first.',
          ));
        }
      }
    }

    const updated = await db('edx_receipts')
      .where({ id, status: receipt.status })
      .andWhere('org_id', orgId)
      .update({
        status,
        updated_by: userId,
        updated_on: getCurrentDateTime(),
      });

    if (!updated) {
      return res.status(409).json(errBody('Receipt was already updated.'));
    }

    res.json({ message: `Receipt ${status.toLowerCase()} successfully.` });
  } catch (err) {
    logger.error(`Error updateReceiptStatus: ${err.message}`);
    res.status(500).json(errBody('An error occurred while updating receipt status.'));
  }
};

// ── 4. Get Client Statements ──────────────────────────────────────────────────

/**
 * GET /api/getClientStatements?booking_id=&user_id=
 * Returns a chronological list of invoice and payment transactions
 * with running balance, grouped per booking.
 */
const getClientStatements = async (req, res) => {
  try {
    const { booking_id, user_id } = req.query;

    if (!booking_id && !user_id) {
      return res.status(400).json(errBody('booking_id or user_id is required.'));
    }

    // Build invoice rows
    let invoiceQ = db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', getOrgId(req))
      .select(
        'i.id',
        'i.booking_id',
        'i.inv_date as date',
        db.raw("'Invoice' as type"),
        db.raw('COALESCE(i.inv_raised_amnt, 0) as debit'),
        db.raw('0 as credit'),
        db.raw("CONCAT('INV-', i.id) as reference_number"),
        db.raw("CONCAT('Invoice for period ', COALESCE(i.inv_start,''), ' to ', COALESCE(i.inv_end,'')) as description")
      );

    if (booking_id) invoiceQ = invoiceQ.where('i.booking_id', booking_id);
    if (user_id)    invoiceQ = invoiceQ.where('b.user_id', user_id);

    // Build receipt rows
    let receiptQ = db('edx_receipts as r')
      .leftJoin('edx_bookings as b', 'r.booking_id', 'b.id')
      .where('r.status', 'Approved')
      .andWhere('b.org_id', getOrgId(req))
      .select(
        'r.id',
        'r.booking_id',
        'r.receipt_date as date',
        db.raw("'Payment' as type"),
        db.raw('0 as debit'),
        db.raw('COALESCE(r.total_amount, 0) as credit'),
        db.raw("COALESCE(NULLIF(r.receipt_number, ''), CONCAT('REC-', r.id)) as reference_number"),
        db.raw("CONCAT('Payment via ', r.payment_mode) as description")
      );

    if (booking_id) receiptQ = receiptQ.where('r.booking_id', booking_id);
    if (user_id)    receiptQ = receiptQ.where('b.user_id', user_id);

    // Adjustments posted to the ledger: write-offs, applied credit notes,
    // refunds and transfers — so the closing balance matches what is owed.
    const ADJUSTMENTS = {
      WRITE_OFF:             { type: 'Write-off',    side: 'credit', prefix: 'WO' },
      CREDIT_NOTE_APPLIED:   { type: 'Credit Note',  side: 'credit', prefix: 'CN' },
      INTERNAL_TRANSFER_IN:  { type: 'Transfer In',  side: 'credit', prefix: 'TR' },
      REFUND:                { type: 'Refund',       side: 'debit',  prefix: 'RF' },
      INTERNAL_TRANSFER_OUT: { type: 'Transfer Out', side: 'debit',  prefix: 'TR' },
    };
    const orgId = getOrgId(req);
    const ledgerQ = db('edx_transaction_ledger as tl')
      .where({ 'tl.org_id': orgId, 'tl.status': 'COMPLETED' })
      .whereIn('tl.transaction_type', Object.keys(ADJUSTMENTS))
      .select('tl.id', 'tl.booking_id', 'tl.created_on as date', 'tl.transaction_type',
        'tl.amount', 'tl.reference_id', 'tl.description');
    if (booking_id) ledgerQ.where('tl.booking_id', booking_id);
    if (user_id) {
      ledgerQ.whereIn('tl.booking_id', db('edx_bookings').select('id').where({ org_id: orgId, user_id }));
    }

    const invoices = await invoiceQ;
    const receipts = await receiptQ;
    const adjustments = (await ledgerQ).map((l) => {
      const a = ADJUSTMENTS[l.transaction_type];
      const amt = round2(l.amount);
      return {
        id: l.id,
        booking_id: l.booking_id,
        date: l.date,
        type: a.type,
        debit: a.side === 'debit' ? amt : 0,
        credit: a.side === 'credit' ? amt : 0,
        reference_number: l.reference_id != null ? `${a.prefix}-${l.reference_id}` : a.type,
        description: l.description || a.type,
      };
    });

    // Merge and sort by date ascending
    const transactions = [...invoices, ...receipts, ...adjustments].sort((a, b) =>
      new Date(a.date || 0) - new Date(b.date || 0)
    );

    // Compute running balance
    let balance = 0;
    const result = transactions.map((t) => {
      balance = round2(balance + Number(t.debit) - Number(t.credit));
      return { ...t, balance };
    });

    res.json(result);
  } catch (err) {
    logger.error(`Error getClientStatements: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching client statements.'));
  }
};

// ── 5. Create Write-Off ───────────────────────────────────────────────────────

/**
 * POST /api/createWriteOff
 * Body: { booking_id, user_id, write_off_amount, reason, remarks, approved_by, write_off_date }
 */
const createWriteOff = async (req, res) => {
  try {
    const {
      booking_id,
      user_id,
      write_off_amount,
      reason,
      remarks,
      approved_by,
      write_off_date,
    } = req.body;

    const amount = parseMoney(write_off_amount);
    if (amount === null) {
      return res.status(400).json(errBody('write_off_amount is required and must be a number.'));
    }
    if (amount <= 0) {
      return res.status(400).json(errBody('write_off_amount must be greater than zero.'));
    }
    // Without a booking there is no balance to cap the write-off against.
    if (!booking_id) {
      return res.status(400).json(errBody('booking_id is required.'));
    }

    const orgId = getOrgId(req);

    {
      // The booking must belong to the caller's org — otherwise this would
      // reveal (and write off against) another tenant's balance.
      const ownBooking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first('id', 'user_id');
      if (!ownBooking) return res.status(404).json(errBody('Booking not found.'));
      if (user_id && ownBooking.user_id != null && String(ownBooking.user_id) !== String(user_id)) {
        return res.status(400).json(errBody('user_id does not match the booking client.'));
      }

      // Guard: no pending write-off already exists for this booking
      const existingPending = await db('edx_write_offs')
        .where({ booking_id, status: 'Pending', org_id: orgId })
        .first();
      if (existingPending) {
        return res.status(400).json(errBody(
          'A pending write-off already exists for this booking. Approve or reject it first.',
        ));
      }

      // Guard: write-off cannot exceed the outstanding balance — net of
      // earlier write-offs, applied credit notes, transfers and refunds.
      const { outstandingAmount: outstanding } = await _computeOutstanding(orgId, { bookingId: booking_id });
      if (amount > outstanding + MONEY_EPS) {
        return res.status(400).json(errBody(
          `Write-off amount (₹${fmt2(amount)}) exceeds outstanding balance (₹${fmt2(Math.max(0, outstanding))}).`,
          { outstanding: round2(outstanding) },
        ));
      }
    }

    const [id] = await db('edx_write_offs').insert(withOrg(req, {
      booking_id:      booking_id      || null,
      user_id:         user_id         || null,
      write_off_amount: round2(amount),
      reason:          reason          || null,
      remarks:         remarks         || null,
      // Set to the real approver when the write-off is approved — never the
      // name the creator typed.
      approved_by:     null,
      write_off_date:  write_off_date  || getCurrentDateTime(),
      status:          'Pending',
      created_by:      req.login_data.id,
      created_on:      getCurrentDateTime(),
    }));

    const writeOff = await db('edx_write_offs').where({ id, org_id: getOrgId(req) }).first();
    res.status(201).json({ message: 'Write-off created successfully.', data: writeOff });
  } catch (err) {
    logger.error(`Error createWriteOff: ${err.message}`);
    res.status(500).json(errBody('An error occurred while creating write-off.'));
  }
};

// ── 6. Update Write-Off Status ────────────────────────────────────────────────

/**
 * PATCH /api/updateWriteOffStatus
 * Body: { id, status }  — status: 'Approved' | 'Rejected'
 */
const updateWriteOffStatus = async (req, res) => {
  try {
    const { id, status } = req.body;

    if (!id || !status) {
      return res.status(400).json(errBody('id and status are required.'));
    }

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json(errBody('status must be Approved or Rejected.'));
    }

    // Guard: only Pending write-offs can be updated
    const writeOff = await db('edx_write_offs')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .first();
    if (!writeOff) {
      return res.status(404).json(errBody('Write-off not found.'));
    }
    if (writeOff.status !== 'Pending') {
      return res.status(400).json(errBody(
        `Write-off is already ${writeOff.status}. No changes allowed.`,
      ));
    }
    if (status === 'Approved' && _isOwnRequest(writeOff, req.login_data.id)) {
      return res.status(403).json(errBody('You cannot approve a write-off you created.'));
    }

    // Same transaction as approveWriteOff: posts the WRITE_OFF ledger entry,
    // records the real approver and re-checks the outstanding balance.
    if (status === 'Approved') {
      await _approveWriteOffTx(getOrgId(req), req.login_data.id, writeOff.id);
    } else if (!(await _rejectWriteOff(getOrgId(req), req.login_data.id, writeOff.id))) {
      return res.status(409).json(errBody('Write-off was already processed.'));
    }

    res.json({ message: `Write-off ${status.toLowerCase()} successfully.` });
  } catch (err) {
    if (err instanceof StateConflict) return res.status(err.status).json(errBody(err.message));
    logger.error(`Error updateWriteOffStatus: ${err.message}`);
    res.status(500).json(errBody('An error occurred while updating write-off status.'));
  }
};

// ── 7. Get Invoices ───────────────────────────────────────────────────────────

/**
 * GET /api/getInvoices
 * Returns all invoices with client/patient info, paid amounts, computed status.
 * Supports ?booking_id=, ?status=, ?from=, ?to=, ?branch_id=, ?limit=, ?offset=
 */
const getInvoices = async (req, res) => {
  try {
    const user = req.login_data;
    const orgId = getOrgId(req);
    const today = formatLocalDate(new Date());

    // paid / balance / status are worked out per invoice below (see
    // _invoiceAllocations) — a booking's receipts are not credited to every
    // one of its invoices.
    let query = db('edx_invoice as i')
      .leftJoin('edx_bookings as b',        'i.booking_id', 'b.id')
      .leftJoin('edx_client_app_users as u',   'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',         'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .leftJoin('edx_branches as br',       'b.branch_id', 'br.br_id')
      .where('b.org_id', orgId)
      .select(
        'i.id as invoice_db_id',
        db.raw("CONCAT('INV-', i.id) as invoice_id"),
        'i.booking_id',
        'i.inv_raised_amnt as total_amount',
        'i.inv_start as period_from',
        'i.inv_end   as period_to',
        'i.inv_date  as invoice_date',
        'i.due_date',
        'i.invoice_type',
        'b.final_rate as daily_rate',
        'b.status    as booking_status',
        'u.user_name   as client_name',
        'u.phone_number as client_mobile',
        'p.patient_name',
        'ms.name as service_name',
        'br.br_name as branch_name',
      );

    // Apply branch filter from JWT
    query = applyBranchFilter(query, user, 'b.branch_id');

    if (req.query.booking_id)  query = query.where('i.booking_id', req.query.booking_id);
    if (req.query.branch_id)   query = query.where('b.branch_id',  req.query.branch_id);
    if (req.query.from)        query = query.where('i.inv_date', '>=', req.query.from);
    if (req.query.to)          query = query.where('i.inv_date', '<=', req.query.to);

    const rows = await query.orderBy('i.id', 'desc');

    const alloc = await _invoiceAllocations(db, rows.map((r) => r.booking_id));
    const results = rows.map((r) => {
      const a = alloc.get(String(r.invoice_db_id))
        || { amount: round2(r.total_amount), paid: 0, credited: 0, balance: round2(r.total_amount) };
      return {
        ...r,
        paid_amount:     a.paid,
        credited_amount: a.credited,
        balance_due:     a.balance,
        status:          invoiceStatus(a, r.due_date, today),
      };
    });

    // Status filter on the computed status
    const finalResults = req.query.status
      ? results.filter(r => r.status === req.query.status)
      : results;

    const limit  = parseInt(req.query.limit)  || 200;
    const offset = parseInt(req.query.offset) || 0;

    res.json(finalResults.slice(offset, offset + limit));
  } catch (err) {
    logger.error(`Error getInvoices: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching invoices.'));
  }
};

// ── 8. Create Credit Note ─────────────────────────────────────────────────────

/**
 * POST /api/createCreditNote
 * Body: { booking_id, invoice_id, credit_type, amount, reason, credit_date }
 */
const createCreditNote = async (req, res) => {
  try {
    const { booking_id, invoice_id, credit_type, amount, reason, credit_date } = req.body;

    if (!booking_id || !amount) {
      return res.status(400).json(errBody('booking_id and amount are required.'));
    }
    const cnAmount = parseMoney(amount);
    if (cnAmount === null || cnAmount <= 0) return res.status(400).json(errBody('amount must be greater than zero.'));
    if (credit_type && !CREDIT_TYPES.includes(credit_type)) {
      return res.status(400).json(enumError('credit_type', CREDIT_TYPES));
    }

    const orgId = getOrgId(req);
    const cnBooking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first('id', 'user_id');
    if (!cnBooking) return res.status(404).json(errBody('Booking not found.'));
    if (invoice_id) {
      const cnInvoice = await db('edx_invoice').where({ id: invoice_id, org_id: orgId, booking_id }).first('id');
      if (!cnInvoice) return res.status(404).json(errBody('Invoice not found for this booking.'));
    }

    const [id] = await db('edx_credit_notes').insert(withOrg(req, {
      booking_id,
      invoice_id:  invoice_id  || null,
      credit_type: credit_type || 'Hold',
      amount:      round2(cnAmount),
      reason:      reason      || null,
      status:      'Pending',
      credit_date: credit_date || getCurrentDateTime(),
      created_by:  req.login_data.id,
      created_on:  getCurrentDateTime(),
    }));

    const note = await db('edx_credit_notes').where({ id, org_id: getOrgId(req) }).first();
    res.status(201).json({ message: 'Credit note created.', data: note });

    notifyOrgAdmins(getOrgId(req), {
      type:  'credit_note',
      title: `Credit note issued — ₹${Number(amount).toLocaleString('en-IN')}`,
      body:  `${credit_type || 'Hold'} credit note #${id} created for booking #${booking_id}${reason ? ` — ${reason}` : ''}.`,
      data:  { credit_note_id: id, booking_id, route: 'accounts' },
    });

    // Notify accounts team via email (fire-and-forget)
    setImmediate(async () => {
      try {
        const booking = await getClientContact(cnBooking.user_id, orgId);
        if (booking && booking.user_email) {
          const tpl = creditNoteGenerated({
            clientName:  booking.user_name || 'Client',
            creditType:  credit_type || 'Hold',
            amount:      Number(amount),
            bookingId:   booking_id,
            noteId:      id,
            reason:      reason || '—',
          });
          await sendEmail({ to: booking.user_email, ...tpl });
        }
      } catch (emailErr) {
        logger.warn(`[email] Credit note email failed: ${emailErr.message}`);
      }
    });
  } catch (err) {
    logger.error(`Error createCreditNote: ${err.message}`);
    res.status(500).json(errBody('An error occurred while creating credit note.'));
  }
};

// ── 9. Get Credit Notes ────────────────────────────────────────────────────────

/**
 * GET /api/getCreditNotes?booking_id=&status=
 */
const getCreditNotes = async (req, res) => {
  try {
    let query = db('edx_credit_notes as cn')
      .leftJoin('edx_bookings as b',       'cn.booking_id', 'b.id')
      .leftJoin('edx_client_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .where('cn.org_id', getOrgId(req))
      .select(
        'cn.*',
        'u.user_name  as client_name',
        'u.phone_number as client_mobile',
        'p.patient_name',
      )
      .orderBy('cn.id', 'desc');

    if (req.query.booking_id) query = query.where('cn.booking_id', req.query.booking_id);
    if (req.query.status)     query = query.where('cn.status', req.query.status);

    const data = await query;
    res.json(data);
  } catch (err) {
    logger.error(`Error getCreditNotes: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching credit notes.'));
  }
};

// ── 10. Update Credit Note Status ─────────────────────────────────────────────

/**
 * PATCH /api/updateCreditNoteStatus
 * Body: { id, status }  — Approved | Rejected
 */
const updateCreditNoteStatus = async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) return res.status(400).json(errBody('id and status required.'));
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json(errBody('status must be Approved or Rejected.'));
    }

    // Guard: only Pending credit notes can be updated
    const creditNote = await db('edx_credit_notes')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .first();
    if (!creditNote) return res.status(404).json(errBody('Credit note not found.'));
    if (creditNote.status !== 'Pending') {
      return res.status(400).json(errBody(
        `Credit note is already ${creditNote.status}. No changes allowed.`,
      ));
    }

    // Maker-checker, as for write-offs and refunds: an approved credit note
    // reduces what the client owes, so its creator may not approve it.
    if (status === 'Approved' && _isOwnRequest(creditNote, req.login_data.id)) {
      return res.status(403).json(errBody('You cannot approve a credit note you created.'));
    }

    // Approval applies the credit to its booking in the same transaction, so
    // the outstanding drops at once; any excess over what the client owes is
    // then refundable or transferable to another booking.
    if (status === 'Approved') {
      const orgId = getOrgId(req);
      const userId = req.login_data.id;
      const posted = await withTransaction(async (trx) => {
        const locked = await trx('edx_credit_notes').where({ id, org_id: orgId }).forUpdate().first();
        if (!locked || locked.status !== 'Pending') throw new StateConflict('Credit note was already processed.');
        const result = await _postCreditNoteToBooking(trx, {
          orgId, userId, creditNote: locked, notes: 'Applied on approval',
        });
        if (!result.ok) {
          throw new StateConflict(result.invoiceCount === 0
            ? `Booking #${locked.booking_id} has no invoice yet. Raise the invoice, then approve this credit note.`
            : `Credit note ₹${fmt2(locked.amount)} is more than booking #${locked.booking_id} can still be credited (₹${fmt2(result.creditable)}).`,
          400);
        }
        await trx('edx_credit_notes').where({ id, org_id: orgId })
          .update({ status: 'Approved', updated_by: userId, updated_on: getCurrentDateTime() });
        return result;
      });
      return res.json({
        message: `Credit note approved. ₹${fmt2(posted.amount)} deducted from booking #${posted.bookingId}.`,
      });
    }

    const updated = await db('edx_credit_notes')
      .where({ id, status: 'Pending' })
      .andWhere('org_id', getOrgId(req))
      .update({ status, updated_by: req.login_data.id, updated_on: getCurrentDateTime() });
    if (!updated) return res.status(409).json(errBody('Credit note was already processed.'));
    res.json({ message: `Credit note ${status.toLowerCase()}.` });
  } catch (err) {
    if (err instanceof StateConflict) return res.status(err.status).json(errBody(err.message));
    logger.error(`Error updateCreditNoteStatus: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

// ── 11. AR Aging Report ────────────────────────────────────────────────────────

/**
 * GET /api/getAgingReport
 * Returns outstanding invoices bucketed by overdue days.
 * Buckets: Current (not due), 1-30, 31-60, 61-90, 90+
 */
const getAgingReport = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const today = parseLocalDate(formatLocalDate(new Date()));

    // Every invoice of the org, with its own open balance (receipts and
    // applied credit notes allocated per invoice — see _invoiceAllocations).
    const allInvoices = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .select('i.id', 'i.booking_id', 'i.inv_raised_amnt as total_amount', 'i.due_date');
    const alloc = await _invoiceAllocations(db, allInvoices.map((i) => i.booking_id));
    const invoices = allInvoices
      .map((i) => ({ ...i, balance_due: alloc.get(String(i.id))?.balance ?? round2(i.total_amount) }))
      .filter((i) => i.balance_due > MONEY_EPS);

    const buckets = {
      current:   { label: 'Current (Not Due)', count: 0, amount: 0 },
      days_1_30: { label: '1–30 Days',         count: 0, amount: 0 },
      days_31_60:{ label: '31–60 Days',        count: 0, amount: 0 },
      days_61_90:{ label: '61–90 Days',        count: 0, amount: 0 },
      days_90p:  { label: '90+ Days',          count: 0, amount: 0 },
    };

    invoices.forEach(inv => {
      const balance = Number(inv.balance_due);
      if (balance <= 0) return;

      let overdueDays = 0;
      const due = parseLocalDate(inv.due_date);
      if (due) overdueDays = Math.round((today - due) / 86400000);

      if (overdueDays <= 0) {
        buckets.current.count++;
        buckets.current.amount += balance;
      } else if (overdueDays <= 30) {
        buckets.days_1_30.count++;
        buckets.days_1_30.amount += balance;
      } else if (overdueDays <= 60) {
        buckets.days_31_60.count++;
        buckets.days_31_60.amount += balance;
      } else if (overdueDays <= 90) {
        buckets.days_61_90.count++;
        buckets.days_61_90.amount += balance;
      } else {
        buckets.days_90p.count++;
        buckets.days_90p.amount += balance;
      }
    });

    // Round amounts
    Object.values(buckets).forEach(b => { b.amount = Math.round(b.amount * 100) / 100; });

    res.json({ buckets, total_outstanding: round2(invoices.reduce((s, i) => s + Number(i.balance_due), 0)) });
  } catch (err) {
    logger.error(`Error getAgingReport: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching aging report.'));
  }
};

// ── 12. Collections KPIs ──────────────────────────────────────────────────────

/**
 * GET /api/getCollectionsKPIs
 * Returns DSO, collection rate, overdue count + amount.
 */
const getCollectionsKPIs = async (req, res) => {
  try {
    const orgId = getOrgId(req);

    // Total billed (all invoices)
    const billedRow = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .sum('i.inv_raised_amnt as total_billed')
      .first();
    const totalBilled = Number(billedRow.total_billed) || 0;

    // Total collected (all approved receipts)
    const collectedRow = await db('edx_receipts as r')
      .leftJoin('edx_bookings as b', 'r.booking_id', 'b.id')
      .where('r.status', 'Approved')
      .where('b.org_id', orgId)
      .sum('r.total_amount as total_collected')
      .first();
    const totalCollected = Number(collectedRow.total_collected) || 0;

    // Overdue = past due with an open balance — the same rule as the
    // 'Overdue' status in getInvoices, using per-invoice balances.
    const today = formatLocalDate(new Date());
    const invoices = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .select('i.id', 'i.booking_id', 'i.inv_raised_amnt', 'i.due_date');
    const alloc = await _invoiceAllocations(db, invoices.map((i) => i.booking_id));
    let overdueCount = 0;
    let overdueAmount = 0;
    for (const inv of invoices) {
      const a = alloc.get(String(inv.id));
      if (a && invoiceStatus(a, inv.due_date, today) === 'Overdue') {
        overdueCount++;
        overdueAmount += a.balance;
      }
    }

    // Outstanding nets write-offs, applied credit notes, transfers and
    // refunds, like the client / booking outstanding endpoints.
    const ledgerRow = await db('edx_transaction_ledger')
      .where({ org_id: orgId, status: 'COMPLETED' })
      .select(db.raw(`${LEDGER_NET_CREDIT_SQL} as net_credit`))
      .first();
    const totalOutstanding = round2(totalBilled - totalCollected - (Number(ledgerRow?.net_credit) || 0));

    // DSO = (Total Receivables / Total Billed) * 30  (30-day DSO approximation)
    const dso = totalBilled > 0
      ? Math.round((totalOutstanding / totalBilled) * 30)
      : 0;

    const collectionRate = totalBilled > 0
      ? Math.round((totalCollected / totalBilled) * 100)
      : 0;

    res.json({
      total_billed:      totalBilled,
      total_collected:   totalCollected,
      total_outstanding: totalOutstanding,
      collection_rate:   collectionRate,     // percentage 0-100
      dso,                                   // days sales outstanding
      overdue_count:     overdueCount,
      overdue_amount:    Math.round(overdueAmount * 100) / 100,
    });
  } catch (err) {
    logger.error(`Error getCollectionsKPIs: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching KPIs.'));
  }
};

// ── 13. Bulk Generate Invoices ────────────────────────────────────────────────

/**
 * POST /api/bulkGenerateInvoices
 * Invoices the days of the month that active bookings (status=4) have not been
 * billed for yet. Bookings are invoiced for their whole period at activation
 * and on extension, so only days no existing invoice covers are billed (one
 * invoice per uncovered stretch). Each booking is handled in its own
 * transaction with the booking row locked, so concurrent runs or double clicks
 * cannot bill the same days twice.
 * Body: { month, year, payment_terms_days }  (optional overrides)
 */
const bulkGenerateInvoices = async (req, res) => {
  try {
    const orgId  = getOrgId(req);
    const userId = req.login_data.id;
    const now    = new Date();
    const month  = parseInt(req.body.month  || now.getMonth() + 1, 10);
    const year   = parseInt(req.body.year   || now.getFullYear(), 10);
    const paymentTermsDays = parseInt(req.body.payment_terms_days ?? 15, 10);
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
      return res.status(400).json(errBody('month must be 1–12 and year a valid year.'));
    }
    if (!(paymentTermsDays >= 0)) {
      return res.status(400).json(errBody('payment_terms_days must be 0 or more.'));
    }

    // Guard: period must not be closed
    const closedPeriod = await db('edx_period_closing')
      .where({ org_id: orgId, period_month: month, period_year: year, status: 'Closed' })
      .first();
    if (closedPeriod) {
      return res.status(400).json(errBody(
        `Period ${month}/${year} is closed. Invoices cannot be generated for a closed period.`,
      ));
    }

    const monthStr   = String(month).padStart(2, '0');
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd   = new Date(year, month, 0);

    const bookings = await db('edx_bookings')
      .where({ org_id: orgId, status: '4' })  // Active
      .whereNotNull('final_rate')
      .select('id', 'final_rate', 'service_start_date', 'service_end_date', 'user_id');

    if (bookings.length === 0) {
      return res.json({ message: 'No bookings need invoicing this month.', generated: 0 });
    }

    let generated = 0;
    const dueDateStr = formatLocalDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + paymentTermsDays));

    for (const booking of bookings) {
      try {
        const rate  = Number(booking.final_rate);
        const start = parseLocalDate(booking.service_start_date);
        if (!(rate > 0) || !start) continue;
        // Open-ended bookings run to the end of the month.
        const end  = parseLocalDate(booking.service_end_date) || monthEnd;
        const from = start > monthStart ? start : monthStart;
        const to   = end < monthEnd ? end : monthEnd;
        if (to < from) continue;

        generated += await withTransaction(async (trx) => {
          const locked = await trx('edx_bookings')
            .where({ id: booking.id, org_id: orgId })
            .forUpdate()
            .first('id');
          if (!locked) return 0;

          // Dates are VARCHAR in mixed formats — compare in JS. An invoice with
          // no end date is treated as covering the whole month (never bill
          // twice when unsure).
          const existing = await trx('edx_invoice')
            .where({ booking_id: booking.id })
            .select('inv_start', 'inv_end');
          const covered = existing
            .map((i) => ({ start: parseLocalDate(i.inv_start), end: parseLocalDate(i.inv_end) || to }))
            .filter((c) => c.start);

          const gaps = uncoveredSegments(from, to, covered);
          for (const gap of gaps) {
            await trx('edx_invoice').insert(withOrg(req, {
              booking_id:      booking.id,
              inv_raised_amnt: round2(gap.days * rate),
              inv_start:       formatLocalDate(gap.start),
              inv_end:         formatLocalDate(gap.end),
              inv_date:        getCurrentDateTime(),
              due_date:        dueDateStr,
              invoice_type:    'Regular',
              created_by:      userId,
              created_on:      getCurrentDateTime(),
            }));
          }
          return gaps.length;
        });
      } catch (rowErr) {
        logger.warn(`[bulkInvoice] booking #${booking.id} skipped: ${rowErr.message}`);
      }
    }

    res.json({
      message: generated
        ? `${generated} invoice(s) generated for ${monthStr}/${year}.`
        : 'No bookings need invoicing this month.',
      generated,
    });
  } catch (err) {
    logger.error(`Error bulkGenerateInvoices: ${err.message}`);
    res.status(500).json(errBody('An error occurred during bulk invoice generation.'));
  }
};

// ── 14. Close Period ──────────────────────────────────────────────────────────

/**
 * POST /api/closePeriod
 * Body: { month, year }
 * Locks the specified accounting period so no new invoices/receipts can be backdated.
 */
const closePeriod = async (req, res) => {
  try {
    const month = parseInt(req.body.month, 10);
    const year  = parseInt(req.body.year, 10);
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
      return res.status(400).json(errBody('month (1–12) and year are required.'));
    }
    const orgId = getOrgId(req);

    const existing = await db('edx_period_closing')
      .where({ org_id: orgId, period_month: month, period_year: year })
      .first();

    if (existing) {
      return res.status(409).json(errBody(`Period ${month}/${year} is already closed.`));
    }

    await db('edx_period_closing').insert({
      org_id:       orgId,
      period_month: month,
      period_year:  year,
      status:       'Closed',
      closed_by:    req.login_data.id,
      closed_at:    getCurrentDateTime(),
    });

    res.json({ message: `Period ${month}/${year} closed successfully.` });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody('This period is already closed.'));
    }
    logger.error(`Error closePeriod: ${err.message}`);
    res.status(500).json(errBody('An error occurred while closing period.'));
  }
};

/**
 * GET /api/getClosedPeriods
 */
const getClosedPeriods = async (req, res) => {
  try {
    const data = await db('edx_period_closing')
      .where({ org_id: getOrgId(req) })
      .orderBy([{ column: 'period_year', order: 'desc' }, { column: 'period_month', order: 'desc' }]);
    res.json(data);
  } catch (err) {
    logger.error(`Error getClosedPeriods: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

// ── 15. Revenue Recognition Dashboard ────────────────────────────────────────

/**
 * GET /api/getRevenueRecognition
 * Returns:
 *   - mrr            Monthly Recurring Revenue (active bookings × monthly equiv rate)
 *   - arr            Annualized
 *   - deferred       Invoiced but service not started
 *   - recognized     Invoiced + service in progress (prorated)
 *   - collected      Actually paid
 *   - churn_count    Cancelled bookings this month
 *   - active_count   Active bookings
 */
const getRevenueRecognition = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const today = new Date();
    // Local calendar dates — toISOString() is a day behind in IST.
    const monthStart = formatLocalDate(new Date(today.getFullYear(), today.getMonth(), 1));
    const monthEnd   = formatLocalDate(new Date(today.getFullYear(), today.getMonth() + 1, 0));

    // Active bookings
    const activeBookings = await db('edx_bookings')
      .where({ org_id: orgId, status: '4' })
      .select('id', 'final_rate', 'service_start_date', 'service_end_date');

    // MRR = sum(final_rate * 30) for live-in type; approximate with 30 days
    const mrr = activeBookings.reduce((sum, b) => {
      const rate = parseFloat(b.final_rate) || 0;
      return sum + rate * 30;
    }, 0);

    // Invoiced (deferred = invoiced for future periods)
    const deferredRows = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .where('i.inv_start', '>', formatLocalDate(today))
      .sum('i.inv_raised_amnt as deferred')
      .first();
    const deferred = Number(deferredRows.deferred) || 0;

    // Recognized = invoice amount for current month invoices
    const recognizedRows = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .whereRaw(`i.inv_start >= ? AND i.inv_start <= ?`, [monthStart, monthEnd])
      .sum('i.inv_raised_amnt as recognized')
      .first();
    const recognized = Number(recognizedRows.recognized) || 0;

    // Collected this month
    const collectedRows = await db('edx_receipts as r')
      .leftJoin('edx_bookings as b', 'r.booking_id', 'b.id')
      .where('r.status', 'Approved')
      .where('b.org_id', orgId)
      .whereRaw(`r.receipt_date >= ? AND r.receipt_date <= ?`, [monthStart, monthEnd])
      .sum('r.total_amount as collected')
      .first();
    const collected = Number(collectedRows.collected) || 0;

    // Churn (cancelled this month)
    const churnRows = await db('edx_service_closed as sc')
      .leftJoin('edx_bookings as b', 'sc.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .whereRaw(`sc.created_on >= ? AND sc.created_on <= ?`, [monthStart, monthEnd])
      .count('sc.id as churn_count')
      .first();
    const churnCount = Number(churnRows.churn_count) || 0;

    res.json({
      mrr:           Math.round(mrr),
      arr:           Math.round(mrr * 12),
      deferred:      Math.round(deferred),
      recognized:    Math.round(recognized),
      collected:     Math.round(collected),
      churn_count:   churnCount,
      active_count:  activeBookings.length,
      period:        `${monthStart} to ${monthEnd}`,
    });
  } catch (err) {
    logger.error(`Error getRevenueRecognition: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching revenue recognition data.'));
  }
};

// ── 16. Insurance Claims ──────────────────────────────────────────────────────

/**
 * POST /api/createInsuranceClaim
 */
const createInsuranceClaim = async (req, res) => {
  try {
    const { booking_id, user_id, tpa_name, policy_number, pre_auth_number, claim_amount, remarks } = req.body;
    if (!booking_id) return res.status(400).json(errBody('booking_id is required.'));
    const amount = parseMoney(claim_amount);
    if (amount === null || amount <= 0) {
      return res.status(400).json(errBody('claim_amount must be a number greater than zero.'));
    }

    // The booking must be this org's — otherwise the claims list would expose
    // another tenant's client and patient details.
    const booking = await db('edx_bookings').where({ id: booking_id, org_id: getOrgId(req) }).first('id', 'user_id');
    if (!booking) return res.status(404).json(errBody('Booking not found.'));
    if (disagrees(user_id, booking.user_id)) {
      return res.status(400).json(errBody('user_id does not match the booking client.'));
    }

    const [id] = await db('edx_insurance_claims').insert(withOrg(req, {
      booking_id,
      user_id:        booking.user_id,
      tpa_name:       tpa_name       || null,
      policy_number:  policy_number  || null,
      pre_auth_number:pre_auth_number|| null,
      claim_amount:   round2(amount),
      remarks:        remarks        || null,
      status:         'Pending',
      created_by:     req.login_data.id,
      created_on:     getCurrentDateTime(),
    }));

    const claim = await db('edx_insurance_claims').where({ id, org_id: getOrgId(req) }).first();
    res.status(201).json({ message: 'Insurance claim created.', data: claim });
  } catch (err) {
    logger.error(`Error createInsuranceClaim: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

/**
 * PATCH /api/updateInsuranceClaim
 * Body: { id, status, settled_amount, remarks, settled_date }
 */
const updateInsuranceClaim = async (req, res) => {
  try {
    const { id, status, settled_amount, remarks, settled_date } = req.body;
    if (!id || !status) return res.status(400).json(errBody('id and status required.'));

    const validStatuses = ['Pending', 'Submitted', 'Approved', 'Rejected', 'Settled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json(errBody(`status must be one of: ${validStatuses.join(', ')}`));
    }

    const claim = await db('edx_insurance_claims').where({ id, org_id: getOrgId(req) }).first();
    if (!claim) return res.status(404).json(errBody('Claim not found.'));

    // Claims move forward only; Rejected and Settled are final.
    const transitions = {
      Pending:   ['Pending', 'Submitted', 'Rejected'],
      Submitted: ['Submitted', 'Approved', 'Rejected'],
      Approved:  ['Approved', 'Settled'],
    };
    if (!(transitions[claim.status] || []).includes(status)) {
      return res.status(400).json(errBody(`A ${claim.status} claim cannot be moved to ${status}.`));
    }

    const updateData = {
      status,
      remarks:     remarks     || undefined,
      updated_by:  req.login_data.id,
      updated_on:  getCurrentDateTime(),
    };
    if (status === 'Settled' || settled_amount !== undefined) {
      const settled = parseMoney(settled_amount);
      const cap = parseMoney(claim.claim_amount);
      if (settled === null || settled <= 0 || (cap !== null && settled > cap + MONEY_EPS)) {
        return res.status(400).json(errBody(
          `settled_amount must be more than zero and at most the claim amount${cap !== null ? ` (₹${fmt2(cap)})` : ''}.`));
      }
      updateData.settled_amount = round2(settled);
    }
    if (settled_date)                 updateData.settled_date   = settled_date;

    const updated = await db('edx_insurance_claims')
      .where({ id, status: claim.status })
      .andWhere('org_id', getOrgId(req))
      .update(updateData);

    if (!updated) return res.status(409).json(errBody('Claim was updated by someone else. Refresh and try again.'));
    res.json({ message: `Claim updated to ${status}.` });
  } catch (err) {
    logger.error(`Error updateInsuranceClaim: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

/**
 * GET /api/getInsuranceClaims?booking_id=&status=
 */
const getInsuranceClaims = async (req, res) => {
  try {
    // Joins are org-scoped: a claim can never surface another tenant's
    // booking, client or patient.
    let query = db('edx_insurance_claims as ic')
      .leftJoin('edx_bookings as b', function () {
        this.on('ic.booking_id', 'b.id').andOn('b.org_id', 'ic.org_id');
      })
      .leftJoin('edx_client_app_users as u', function () {
        this.on('b.user_id', 'u.id').andOn('u.org_id', 'ic.org_id');
      })
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .where('ic.org_id', getOrgId(req))
      .select(
        'ic.*',
        'u.user_name   as client_name',
        'u.phone_number as client_mobile',
        'p.patient_name',
      )
      .orderBy('ic.id', 'desc');

    if (req.query.booking_id) query = query.where('ic.booking_id', req.query.booking_id);
    if (req.query.status)     query = query.where('ic.status',     req.query.status);

    const data = await query;
    res.json(data);
  } catch (err) {
    logger.error(`Error getInsuranceClaims: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

// ── 17. Cancellation Billing Preview ──────────────────────────────────────────

/**
 * GET /api/getCancellationBilling?booking_id=X&cancel_date=YYYY-MM-DD
 * Returns the billing summary for cancelling a booking at a given date.
 * Does NOT cancel — just returns the calculation for display.
 */
const getCancellationBilling = async (req, res) => {
  try {
    const { booking_id, cancel_date } = req.query;
    if (!booking_id) return res.status(400).json(errBody('booking_id is required.'));

    const booking = await db('edx_bookings as b')
      .leftJoin('edx_client_app_users as u', 'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',       'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
      .where('b.id', booking_id)
      .where('b.org_id', getOrgId(req))
      .select(
        'b.*',
        'u.user_name   as client_name',
        'u.phone_number as client_mobile',
        'p.patient_name',
        'ms.name as service_name',
      )
      .first();

    if (!booking) return res.status(404).json(errBody('Booking not found.'));

    const cancelDate = parseLocalDate(cancel_date) ? cancel_date : formatLocalDate(new Date());

    // Same calculation cancelUserService settles with: against what was
    // invoiced, net of refunds already paid out.
    const st = await computeCancellationSettlement(db, { booking, orgId: getOrgId(req), cancelDate });
    if (!st) return res.status(400).json(errBody('This booking has no valid start date or daily rate to bill.'));

    res.json({
      booking_id:         parseInt(booking_id),
      client_name:        booking.client_name,
      patient_name:       booking.patient_name,
      service_name:       booking.service_name,
      service_start:      booking.service_start_date,
      cancel_date:        cancelDate,
      daily_rate:         st.daily_rate,
      days_used:          st.days_used,
      amount_due:         st.amount_due,
      total_billed:       st.total_billed,
      total_paid:         st.total_paid,
      total_refunded:     st.total_refunded,
      invoice_amount:     st.invoice_amount,       // extra invoice on cancel
      credit_note_amount: st.credit_note_amount,   // credit for unused, billed days
      balance:            st.balance,
      refundable:         st.refundable,           // client overpaid
      owing:              st.owing,                // client still owes
      action_required:    st.balance > MONEY_EPS ? 'RAISE_INVOICE'
        : st.balance < -MONEY_EPS ? 'PROCESS_REFUND' : 'SETTLED',
    });
  } catch (err) {
    logger.error(`Error getCancellationBilling: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

// ── 18. Payment Links ─────────────────────────────────────────────────────────

/**
 * POST /api/createPaymentLink
 * Body: { invoice_id, amount }
 * Creates a manual payment link record.
 * (Razorpay integration: replace with Razorpay SDK call when keys are configured)
 */
const createPaymentLink = async (req, res) => {
  try {
    const { invoice_id, amount } = req.body;
    if (!invoice_id || !amount) {
      return res.status(400).json(errBody('invoice_id and amount are required.'));
    }
    const linkAmount = parseMoney(amount);
    if (linkAmount === null || linkAmount <= 0) {
      return res.status(400).json(errBody('amount must be a number greater than zero.'));
    }
    const orgId  = getOrgId(req);
    const userId = req.login_data.id;

    // Ownership check: the invoice must belong to the caller's org. Prevents a
    // cross-org IDOR that would leak another tenant's client PII and let a
    // payment link be raised against their invoice.
    const inv = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .leftJoin('edx_client_app_users as u', 'b.user_id', 'u.id')
      .where('i.id', invoice_id)
      .andWhere('i.org_id', orgId)
      .select('u.user_name', 'u.phone_number as user_mobile', 'u.user_email', 'i.booking_id')
      .first();
    if (!inv) {
      return res.status(404).json(errBody('Invoice not found.'));
    }

    // Check if Razorpay is configured
    const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
    const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

    let razorpayLinkId = null;
    let linkUrl        = null;

    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      // Real Razorpay integration
      try {
        const Razorpay = require('razorpay');
        const rzp = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

        const payLink = await rzp.paymentLink.create({
          amount:      Math.round(linkAmount * 100), // paise
          currency:    'INR',
          description: `Invoice #${invoice_id} — Eldivex`,
          customer: {
            name:  inv?.user_name  || 'Client',
            email: inv?.user_email || undefined,
            contact: inv?.user_mobile || undefined,
          },
          // The webhook resolves the invoice (and its org) from these notes.
          notes: { invoice_id: String(invoice_id), org_id: String(orgId) },
          notify: { sms: true, email: true },
          reminder_enable: true,
          callback_url: `${process.env.APP_BASE_URL || ''}/payment-success`,
          callback_method: 'get',
        });
        razorpayLinkId = payLink.id;
        linkUrl        = payLink.short_url;
      } catch (rzpErr) {
        logger.warn(`[Razorpay] link creation failed: ${rzpErr.message}`);
      }
    }

    // If Razorpay not configured or failed, create a manual record
    if (!linkUrl) {
      linkUrl = `${process.env.APP_BASE_URL || 'http://localhost:4000'}/pay/invoice/${invoice_id}`;
    }

    const [id] = await db('edx_payment_links').insert({
      invoice_id:      invoice_id,
      razorpay_link_id: razorpayLinkId,
      link_url:        linkUrl,
      amount:          Number(amount),
      status:          'Created',
      org_id:          orgId,
      created_by:      userId,
      created_on:      getCurrentDateTime(),
    });

    res.status(201).json({
      message:  'Payment link created.',
      link_url: linkUrl,
      link_id:  id,
    });
  } catch (err) {
    logger.error(`Error createPaymentLink: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

/**
 * POST /api/razorpay/webhook  (public — authenticated by the Razorpay signature)
 * Receives payment.captured / payment_link.paid → auto-creates an Approved
 * receipt in the invoice's org. Deduplicated via edx_payment_webhook_events.
 */
const razorpayWebhook = async (req, res) => {
  try {
    // Signature is mandatory: without a configured secret every payload would
    // be forgeable, so the endpoint refuses to run at all.
    const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!RAZORPAY_WEBHOOK_SECRET) {
      logger.error('[webhook] RAZORPAY_WEBHOOK_SECRET is not set — rejecting webhook.');
      return res.status(503).json(errBody('Payment webhook is not configured.'));
    }

    // HMAC over the exact raw bytes Razorpay signed (req.rawBody, kept by the
    // JSON parser) — re-serialising req.body would not match byte for byte.
    const signature = String(req.headers['x-razorpay-signature'] || '');
    const raw = req.rawBody;
    if (!signature || !raw || !raw.length) {
      return res.status(400).json(errBody('Invalid webhook signature.'));
    }
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json(errBody('Invalid webhook signature.'));
    }

    const event = req.body || {};
    if (event.event !== 'payment.captured' && event.event !== 'payment_link.paid') {
      return res.status(200).json({ message: 'Event ignored.' });
    }

    const payment = event.payload?.payment?.entity;
    if (!payment || !payment.id) return res.status(400).json(errBody('No payment entity.'));

    const paymentId = String(payment.id);
    const amountINR = (Number(payment.amount) || 0) / 100;
    const notes     = payment.notes || event.payload?.payment_link?.entity?.notes || {};
    let invoiceId   = parseInt(notes.invoice_id, 10) || null;

    // Links created before notes were set: resolve via the stored link id.
    const linkId = event.payload?.payment_link?.entity?.id || payment.payment_link_id;
    if (!invoiceId && linkId) {
      const link = await db('edx_payment_links').where({ razorpay_link_id: linkId }).first('invoice_id');
      invoiceId = link?.invoice_id || null;
    }
    if (!invoiceId) {
      logger.warn(`[webhook] Payment ${paymentId} carries no invoice reference.`);
      return res.status(200).json({ message: 'No invoice_id in notes.' });
    }

    const result = await withTransaction(async (trx) => {
      // Idempotency: one row per payment. A retry / replay hits the unique key.
      let eventRowId;
      try {
        [eventRowId] = await trx('edx_payment_webhook_events').insert({
          provider:    'razorpay',
          event_id:    req.headers['x-razorpay-event-id'] || null,
          event_type:  event.event,
          payment_id:  paymentId,
          invoice_id:  invoiceId,
          amount:      amountINR,
          status:      'received',
          received_on: getCurrentDateTime(),
        });
      } catch (dupErr) {
        if (dupErr.code === 'ER_DUP_ENTRY') return { duplicate: true };
        throw dupErr;
      }

      // The invoice row decides the org — never the payload.
      const inv = await trx('edx_invoice').where({ id: invoiceId }).forUpdate().first();
      if (!inv) {
        await trx('edx_payment_webhook_events').where({ id: eventRowId }).update({ status: 'ignored' });
        return { ignored: 'Invoice not found.' };
      }
      if (notes.org_id && String(notes.org_id) !== String(inv.org_id)) {
        logger.warn(`[webhook] Payment ${paymentId}: notes.org_id ${notes.org_id} ≠ invoice org ${inv.org_id}.`);
        await trx('edx_payment_webhook_events').where({ id: eventRowId }).update({ status: 'ignored', org_id: inv.org_id });
        return { ignored: 'Organisation mismatch.' };
      }

      const orgId   = inv.org_id;
      const booking = await trx('edx_bookings').where({ id: inv.booking_id, org_id: orgId }).first('user_id');
      const countRow = await trx('edx_receipts').where({ org_id: orgId }).count('id as cnt').first();
      const receipt_number = `RCP-${orgId}-${String((Number(countRow?.cnt) || 0) + 1).padStart(6, '0')}`;

      const [receiptId] = await trx('edx_receipts').insert({
        receipt_number,
        booking_id:     inv.booking_id,
        invoice_id:     inv.id,
        user_id:        booking?.user_id ?? null,
        amount:         amountINR,
        tax_amount:     0,
        total_amount:   amountINR,
        payment_mode:   'Online',
        transaction_id: paymentId,
        receipt_date:   formatLocalDate(new Date()),
        status:         'Approved',
        receipt_type:   'Payment',
        org_id:         orgId,
        created_on:     getCurrentDateTime(),
      });

      await trx('edx_payment_links')
        .where({ invoice_id: inv.id, org_id: orgId })
        .where('status', 'Created')
        .update({ status: 'Paid', paid_at: getCurrentDateTime() });

      await trx('edx_payment_webhook_events').where({ id: eventRowId })
        .update({ status: 'processed', org_id: orgId, receipt_id: receiptId });

      return { receiptId, orgId, bookingId: inv.booking_id };
    });

    if (result.duplicate) return res.status(200).json({ message: 'Already processed.' });
    if (result.ignored) return res.status(200).json({ message: result.ignored });

    logger.info(`[webhook] Auto-receipt #${result.receiptId} for invoice #${invoiceId}, ₹${amountINR} (org ${result.orgId})`);
    notifyOrgAdmins(result.orgId, {
      type:  'receipt',
      title: `Online payment received — ₹${Number(amountINR).toLocaleString('en-IN')}`,
      body:  `Razorpay payment ${paymentId} recorded against invoice INV-${invoiceId}.`,
      data:  { receipt_id: result.receiptId, booking_id: result.bookingId, route: 'accounts' },
    });
    res.status(200).json({ message: 'Receipt auto-created.' });
  } catch (err) {
    logger.error(`Error razorpayWebhook: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

// ── 19. Rate History ──────────────────────────────────────────────────────────

/**
 * GET /api/getRateHistory?booking_id=X
 */
const getRateHistory = async (req, res) => {
  try {
    const { booking_id } = req.query;
    if (!booking_id) return res.status(400).json(errBody('booking_id is required.'));

    const data = await db('edx_rate_history as rh')
      .leftJoin('edx_web_app_users as u', 'rh.changed_by', 'u.id')
      .where('rh.booking_id', booking_id)
      .where('rh.org_id', getOrgId(req))
      .select('rh.*', 'u.user_name as changed_by_name')
      .orderBy('rh.id', 'desc');

    res.json(data);
  } catch (err) {
    logger.error(`Error getRateHistory: ${err.message}`);
    res.status(500).json(errBody('An error occurred.'));
  }
};

// ── 20. Get Receipts ──────────────────────────────────────────────────────────

/**
 * GET /api/getReceipts?booking_id=&status=&period_from=&period_to=
 */
const getReceipts = async (req, res) => {
  try {
    let query = db('edx_receipts as r')
      .leftJoin('edx_bookings as b',       'r.booking_id', 'b.id')
      .leftJoin('edx_client_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .where('r.org_id', getOrgId(req))
      .select(
        'r.*',
        // The number on the receipt the client was emailed; REC-<id> only
        // for legacy rows that never got one.
        db.raw("COALESCE(NULLIF(r.receipt_number, ''), CONCAT('REC-', r.id)) as receipt_number"),
        'u.user_name   as client_name',
        'u.phone_number as client_mobile',
        'p.patient_name',
        'ms.name as service_name',
      )
      .orderBy('r.id', 'desc');

    if (req.query.booking_id)  query = query.where('r.booking_id',  req.query.booking_id);
    if (req.query.status)      query = query.where('r.status',      req.query.status);
    if (req.query.period_from) query = query.where('r.period_from', '>=', req.query.period_from);
    if (req.query.period_to)   query = query.where('r.period_to',   '<=', req.query.period_to);

    const limit  = parseInt(req.query.limit)  || 200;
    const offset = parseInt(req.query.offset) || 0;
    const data = await query.limit(limit).offset(offset);
    res.json(data);
  } catch (err) {
    logger.error(`Error getReceipts: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching receipts.'));
  }
};

// ── 21. Get Write-Offs ────────────────────────────────────────────────────────

/**
 * GET /api/getWriteOffs?booking_id=&status=
 */
const getWriteOffs = async (req, res) => {
  try {
    let query = db('edx_write_offs as wo')
      .leftJoin('edx_bookings as b',       'wo.booking_id', 'b.id')
      .leftJoin('edx_client_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .where('wo.org_id', getOrgId(req))
      .select(
        'wo.*',
        'u.user_name   as client_name',
        'u.phone_number as client_mobile',
        'p.patient_name',
        'ms.name as service_name',
      )
      .orderBy('wo.id', 'desc');

    if (req.query.booking_id) query = query.where('wo.booking_id', req.query.booking_id);
    if (req.query.status)     query = query.where('wo.status',     req.query.status);

    const limit  = parseInt(req.query.limit)  || 200;
    const offset = parseInt(req.query.offset) || 0;
    const data = await query.limit(limit).offset(offset);
    res.json(data);
  } catch (err) {
    logger.error(`Error getWriteOffs: ${err.message}`);
    res.status(500).json(errBody('An error occurred while fetching write-offs.'));
  }
};

// ════════════════════════════════════════════════════════════════════
// PHASE 2.4 EXTENSION — Transaction Ledger, Write-Off V2, Refund,
// Credit Note Application, Internal Transfer  (Added 2026-06-06)
// ════════════════════════════════════════════════════════════════════

// ── Internal Helpers ─────────────────────────────────────────────────────────

// Thrown inside a transaction when the locked row is no longer in the state
// the request expects (a concurrent approval won the race).
class StateConflict extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

// Maker-checker: the user who raised a request may not approve it.
const _isOwnRequest = (row, userId) =>
  userId != null && [row?.created_by, row?.requested_by].some((v) => v != null && String(v) === String(userId));

function _determineApprovalLevel(amount) {
  if (amount <= 500) return 'L1';
  if (amount <= 5000) return 'L2';
  return 'L3';
}

async function _addApprovalHistory(trxOrDb, { orgId, referenceType, referenceId, action, actionBy, notes, approvalLevel }) {
  await trxOrDb('edx_approval_history').insert({
    org_id: orgId,
    reference_type: referenceType,
    reference_id: referenceId,
    action,
    action_by: actionBy,
    notes: notes || null,
    approval_level: approvalLevel || null,
    action_on: getCurrentDateTime(),
  });
}

// ── getTransactionLedger ─────────────────────────────────────────────────────

const getTransactionLedger = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { booking_id, client_id, from_date, to_date, limit = 100, offset = 0 } = req.query;
    let q = db('edx_transaction_ledger as tl')
      .leftJoin('edx_web_app_users as u', 'u.id', 'tl.created_by')
      .where('tl.org_id', orgId)
      .select(
        'tl.*',
        db.raw("IFNULL(u.user_name, '') as created_by_name")
      )
      .orderBy('tl.id', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    if (booking_id) q = q.where('tl.booking_id', booking_id);
    if (client_id) q = q.where('tl.client_id', client_id);
    if (from_date) q = q.where('tl.created_on', '>=', from_date);
    if (to_date) q = q.where('tl.created_on', '<=', to_date + ' 23:59:59');
    const data = await q;
    const countQ = db('edx_transaction_ledger').where('org_id', orgId);
    if (booking_id) countQ.where('booking_id', booking_id);
    if (client_id) countQ.where('client_id', client_id);
    if (from_date) countQ.where('created_on', '>=', from_date);
    if (to_date) countQ.where('created_on', '<=', to_date + ' 23:59:59');
    const [{ total }] = await countQ.count('id as total');
    return res.json({ data, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    logger.error(`getTransactionLedger error: ${err.message}`);
    return res.status(500).json(errBody('Failed to fetch transaction ledger'));
  }
};

// ── Outstanding: billed / paid from source tables ────────────────────────────
// Invoices and receipts are never posted to edx_transaction_ledger (only
// write-offs, refunds, credit-note applications and transfers are), so billed
// and paid come from edx_invoice / approved edx_receipts — the same figures
// getActiveClients and the write-off guard use. Adjustments stay ledger-based.

// Booking ids in scope: one client's bookings, or a single booking.
const _outstandingBookingScope = (orgId, { clientId, bookingId }) => {
  const q = db('edx_bookings').where('org_id', orgId).select('id');
  if (clientId != null) q.where('user_id', clientId);
  if (bookingId != null) q.where('id', bookingId);
  return q;
};

async function _billedAndPaid(orgId, scope) {
  const [inv, rec] = await Promise.all([
    db('edx_invoice')
      .whereIn('booking_id', _outstandingBookingScope(orgId, scope))
      .sum('inv_raised_amnt as total')
      .first(),
    db('edx_receipts')
      .whereIn('booking_id', _outstandingBookingScope(orgId, scope))
      .where('status', 'Approved')
      .sum('total_amount as total')
      .first(),
  ]);
  return { billed: parseFloat(inv?.total) || 0, paid: parseFloat(rec?.total) || 0 };
}

// ── getClientOutstanding ─────────────────────────────────────────────────────

const getClientOutstanding = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { clientId } = req.params;
    const rows = await db('edx_transaction_ledger')
      .where({ org_id: orgId, client_id: clientId, status: 'COMPLETED' })
      .select(
        'transaction_type',
        'direction',
        db.raw('SUM(amount) as total')
      )
      .groupBy('transaction_type', 'direction');

    const totals = {};
    rows.forEach(r => {
      totals[r.transaction_type] = (totals[r.transaction_type] || 0) + parseFloat(r.total);
    });

    const { billed: totalBilled, paid: totalPaid } =
      await _billedAndPaid(orgId, { clientId: parseInt(clientId) });
    const totalWriteOff = totals['WRITE_OFF'] || 0;
    const totalCreditNoteApplied = totals['CREDIT_NOTE_APPLIED'] || 0;
    const totalRefunded = totals['REFUND'] || 0;
    const totalTransferIn = totals['INTERNAL_TRANSFER_IN'] || 0;
    const totalTransferOut = totals['INTERNAL_TRANSFER_OUT'] || 0;
    const outstandingAmount = totalBilled - totalPaid - totalWriteOff - totalCreditNoteApplied - totalTransferIn + totalTransferOut + totalRefunded;

    return res.json({
      clientId: parseInt(clientId),
      totalBilled,
      totalPaid,
      totalWriteOff,
      totalCreditNoteApplied,
      totalRefunded,
      totalInternalTransferIn: totalTransferIn,
      totalInternalTransferOut: totalTransferOut,
      outstandingAmount,
    });
  } catch (err) {
    logger.error(`getClientOutstanding error: ${err.message}`);
    return res.status(500).json(errBody('Failed to compute outstanding'));
  }
};

// ── getBookingOutstanding ────────────────────────────────────────────────────

const getBookingOutstanding = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { bookingId } = req.params;
    const rows = await db('edx_transaction_ledger')
      .where({ org_id: orgId, booking_id: bookingId, status: 'COMPLETED' })
      .select('transaction_type', 'direction', db.raw('SUM(amount) as total'))
      .groupBy('transaction_type', 'direction');

    const totals = {};
    rows.forEach(r => { totals[r.transaction_type] = (totals[r.transaction_type] || 0) + parseFloat(r.total); });

    const { billed: totalBilled, paid: totalPaid } =
      await _billedAndPaid(orgId, { bookingId: parseInt(bookingId) });
    const totalWriteOff = totals['WRITE_OFF'] || 0;
    const totalCreditNoteApplied = totals['CREDIT_NOTE_APPLIED'] || 0;
    const totalRefunded = totals['REFUND'] || 0;
    const totalTransferIn = totals['INTERNAL_TRANSFER_IN'] || 0;
    const totalTransferOut = totals['INTERNAL_TRANSFER_OUT'] || 0;
    const outstandingAmount = totalBilled - totalPaid - totalWriteOff - totalCreditNoteApplied - totalTransferIn + totalTransferOut + totalRefunded;

    return res.json({
      bookingId: parseInt(bookingId),
      totalBilled, totalPaid, totalWriteOff, totalCreditNoteApplied,
      totalRefunded, totalInternalTransferIn: totalTransferIn, totalInternalTransferOut: totalTransferOut,
      outstandingAmount,
    });
  } catch (err) {
    logger.error(`getBookingOutstanding error: ${err.message}`);
    return res.status(500).json(errBody('Failed to compute booking outstanding'));
  }
};

// ── createWriteOffV2 ─────────────────────────────────────────────────────────

const createWriteOffV2 = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { booking_id, user_id, write_off_type = 'BAD_DEBT', invoice_ids = [], write_off_amount, reason, remarks } = req.body;

    if (!booking_id || !write_off_amount || !reason) return res.status(400).json(errBody('booking_id, write_off_amount and reason are required'));
    const amount = parseMoney(write_off_amount);
    if (amount === null || amount <= 0) return res.status(400).json(errBody('write_off_amount must be a positive number'));
    if (!WRITE_OFF_TYPES.includes(write_off_type)) return res.status(400).json(enumError('write_off_type', WRITE_OFF_TYPES));

    const booking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first();
    if (!booking) return res.status(404).json(errBody('Booking not found'));
    if (booking.status == 6) return res.status(400).json(errBody('Cannot write off a cancelled booking'));
    if (disagrees(user_id, booking.user_id)) return res.status(400).json(errBody('user_id does not match the booking client'));

    const existing = await db('edx_write_offs').where({ booking_id, org_id: orgId, status: 'Pending' }).first();
    if (existing) return res.status(400).json(errBody('A pending write-off already exists for this booking'));

    // Invoices named on the write-off must be this booking's.
    const invoiceIds = Array.isArray(invoice_ids) ? invoice_ids.filter((v) => v !== null && v !== '') : [];
    if (invoiceIds.length) {
      const own = await db('edx_invoice').where({ booking_id, org_id: orgId }).whereIn('id', invoiceIds).select('id');
      if ((own || []).length !== new Set(invoiceIds.map(String)).size) {
        return res.status(400).json(errBody('invoice_ids must all belong to this booking'));
      }
    }

    // Cap at what the booking still owes (net of earlier adjustments).
    const { outstandingAmount } = await _computeOutstanding(orgId, { bookingId: booking_id });
    if (amount > outstandingAmount + MONEY_EPS) {
      return res.status(400).json(errBody(
        `Write-off amount (₹${fmt2(amount)}) exceeds outstanding balance (₹${fmt2(Math.max(0, outstandingAmount))}).`,
        { outstanding: round2(outstandingAmount) },
      ));
    }

    const approvalLevel = _determineApprovalLevel(amount);
    const now = getCurrentDateTime();

    const [id] = await db('edx_write_offs').insert(withOrg(req, {
      booking_id,
      user_id: booking.user_id,
      write_off_amount: round2(amount),
      write_off_type,
      invoice_ids: JSON.stringify(invoiceIds),
      reason,
      remarks: remarks || null,
      approval_level: approvalLevel,
      status: 'Pending',
      write_off_date: now,
      created_by: userId,
      created_on: now,
      updated_by: userId,
      updated_on: now,
    }));

    await _addApprovalHistory(db, {
      orgId, referenceType: 'WRITE_OFF', referenceId: id,
      action: 'SUBMITTED', actionBy: userId,
      approvalLevel: approvalLevel === 'L1' ? 1 : approvalLevel === 'L2' ? 2 : 3,
    });

    const created = await db('edx_write_offs').where('id', id).first();
    return res.json(created);
  } catch (err) {
    logger.error(`createWriteOffV2 error: ${err.message}`);
    return res.status(500).json(errBody('Failed to create write-off'));
  }
};

// ── approveWriteOff ──────────────────────────────────────────────────────────

/**
 * Approves a Pending write-off in one transaction: locks the write-off and its
 * booking, re-checks the booking still owes at least the write-off amount,
 * posts the WRITE_OFF ledger entry and records the approver. Shared by
 * approveWriteOff and the legacy updateWriteOffStatus, so both paths reach the
 * ledger. Throws StateConflict (409 already processed, 400 over the balance).
 */
async function _approveWriteOffTx(orgId, userId, writeOffId, notes) {
  return withTransaction(async (trx) => {
    const locked = await trx('edx_write_offs').where({ id: writeOffId, org_id: orgId }).forUpdate().first();
    if (!locked || locked.status !== 'Pending') throw new StateConflict('Write-off was already processed.');
    const booking = locked.booking_id
      ? await trx('edx_bookings').where({ id: locked.booking_id, org_id: orgId }).forUpdate().first()
      : null;

    const amount = round2(locked.write_off_amount);
    if (locked.booking_id) {
      const { outstandingAmount } = await _computeOutstanding(orgId, { bookingId: locked.booking_id }, trx);
      if (amount > outstandingAmount + MONEY_EPS) {
        throw new StateConflict(
          `Write-off ₹${fmt2(amount)} exceeds the booking's outstanding balance of ₹${fmt2(Math.max(0, outstandingAmount))}.`,
          400,
        );
      }
    }

    const entryId = await _createTransactionEntry(trx, {
      orgId, clientId: locked.user_id || booking?.user_id, bookingId: locked.booking_id,
      transactionType: 'WRITE_OFF', direction: 'CREDIT',
      amount,
      referenceId: locked.id, referenceType: 'WRITE_OFF',
      description: 'Write-off approved: ' + locked.reason,
      createdBy: userId,
    });
    await trx('edx_write_offs').where({ id: locked.id, org_id: orgId }).update({
      status: 'Approved', approved_by: String(userId),
      transaction_entry_id: entryId, updated_by: userId, updated_on: getCurrentDateTime(),
    });
    await _addApprovalHistory(trx, {
      orgId, referenceType: 'WRITE_OFF', referenceId: locked.id,
      action: 'APPROVED', actionBy: userId, notes,
      approvalLevel: locked.approval_level === 'L1' ? 1 : locked.approval_level === 'L2' ? 2 : 3,
    });
  });
}

// Rejects a Pending write-off; false when it was no longer Pending.
async function _rejectWriteOff(orgId, userId, writeOffId, notes) {
  const changed = await db('edx_write_offs').where({ id: writeOffId, org_id: orgId, status: 'Pending' })
    .update({ status: 'Rejected', updated_by: userId, updated_on: getCurrentDateTime() });
  if (!changed) return false;
  await _addApprovalHistory(db, {
    orgId, referenceType: 'WRITE_OFF', referenceId: writeOffId, action: 'REJECTED', actionBy: userId, notes,
  });
  return true;
}

const approveWriteOff = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { write_off_id, action, notes } = req.body;
    if (!write_off_id || !action) return res.status(400).json(errBody('write_off_id and action required'));
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json(errBody('action must be Approved or Rejected'));

    const wo = await db('edx_write_offs').where({ id: write_off_id, org_id: orgId }).first();
    if (!wo) return res.status(404).json(errBody('Write-off not found'));
    if (wo.status !== 'Pending') return res.status(400).json(errBody('Only Pending write-offs can be approved or rejected'));
    if (action === 'Approved' && _isOwnRequest(wo, userId)) {
      return res.status(403).json(errBody('You cannot approve a write-off you created.'));
    }

    if (action === 'Approved') {
      await _approveWriteOffTx(orgId, userId, wo.id, notes);
    } else if (!(await _rejectWriteOff(orgId, userId, wo.id, notes))) {
      return res.status(409).json(errBody('Write-off was already processed.'));
    }

    const updated = await db('edx_write_offs').where('id', wo.id).first();
    const history = await db('edx_approval_history').where({ reference_type: 'WRITE_OFF', reference_id: wo.id, org_id: orgId }).orderBy('id');
    return res.json({ ...updated, approval_history: history });
  } catch (err) {
    if (err instanceof StateConflict) return res.status(err.status).json(errBody(err.message));
    logger.error(`approveWriteOff error: ${err.message}`);
    return res.status(500).json(errBody('Failed to update write-off status'));
  }
};

/**
 * Per-invoice amount / paid / credited / balance for the given bookings, via
 * allocateInvoicePayments: receipts linked to an invoice pay it first,
 * unlinked receipts are spread FIFO by inv_start, applied credit notes reduce
 * their invoice. `bookingIds` must already be scoped to the caller's org.
 * Returns Map(String(invoice id) → { amount, paid, credited, balance }).
 */
async function _invoiceAllocations(conn, bookingIds) {
  const ids = [...new Set((bookingIds || []).filter((v) => v != null))];
  if (!ids.length) return new Map();
  const invoices = await conn('edx_invoice').whereIn('booking_id', ids)
    .select('id', 'booking_id', 'inv_start', 'inv_raised_amnt');
  const receipts = await conn('edx_receipts').whereIn('booking_id', ids).where('status', 'Approved')
    .select('booking_id', 'invoice_id', 'total_amount');
  const invoiceIds = (invoices || []).map((i) => i.id);
  const applications = invoiceIds.length
    ? await conn('edx_credit_note_applications').whereIn('target_invoice_id', invoiceIds).where('status', 'APPLIED')
      .select('target_invoice_id', 'amount_applied')
    : [];
  return allocateInvoicePayments(invoices || [], receipts || [], applications || []);
}

// ── createRefund ─────────────────────────────────────────────────────────────

/**
 * Money a booking can still refund: approved receipts + credit transferred in
 * − credit transferred out − refunds already committed (pending approval,
 * approved, processing or completed). Pass `excludeRefundId` when checking a
 * refund that is itself in that set.
 */
async function _refundableBalance(conn, orgId, bookingId, excludeRefundId = null) {
  const sum = async (q, col) => Number((await q.sum(`${col} as total`).first())?.total) || 0;
  const paid = await sum(
    conn('edx_receipts').where({ booking_id: bookingId, org_id: orgId, status: 'Approved' }), 'total_amount');
  const refundsQ = conn('edx_refunds').where({ booking_id: bookingId, org_id: orgId })
    .whereIn('status', REFUND_COMMITTED_STATUSES);
  if (excludeRefundId != null) refundsQ.where('id', '<>', excludeRefundId);
  const committed = await sum(refundsQ, 'refund_amount');
  const transfers = await conn('edx_transaction_ledger')
    .where({ booking_id: bookingId, org_id: orgId, status: 'COMPLETED' })
    .whereIn('transaction_type', ['INTERNAL_TRANSFER_IN', 'INTERNAL_TRANSFER_OUT'])
    .select('transaction_type', conn.raw('SUM(amount) as total'))
    .groupBy('transaction_type');
  let transferNet = 0;
  for (const t of transfers || []) {
    const amt = Number(t.total) || 0;
    transferNet += t.transaction_type === 'INTERNAL_TRANSFER_IN' ? amt : -amt;
  }
  return round2(paid + transferNet - committed);
}

const createRefund = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { booking_id, client_id, invoice_id, receipt_ids = [], refund_amount, refund_channel, refund_reason, channel_details = {}, notes } = req.body;

    if (!booking_id || !refund_amount || !refund_channel || !refund_reason) {
      return res.status(400).json(errBody('booking_id, refund_amount, refund_channel, refund_reason are required'));
    }
    const amount = parseMoney(refund_amount);
    if (amount === null || amount <= 0) return res.status(400).json(errBody('refund_amount must be positive'));
    if (!REFUND_CHANNELS.includes(refund_channel)) return res.status(400).json(enumError('refund_channel', REFUND_CHANNELS));
    if (!REFUND_REASONS.includes(refund_reason)) return res.status(400).json(enumError('refund_reason', REFUND_REASONS));

    const booking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first();
    if (!booking) return res.status(404).json(errBody('Booking not found'));
    if (disagrees(client_id, booking.user_id)) return res.status(400).json(errBody('client_id does not match the booking client'));

    // The invoice and receipts named on the refund must be this booking's.
    if (invoice_id) {
      const inv = await db('edx_invoice').where({ id: invoice_id, booking_id, org_id: orgId }).first('id');
      if (!inv) return res.status(400).json(errBody('invoice_id does not belong to this booking'));
    }
    const receiptIds = Array.isArray(receipt_ids) ? receipt_ids.filter((v) => v !== null && v !== '') : [];
    if (receiptIds.length) {
      const own = await db('edx_receipts').where({ booking_id, org_id: orgId }).whereIn('id', receiptIds).select('id');
      if ((own || []).length !== new Set(receiptIds.map(String)).size) {
        return res.status(400).json(errBody('receipt_ids must all belong to this booking'));
      }
    }

    // Refundable = what was paid in, net of transfers and of refunds already
    // committed — including ones still awaiting approval.
    const maxRefund = await _refundableBalance(db, orgId, booking_id);
    if (amount > maxRefund + MONEY_EPS) {
      return res.status(400).json(errBody(
        `Refund amount exceeds the refundable balance of ₹${fmt2(Math.max(0, maxRefund))}`,
        { refundable: round2(Math.max(0, maxRefund)) },
      ));
    }

    const approvalLevel = _determineApprovalLevel(amount);
    const now = getCurrentDateTime();

    const [id] = await db('edx_refunds').insert(withOrg(req, {
      client_id: booking.user_id,
      booking_id,
      invoice_id: invoice_id || null,
      receipt_ids: JSON.stringify(receiptIds),
      refund_amount: round2(amount),
      refund_channel,
      refund_reason,
      channel_details: JSON.stringify(channel_details),
      status: 'PENDING_APPROVAL',
      approval_level: approvalLevel,
      requested_by: userId,
      notes: notes || null,
      created_by: userId,
      created_on: now,
      updated_by: userId,
      updated_on: now,
    }));

    await _addApprovalHistory(db, {
      orgId, referenceType: 'REFUND', referenceId: id, action: 'SUBMITTED', actionBy: userId,
      approvalLevel: approvalLevel === 'L1' ? 1 : approvalLevel === 'L2' ? 2 : 3,
    });

    const created = await db('edx_refunds').where('id', id).first();
    return res.json(created);
  } catch (err) {
    logger.error(`createRefund error: ${err.message}`);
    return res.status(500).json(errBody('Failed to create refund'));
  }
};

// ── getRefunds ───────────────────────────────────────────────────────────────

const getRefunds = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { booking_id, status, from_date, to_date } = req.query;
    let q = db('edx_refunds as r')
      .leftJoin('edx_bookings as b', 'b.id', 'r.booking_id')
      .leftJoin('edx_client_app_users as u', function () {
        this.on('u.id', 'r.client_id').andOn('u.org_id', 'r.org_id');
      })
      .leftJoin('edx_web_app_users as rq', 'rq.id', 'r.requested_by')
      .leftJoin('edx_web_app_users as ap', 'ap.id', 'r.approved_by')
      .where('r.org_id', orgId)
      .select('r.*',
        db.raw("IFNULL(u.user_name, '') as client_name"),
        db.raw("CONCAT('BK-', LPAD(b.id, 6, '0')) as booking_ref"),
        db.raw("IFNULL(rq.user_name, '') as requested_by_name"),
        db.raw("IFNULL(ap.user_name, '') as approved_by_name")
      )
      .orderBy('r.id', 'desc');
    if (booking_id) q = q.where('r.booking_id', booking_id);
    if (status) q = q.where('r.status', status);
    if (from_date) q = q.where('r.created_on', '>=', from_date);
    if (to_date) q = q.where('r.created_on', '<=', to_date + ' 23:59:59');
    const data = await q;
    return res.json(data);
  } catch (err) {
    logger.error(`getRefunds error: ${err.message}`);
    return res.status(500).json(errBody('Failed to fetch refunds'));
  }
};

// ── getRefundById ────────────────────────────────────────────────────────────

const getRefundById = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const refund = await db('edx_refunds as r')
      .leftJoin('edx_bookings as b', 'b.id', 'r.booking_id')
      .leftJoin('edx_client_app_users as u', function () {
        this.on('u.id', 'r.client_id').andOn('u.org_id', 'r.org_id');
      })
      .leftJoin('edx_web_app_users as rq', 'rq.id', 'r.requested_by')
      .leftJoin('edx_web_app_users as ap', 'ap.id', 'r.approved_by')
      .where('r.id', id).where('r.org_id', orgId)
      .select('r.*',
        db.raw("IFNULL(u.user_name, '') as client_name"),
        db.raw("CONCAT('BK-', LPAD(b.id, 6, '0')) as booking_ref"),
        db.raw("IFNULL(rq.user_name, '') as requested_by_name"),
        db.raw("IFNULL(ap.user_name, '') as approved_by_name")
      ).first();
    if (!refund) return res.status(404).json(errBody('Refund not found'));
    const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: id, org_id: orgId }).orderBy('id');
    return res.json({ ...refund, approval_history: history });
  } catch (err) {
    logger.error(`getRefundById error: ${err.message}`);
    return res.status(500).json(errBody('Failed to fetch refund'));
  }
};

// ── approveRefund ────────────────────────────────────────────────────────────

const approveRefund = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { refund_id, action, notes, dispatch_details } = req.body;
    if (!refund_id || !action) return res.status(400).json(errBody('refund_id and action required'));

    const refund = await db('edx_refunds').where({ id: refund_id, org_id: orgId }).first();
    if (!refund) return res.status(404).json(errBody('Refund not found'));

    const now = getCurrentDateTime();
    const allowed = { PENDING_APPROVAL: ['Approved', 'Rejected'], APPROVED: ['Processing'], PROCESSING: ['Completed'] };
    if (!allowed[refund.status]?.includes(action)) {
      return res.status(400).json(errBody('Invalid status transition: ' + refund.status + ' → ' + action));
    }
    if (action === 'Approved' && _isOwnRequest(refund, userId)) {
      return res.status(403).json(errBody('You cannot approve a refund you requested.'));
    }

    const updates = { updated_by: userId, updated_on: now };
    let historyAction = action === 'Approved' ? 'APPROVED' : action === 'Rejected' ? 'REJECTED' : 'APPROVED';

    if (action === 'Approved') {
      // Re-check the refundable balance with the booking locked, so two
      // pending refunds can't both be approved past what was paid.
      await withTransaction(async (trx) => {
        await trx('edx_bookings').where({ id: refund.booking_id, org_id: orgId }).forUpdate().first('id');
        const available = await _refundableBalance(trx, orgId, refund.booking_id, refund.id);
        const amt = round2(refund.refund_amount);
        if (amt > available + MONEY_EPS) {
          throw new StateConflict(
            `Refund ₹${fmt2(amt)} exceeds the refundable balance of ₹${fmt2(Math.max(0, available))}.`, 400);
        }
        const changed = await trx('edx_refunds')
          .where({ id: refund.id, org_id: orgId, status: 'PENDING_APPROVAL' })
          .update({ ...updates, status: 'APPROVED', approved_by: userId, approved_at: now });
        if (!changed) throw new StateConflict('Refund was already processed.');
        await _addApprovalHistory(trx, {
          orgId, referenceType: 'REFUND', referenceId: refund.id, action: 'APPROVED', actionBy: userId, notes,
        });
      });
      const updated = await db('edx_refunds').where('id', refund.id).first();
      const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: refund.id, org_id: orgId }).orderBy('id');
      return res.json({ ...updated, approval_history: history });
    } else if (action === 'Rejected') {
      Object.assign(updates, { status: 'REJECTED' });
      historyAction = 'REJECTED';
    } else if (action === 'Processing') {
      Object.assign(updates, { status: 'PROCESSING', processed_by: userId });
    } else if (action === 'Completed') {
      await withTransaction(async (trx) => {
        const locked = await trx('edx_refunds').where({ id: refund.id, org_id: orgId }).forUpdate().first();
        if (!locked || locked.status !== 'PROCESSING') throw new StateConflict('Refund was already processed.');
        const entryId = await _createTransactionEntry(trx, {
          orgId, clientId: refund.client_id, bookingId: refund.booking_id,
          transactionType: 'REFUND', direction: 'DEBIT',
          amount: parseFloat(refund.refund_amount),
          referenceId: refund.id, referenceType: 'REFUND',
          description: 'Refund processed: ' + refund.refund_reason,
          createdBy: userId,
        });
        Object.assign(updates, {
          status: 'COMPLETED', processed_by: userId, processed_at: now,
          transaction_entry_id: entryId,
          dispatch_details: dispatch_details ? JSON.stringify(dispatch_details) : refund.dispatch_details,
        });
        await trx('edx_refunds').where({ id: refund.id, org_id: orgId }).update(updates);
        await _addApprovalHistory(trx, { orgId, referenceType: 'REFUND', referenceId: refund.id, action: 'APPROVED', actionBy: userId, notes });
      });
      const updated = await db('edx_refunds').where('id', refund.id).first();
      const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: refund.id, org_id: orgId }).orderBy('id');
      return res.json({ ...updated, approval_history: history });
    }

    // Conditional on the status we validated, so a concurrent transition loses cleanly.
    const changed = await db('edx_refunds').where({ id: refund.id, org_id: orgId, status: refund.status }).update(updates);
    if (!changed) return res.status(409).json(errBody('Refund was already processed.'));
    await _addApprovalHistory(db, { orgId, referenceType: 'REFUND', referenceId: refund.id, action: historyAction, actionBy: userId, notes });
    const updated = await db('edx_refunds').where('id', refund.id).first();
    const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: refund.id, org_id: orgId }).orderBy('id');
    return res.json({ ...updated, approval_history: history });
  } catch (err) {
    if (err instanceof StateConflict) return res.status(err.status).json(errBody(err.message));
    logger.error(`approveRefund error: ${err.message}`);
    return res.status(500).json(errBody('Failed to update refund status'));
  }
};

// ── getCreditNoteApplications ────────────────────────────────────────────────

const getCreditNoteApplications = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { credit_note_id, booking_id } = req.query;
    let q = db('edx_credit_note_applications as a')
      .leftJoin('edx_credit_notes as cn', 'cn.id', 'a.credit_note_id')
      .leftJoin('edx_invoice as inv', 'inv.id', 'a.target_invoice_id')
      .where('a.org_id', orgId)
      .select('a.*',
        db.raw("CONCAT('INV-', LPAD(inv.id, 6, '0')) as target_invoice_ref")
      ).orderBy('a.id', 'desc');
    if (credit_note_id) q = q.where('a.credit_note_id', credit_note_id);
    if (booking_id) q = q.where('a.target_booking_id', booking_id);
    const data = await q;
    return res.json(data);
  } catch (err) {
    logger.error(`getCreditNoteApplications error: ${err.message}`);
    return res.status(500).json(errBody('Failed to fetch credit note applications'));
  }
};

// ── createInternalTransfer ───────────────────────────────────────────────────

// Transfers that move a credit balance (vs. moving money paid in).
const CREDIT_TRANSFER_TYPES = ['OVERPAYMENT_TRANSFER', 'CREDIT_BALANCE_TRANSFER'];

/**
 * How much may still be transferred out of a booking: its credit balance for
 * credit transfers, or the money paid into it (net of refunds and transfers)
 * for receipt reallocations / service switches — minus other transfers out of
 * it still awaiting approval.
 */
async function _transferableFromBooking(conn, orgId, bookingId, transferType, excludeTransferId = null) {
  const pendingQ = conn('edx_internal_transfers')
    .where({ source_booking_id: bookingId, org_id: orgId, status: 'PENDING_APPROVAL' });
  if (excludeTransferId != null) pendingQ.where('id', '<>', excludeTransferId);
  const pending = Number((await pendingQ.sum('transfer_amount as total').first())?.total) || 0;
  let base;
  if (CREDIT_TRANSFER_TYPES.includes(transferType)) {
    const { outstandingAmount } = await _computeOutstanding(orgId, { bookingId }, conn);
    base = -outstandingAmount;
  } else {
    base = await _refundableBalance(conn, orgId, bookingId);
  }
  return round2(base - pending);
}

const createInternalTransfer = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { client_id, source_booking_id, target_booking_id, transfer_amount, transfer_type, reason, notes } = req.body;
    if (!client_id || !source_booking_id || !target_booking_id || !transfer_amount || !transfer_type || !reason) {
      return res.status(400).json(errBody('client_id, source_booking_id, target_booking_id, transfer_amount, transfer_type, reason are required'));
    }
    if (source_booking_id == target_booking_id) return res.status(400).json(errBody('Source and target bookings must be different'));

    const amount = parseMoney(transfer_amount);
    if (amount === null || amount <= 0) return res.status(400).json(errBody('transfer_amount must be positive'));
    if (!TRANSFER_TYPES.includes(transfer_type)) return res.status(400).json(enumError('transfer_type', TRANSFER_TYPES));

    const [srcBk, tgtBk] = await Promise.all([
      db('edx_bookings').where({ id: source_booking_id, org_id: orgId }).first(),
      db('edx_bookings').where({ id: target_booking_id, org_id: orgId }).first(),
    ]);
    if (!srcBk) return res.status(404).json(errBody('Source booking not found'));
    if (!tgtBk) return res.status(404).json(errBody('Target booking not found'));
    if (srcBk.user_id != tgtBk.user_id) return res.status(400).json(errBody('Both bookings must belong to the same client'));
    if (disagrees(client_id, srcBk.user_id)) return res.status(400).json(errBody('client_id does not match the bookings\' client'));

    // Never move more than the source booking actually has to give.
    const available = await _transferableFromBooking(db, orgId, source_booking_id, transfer_type);
    if (amount > available + MONEY_EPS) {
      return res.status(400).json(errBody(
        `Transfer amount exceeds what the source booking can transfer (₹${fmt2(Math.max(0, available))}).`,
        { available: round2(Math.max(0, available)) },
      ));
    }

    const now = getCurrentDateTime();
    const [id] = await db('edx_internal_transfers').insert(withOrg(req, {
      client_id: srcBk.user_id,
      source_booking_id,
      target_booking_id,
      transfer_amount: round2(amount),
      transfer_type,
      reason,
      notes: notes || null,
      status: 'PENDING_APPROVAL',
      requested_by: userId,
      created_by: userId,
      created_on: now,
      updated_by: userId,
      updated_on: now,
    }));

    await _addApprovalHistory(db, { orgId, referenceType: 'INTERNAL_TRANSFER', referenceId: id, action: 'SUBMITTED', actionBy: userId, approvalLevel: 2 });

    const created = await db('edx_internal_transfers').where('id', id).first();
    return res.json(created);
  } catch (err) {
    logger.error(`createInternalTransfer error: ${err.message}`);
    return res.status(500).json(errBody('Failed to create internal transfer'));
  }
};

// ── getInternalTransfers ─────────────────────────────────────────────────────

const getInternalTransfers = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { client_id, status } = req.query;
    let q = db('edx_internal_transfers as t')
      .leftJoin('edx_bookings as sb', 'sb.id', 't.source_booking_id')
      .leftJoin('edx_bookings as tb', 'tb.id', 't.target_booking_id')
      .leftJoin('edx_client_app_users as u', function () {
        this.on('u.id', 't.client_id').andOn('u.org_id', 't.org_id');
      })
      .leftJoin('edx_web_app_users as rq', 'rq.id', 't.requested_by')
      .leftJoin('edx_web_app_users as ap', 'ap.id', 't.approved_by')
      .where('t.org_id', orgId)
      .select('t.*',
        db.raw("IFNULL(u.user_name, '') as client_name"),
        db.raw("IFNULL(rq.user_name, '') as requested_by_name"),
        db.raw("IFNULL(ap.user_name, '') as approved_by_name"),
        db.raw("CONCAT('BK-', LPAD(sb.id, 6, '0')) as source_booking_ref"),
        db.raw("CONCAT('BK-', LPAD(tb.id, 6, '0')) as target_booking_ref")
      ).orderBy('t.id', 'desc');
    if (client_id) q = q.where('t.client_id', client_id);
    if (status) q = q.where('t.status', status);
    const data = await q;
    return res.json(data);
  } catch (err) {
    logger.error(`getInternalTransfers error: ${err.message}`);
    return res.status(500).json(errBody('Failed to fetch transfers'));
  }
};

// ── approveInternalTransfer ──────────────────────────────────────────────────

const approveInternalTransfer = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { transfer_id, action, notes } = req.body;
    if (!transfer_id || !action) return res.status(400).json(errBody('transfer_id and action required'));
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json(errBody('action must be Approved or Rejected'));

    const transfer = await db('edx_internal_transfers').where({ id: transfer_id, org_id: orgId }).first();
    if (!transfer) return res.status(404).json(errBody('Transfer not found'));
    if (transfer.status !== 'PENDING_APPROVAL') return res.status(400).json(errBody('Only PENDING_APPROVAL transfers can be actioned'));
    if (action === 'Approved' && _isOwnRequest(transfer, userId)) {
      return res.status(403).json(errBody('You cannot approve a transfer you requested.'));
    }

    const now = getCurrentDateTime();

    if (action === 'Approved') {
      await withTransaction(async (trx) => {
        const locked = await trx('edx_internal_transfers').where({ id: transfer.id, org_id: orgId }).forUpdate().first();
        if (!locked || locked.status !== 'PENDING_APPROVAL') throw new StateConflict('Transfer was already processed.');
        // Re-check with the source booking locked: its balance may have
        // changed since the request was raised.
        await trx('edx_bookings').where({ id: locked.source_booking_id, org_id: orgId }).forUpdate().first('id');
        const available = await _transferableFromBooking(
          trx, orgId, locked.source_booking_id, locked.transfer_type, locked.id);
        if (round2(locked.transfer_amount) > available + MONEY_EPS) {
          throw new StateConflict(
            `Transfer exceeds what the source booking can transfer (₹${fmt2(Math.max(0, available))}).`, 400);
        }
        const outEntryId = await _createTransactionEntry(trx, {
          orgId, clientId: transfer.client_id, bookingId: transfer.source_booking_id,
          transactionType: 'INTERNAL_TRANSFER_OUT', direction: 'DEBIT',
          amount: parseFloat(transfer.transfer_amount),
          referenceId: transfer.id, referenceType: 'INTERNAL_TRANSFER',
          description: 'Internal transfer out to booking #' + transfer.target_booking_id,
          createdBy: userId,
        });
        const inEntryId = await _createTransactionEntry(trx, {
          orgId, clientId: transfer.client_id, bookingId: transfer.target_booking_id,
          transactionType: 'INTERNAL_TRANSFER_IN', direction: 'CREDIT',
          amount: parseFloat(transfer.transfer_amount),
          referenceId: transfer.id, referenceType: 'INTERNAL_TRANSFER',
          description: 'Internal transfer in from booking #' + transfer.source_booking_id,
          createdBy: userId,
        });
        await trx('edx_internal_transfers').where({ id: transfer.id, org_id: orgId }).update({
          status: 'COMPLETED', approved_by: userId, approved_at: now,
          source_transaction_entry_id: outEntryId, target_transaction_entry_id: inEntryId,
          updated_by: userId, updated_on: now,
        });
        await _addApprovalHistory(trx, { orgId, referenceType: 'INTERNAL_TRANSFER', referenceId: transfer.id, action: 'APPROVED', actionBy: userId, notes, approvalLevel: 2 });
      });
    } else {
      const changed = await db('edx_internal_transfers').where({ id: transfer.id, org_id: orgId, status: 'PENDING_APPROVAL' })
        .update({ status: 'REJECTED', updated_by: userId, updated_on: now });
      if (!changed) return res.status(409).json(errBody('Transfer was already processed.'));
      await _addApprovalHistory(db, { orgId, referenceType: 'INTERNAL_TRANSFER', referenceId: transfer.id, action: 'REJECTED', actionBy: userId, notes, approvalLevel: 2 });
    }

    const updated = await db('edx_internal_transfers').where('id', transfer.id).first();
    const history = await db('edx_approval_history').where({ reference_type: 'INTERNAL_TRANSFER', reference_id: transfer.id, org_id: orgId }).orderBy('id');
    return res.json({ ...updated, approval_history: history });
  } catch (err) {
    if (err instanceof StateConflict) return res.status(err.status).json(errBody(err.message));
    logger.error(`approveInternalTransfer error: ${err.message}`);
    return res.status(500).json(errBody('Failed to update transfer status'));
  }
};

module.exports = guardOrgHandlers({
  getActiveClients,
  createProvisionalReceipt,
  updateReceiptStatus,
  getClientStatements,
  createWriteOff,
  updateWriteOffStatus,
  // New endpoints
  getInvoices,
  createCreditNote,
  getCreditNotes,
  updateCreditNoteStatus,
  getAgingReport,
  getCollectionsKPIs,
  bulkGenerateInvoices,
  closePeriod,
  getClosedPeriods,
  getRevenueRecognition,
  createInsuranceClaim,
  updateInsuranceClaim,
  getInsuranceClaims,
  getCancellationBilling,
  createPaymentLink,
  razorpayWebhook,
  getRateHistory,
  getReceipts,
  getWriteOffs,
  // Phase 2.4 Extension
  getTransactionLedger,
  getClientOutstanding,
  getBookingOutstanding,
  createWriteOffV2,
  approveWriteOff,
  createRefund,
  getRefunds,
  getRefundById,
  approveRefund,
  getCreditNoteApplications,
  createInternalTransfer,
  getInternalTransfers,
  approveInternalTransfer,
}, ['razorpayWebhook']);

