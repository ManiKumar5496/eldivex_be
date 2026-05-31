/**
 * accountsController.js — Phase 2.4 + Advanced Accounts
 *
 * Tables used:
 *   edx_bookings, edx_web_app_users, edx_patient, edx_master_services,
 *   edx_branches, edx_invoice, edx_receipts, edx_write_offs,
 *   edx_credit_notes, edx_insurance_claims, edx_period_closing,
 *   edx_payment_reminders, edx_payment_links, edx_rate_history
 */

const db = require('../../config/db');
const logger = require('../../logger');
const applyBranchFilter = require('../../utils/applyBranchFilter');
const { getCurrentDateTime, toMysqlDate } = require('../../utils/dateTime');
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope');
const { sendEmail } = require('../../utils/emailService');
const { paymentReminder, creditNoteGenerated } = require('../../utils/emailTemplates');

// ── 1. Get Active Clients ─────────────────────────────────────────────────────

/**
 * GET /api/getActiveClients
 * Returns bookings with aggregated billing totals.
 * Respects branch_access from JWT.
 */
const getActiveClients = async (req, res) => {
  try {
    const user = req.login_data;

    // NOTE: orgQuery() returns a query builder with no .alias() method.
    // Use db('table as alias').where() directly for aliased main table queries.
    let query = db('edx_bookings as b')
      .where('b.org_id', getOrgId(req))
      .leftJoin('edx_web_app_users as u', 'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',         'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
      .leftJoin('edx_branches as br',        'b.branch_id', 'br.br_id')
      .leftJoin(
        db('edx_invoice')
          .select('booking_id')
          .sum('inv_raised_amnt as total_billed')
          .groupBy('booking_id')
          .as('inv'),
        'inv.booking_id', 'b.id'
      )
      .leftJoin(
        db('edx_receipts')
          .select('booking_id')
          .sum('total_amount as total_paid')
          .where('status', 'Approved')
          .groupBy('booking_id')
          .as('rec'),
        'rec.booking_id', 'b.id'
      )
      .select(
        'b.id as booking_id',
        'b.user_id',
        'b.branch_id',
        'b.service_type_id',
        'b.service_start_date',
        'b.service_end_date',
        'b.final_rate',
        'b.status',
        'u.user_name as client_name',
        'u.user_mobile as client_mobile',
        'u.user_email as client_email',
        'p.patient_name',
        'ms.name as service_name',
        'br.br_name as branch_name',
        db.raw('COALESCE(inv.total_billed, 0) as total_billed'),
        db.raw('COALESCE(rec.total_paid, 0) as total_paid'),
        db.raw('COALESCE(inv.total_billed, 0) - COALESCE(rec.total_paid, 0) as outstanding_amount')
      );

    // Apply branch access filter
    query = applyBranchFilter(query, user, 'b.branch_id');

    // Optional status filter
    if (req.query.status) {
      query = query.where('b.status', req.query.status);
    }

    // Optional pagination
    const limit  = parseInt(req.query.limit)  || 100;
    const offset = parseInt(req.query.offset) || 0;
    query = query.limit(limit).offset(offset);

    const data = await query;
    res.json(data);
  } catch (err) {
    logger.error(`Error getActiveClients: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching active clients.' });
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
    } = req.body;

    if (!booking_id || !amount) {
      return res.status(400).json({ message: 'booking_id and amount are required.' });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({ message: 'Amount must be greater than zero.' });
    }

    const orgId = getOrgId(req);

    // Guard: booking must not be cancelled (status 6)
    const booking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first();
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (String(booking.status) === '6') {
      return res.status(400).json({ message: 'Cannot create receipt for a cancelled booking.' });
    }

    // Guard: period must not be closed
    if (period_from) {
      const periodDate  = new Date(period_from);
      const periodMonth = periodDate.getMonth() + 1;
      const periodYear  = periodDate.getFullYear();
      const closedPeriod = await db('edx_period_closing')
        .where({ org_id: orgId, period_month: periodMonth, period_year: periodYear, status: 'Closed' })
        .first();
      if (closedPeriod) {
        return res.status(400).json({
          message: `Period ${periodMonth}/${periodYear} is closed. No new entries allowed.`,
        });
      }
    }

    const total_amount = Number(amount) + Number(tax_amount);

    // Generate receipt_number before insert using current org count
    const countRow = await db('edx_receipts').where({ org_id: orgId }).count('id as cnt').first();
    const receipt_number = `RCP-${String((Number(countRow.cnt) || 0) + 1).padStart(6, '0')}`;

    // Record payment directly as Approved — no provisional/pending step needed
    const [id] = await db('edx_receipts').insert(withOrg(req, {
      receipt_number,
      booking_id,
      user_id:        user_id        || null,
      amount:         Number(amount),
      tax_amount:     Number(tax_amount),
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

    const receipt = await db('edx_receipts').where({ id }).first();
    res.status(201).json({ message: 'Payment recorded successfully.', id, data: receipt });
  } catch (err) {
    logger.error(`Error createProvisionalReceipt: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while recording payment.' });
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
      return res.status(400).json({ message: 'id and status are required.' });
    }

    if (!['Approved', 'Cancelled'].includes(status)) {
      return res.status(400).json({ message: 'status must be Approved or Cancelled.' });
    }

    // Guard: only Pending receipts can be updated
    const receipt = await db('edx_receipts')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .first();
    if (!receipt) {
      return res.status(404).json({ message: 'Receipt not found.' });
    }
    if (receipt.status !== 'Pending') {
      return res.status(400).json({
        message: `Receipt is already ${receipt.status}. No changes allowed.`,
      });
    }

    const updated = await db('edx_receipts')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .update({
        status,
        updated_by: req.login_data.id,
        updated_on: getCurrentDateTime(),
      });

    if (!updated) {
      return res.status(404).json({ message: 'Receipt not found.' });
    }

    res.json({ message: `Receipt ${status.toLowerCase()} successfully.` });
  } catch (err) {
    logger.error(`Error updateReceiptStatus: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while updating receipt status.' });
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
      return res.status(400).json({ message: 'booking_id or user_id is required.' });
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
        db.raw("CONCAT('REC-', r.id) as reference_number"),
        db.raw("CONCAT('Payment via ', r.payment_mode) as description")
      );

    if (booking_id) receiptQ = receiptQ.where('r.booking_id', booking_id);
    if (user_id)    receiptQ = receiptQ.where('b.user_id', user_id);

    const invoices = await invoiceQ;
    const receipts = await receiptQ;

    // Merge and sort by date ascending
    const transactions = [...invoices, ...receipts].sort((a, b) =>
      new Date(a.date || 0) - new Date(b.date || 0)
    );

    // Compute running balance
    let balance = 0;
    const result = transactions.map((t) => {
      balance += Number(t.debit) - Number(t.credit);
      return { ...t, balance };
    });

    res.json(result);
  } catch (err) {
    logger.error(`Error getClientStatements: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching client statements.' });
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

    if (!write_off_amount) {
      return res.status(400).json({ message: 'write_off_amount is required.' });
    }

    if (Number(write_off_amount) <= 0) {
      return res.status(400).json({ message: 'write_off_amount must be greater than zero.' });
    }

    const orgId = getOrgId(req);

    if (booking_id) {
      // Guard: no pending write-off already exists for this booking
      const existingPending = await db('edx_write_offs')
        .where({ booking_id, status: 'Pending', org_id: orgId })
        .first();
      if (existingPending) {
        return res.status(400).json({
          message: 'A pending write-off already exists for this booking. Approve or reject it first.',
        });
      }

      // Guard: write-off cannot exceed outstanding balance
      const totalBilledRow = await db('edx_invoice')
        .where({ booking_id }).sum('inv_raised_amnt as total_billed').first();
      const totalPaidRow = await db('edx_receipts')
        .where({ booking_id, status: 'Approved' }).sum('total_amount as total_paid').first();
      const outstanding = (Number(totalBilledRow.total_billed) || 0) - (Number(totalPaidRow.total_paid) || 0);
      if (Number(write_off_amount) > outstanding) {
        return res.status(400).json({
          message: `Write-off amount (₹${Number(write_off_amount).toFixed(2)}) exceeds outstanding balance (₹${outstanding.toFixed(2)}).`,
          outstanding,
        });
      }
    }

    const [id] = await db('edx_write_offs').insert(withOrg(req, {
      booking_id:      booking_id      || null,
      user_id:         user_id         || null,
      write_off_amount: Number(write_off_amount),
      reason:          reason          || null,
      remarks:         remarks         || null,
      approved_by:     approved_by     || null,
      write_off_date:  write_off_date  || getCurrentDateTime(),
      status:          'Pending',
      created_by:      req.login_data.id,
      created_on:      getCurrentDateTime(),
    }));

    const writeOff = await db('edx_write_offs').where({ id }).first();
    res.status(201).json({ message: 'Write-off created successfully.', data: writeOff });
  } catch (err) {
    logger.error(`Error createWriteOff: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while creating write-off.' });
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
      return res.status(400).json({ message: 'id and status are required.' });
    }

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be Approved or Rejected.' });
    }

    // Guard: only Pending write-offs can be updated
    const writeOff = await db('edx_write_offs')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .first();
    if (!writeOff) {
      return res.status(404).json({ message: 'Write-off not found.' });
    }
    if (writeOff.status !== 'Pending') {
      return res.status(400).json({
        message: `Write-off is already ${writeOff.status}. No changes allowed.`,
      });
    }

    const updated = await db('edx_write_offs')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .update({
        status,
        updated_by: req.login_data.id,
        updated_on: getCurrentDateTime(),
      });

    if (!updated) {
      return res.status(404).json({ message: 'Write-off not found.' });
    }

    res.json({ message: `Write-off ${status.toLowerCase()} successfully.` });
  } catch (err) {
    logger.error(`Error updateWriteOffStatus: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while updating write-off status.' });
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
    const today = new Date().toISOString().split('T')[0];

    let query = db('edx_invoice as i')
      .leftJoin('edx_bookings as b',        'i.booking_id', 'b.id')
      .leftJoin('edx_web_app_users as u',   'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',         'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .leftJoin('edx_branches as br',       'b.branch_id', 'br.br_id')
      .leftJoin(
        db('edx_receipts')
          .select('booking_id')
          .sum('total_amount as total_paid')
          .where('status', 'Approved')
          .groupBy('booking_id')
          .as('rec'),
        'rec.booking_id', 'b.id'
      )
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
        db.raw('COALESCE(rec.total_paid, 0) as paid_amount'),
        db.raw('COALESCE(i.inv_raised_amnt, 0) - COALESCE(rec.total_paid, 0) as balance_due'),
        'b.final_rate as daily_rate',
        'b.status    as booking_status',
        'u.user_name   as client_name',
        'u.user_mobile as client_mobile',
        'p.patient_name',
        'ms.name as service_name',
        'br.br_name as branch_name',
        db.raw(`
          CASE
            WHEN COALESCE(i.inv_raised_amnt,0) > 0
              AND COALESCE(rec.total_paid,0) >= COALESCE(i.inv_raised_amnt,0)
              THEN 'Paid'
            WHEN COALESCE(rec.total_paid,0) > 0
              AND COALESCE(rec.total_paid,0) < COALESCE(i.inv_raised_amnt,0)
              THEN 'Partially Paid'
            WHEN i.due_date IS NOT NULL
              AND i.due_date < '${today}'
              AND COALESCE(rec.total_paid,0) = 0
              THEN 'Overdue'
            ELSE 'Pending'
          END as status
        `)
      );

    // Apply branch filter from JWT
    query = applyBranchFilter(query, user, 'b.branch_id');

    if (req.query.booking_id)  query = query.where('i.booking_id', req.query.booking_id);
    if (req.query.branch_id)   query = query.where('b.branch_id',  req.query.branch_id);
    if (req.query.from)        query = query.where('i.inv_date', '>=', req.query.from);
    if (req.query.to)          query = query.where('i.inv_date', '<=', req.query.to);

    // Status filter applied as HAVING on computed column — use subquery trick
    const results = await query.orderBy('i.id', 'desc');

    // Apply status filter in JS (simpler than HAVING on computed expression)
    const finalResults = req.query.status
      ? results.filter(r => r.status === req.query.status)
      : results;

    const limit  = parseInt(req.query.limit)  || 200;
    const offset = parseInt(req.query.offset) || 0;

    res.json(finalResults.slice(offset, offset + limit));
  } catch (err) {
    logger.error(`Error getInvoices: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching invoices.' });
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
      return res.status(400).json({ message: 'booking_id and amount are required.' });
    }

    const [id] = await db('edx_credit_notes').insert(withOrg(req, {
      booking_id,
      invoice_id:  invoice_id  || null,
      credit_type: credit_type || 'Hold',
      amount:      Number(amount),
      reason:      reason      || null,
      status:      'Pending',
      credit_date: credit_date || getCurrentDateTime(),
      created_by:  req.login_data.id,
      created_on:  getCurrentDateTime(),
    }));

    const note = await db('edx_credit_notes').where({ id }).first();
    res.status(201).json({ message: 'Credit note created.', data: note });

    // Notify accounts team via email (fire-and-forget)
    setImmediate(async () => {
      try {
        const booking = await db('edx_bookings as b')
          .leftJoin('edx_web_app_users as u', 'b.user_id', 'u.id')
          .where('b.id', booking_id)
          .select('u.user_email', 'u.user_name')
          .first();
        if (booking && booking.user_email && booking.user_email !== 'NA') {
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
    res.status(500).json({ error: 'An error occurred while creating credit note.' });
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
      .leftJoin('edx_web_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .where('cn.org_id', getOrgId(req))
      .select(
        'cn.*',
        'u.user_name  as client_name',
        'u.user_mobile as client_mobile',
        'p.patient_name',
      )
      .orderBy('cn.id', 'desc');

    if (req.query.booking_id) query = query.where('cn.booking_id', req.query.booking_id);
    if (req.query.status)     query = query.where('cn.status', req.query.status);

    const data = await query;
    res.json(data);
  } catch (err) {
    logger.error(`Error getCreditNotes: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching credit notes.' });
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
    if (!id || !status) return res.status(400).json({ message: 'id and status required.' });
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be Approved or Rejected.' });
    }

    // Guard: only Pending credit notes can be updated
    const creditNote = await db('edx_credit_notes')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .first();
    if (!creditNote) return res.status(404).json({ message: 'Credit note not found.' });
    if (creditNote.status !== 'Pending') {
      return res.status(400).json({
        message: `Credit note is already ${creditNote.status}. No changes allowed.`,
      });
    }

    const updated = await db('edx_credit_notes')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .update({ status, updated_by: req.login_data.id, updated_on: getCurrentDateTime() });
    if (!updated) return res.status(404).json({ message: 'Credit note not found.' });
    res.json({ message: `Credit note ${status.toLowerCase()}.` });
  } catch (err) {
    logger.error(`Error updateCreditNoteStatus: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
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
    const today = new Date().toISOString().split('T')[0];

    // Fetch all unpaid / partially paid invoices
    const invoices = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .leftJoin(
        db('edx_receipts')
          .select('booking_id')
          .sum('total_amount as total_paid')
          .where('status', 'Approved')
          .groupBy('booking_id')
          .as('rec'),
        'rec.booking_id', 'b.id'
      )
      .where('b.org_id', orgId)
      .whereRaw('COALESCE(i.inv_raised_amnt,0) > COALESCE(rec.total_paid,0)')
      .select(
        'i.id',
        'i.booking_id',
        'i.inv_raised_amnt as total_amount',
        'i.due_date',
        db.raw('COALESCE(rec.total_paid,0) as paid_amount'),
        db.raw('COALESCE(i.inv_raised_amnt,0) - COALESCE(rec.total_paid,0) as balance_due'),
      );

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
      if (inv.due_date) {
        const due = new Date(inv.due_date);
        const now = new Date(today);
        overdueDays = Math.ceil((now - due) / (1000 * 60 * 60 * 24));
      }

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

    res.json({ buckets, total_outstanding: invoices.reduce((s, i) => s + Number(i.balance_due), 0) });
  } catch (err) {
    logger.error(`Error getAgingReport: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching aging report.' });
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

    // Overdue invoices
    const today = new Date().toISOString().split('T')[0];
    const overdueRows = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .leftJoin(
        db('edx_receipts')
          .select('booking_id').sum('total_amount as tp')
          .where('status', 'Approved').groupBy('booking_id').as('r'),
        'r.booking_id', 'b.id'
      )
      .where('b.org_id', orgId)
      .whereNotNull('i.due_date')
      .whereRaw(`i.due_date < ?`, [today])
      .whereRaw(`COALESCE(i.inv_raised_amnt,0) > COALESCE(r.tp,0)`)
      .select(
        db.raw('COUNT(*) as overdue_count'),
        db.raw('SUM(COALESCE(i.inv_raised_amnt,0) - COALESCE(r.tp,0)) as overdue_amount'),
      )
      .first();

    const overdueCount  = Number(overdueRows.overdue_count)  || 0;
    const overdueAmount = Number(overdueRows.overdue_amount) || 0;

    // DSO = (Total Receivables / Total Billed) * 30  (30-day DSO approximation)
    const totalOutstanding = totalBilled - totalCollected;
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
    res.status(500).json({ error: 'An error occurred while fetching KPIs.' });
  }
};

// ── 13. Bulk Generate Invoices ────────────────────────────────────────────────

/**
 * POST /api/bulkGenerateInvoices
 * Generates invoices for all active bookings (status=4) that have no invoice
 * for the current calendar month.
 * Body: { month, year, payment_terms_days }  (optional overrides)
 */
const bulkGenerateInvoices = async (req, res) => {
  try {
    const orgId  = getOrgId(req);
    const userId = req.login_data.id;
    const now    = new Date();
    const month  = parseInt(req.body.month  || now.getMonth() + 1);
    const year   = parseInt(req.body.year   || now.getFullYear());
    const paymentTermsDays = parseInt(req.body.payment_terms_days || 15);

    // Guard: period must not be closed
    const closedPeriod = await db('edx_period_closing')
      .where({ org_id: orgId, period_month: month, period_year: year, status: 'Closed' })
      .first();
    if (closedPeriod) {
      return res.status(400).json({
        message: `Period ${month}/${year} is closed. Invoices cannot be generated for a closed period.`,
      });
    }

    // Month start/end strings
    const monthStr  = String(month).padStart(2, '0');
    const monthStart = `${year}-${monthStr}-01`;
    const lastDay   = new Date(year, month, 0).getDate();
    const monthEnd  = `${year}-${monthStr}-${lastDay}`;

    // Find active bookings that don't already have an invoice for this month
    const existingInvBookingIds = (await db('edx_invoice as i')
      .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
      .where('b.org_id', orgId)
      .whereRaw(`i.inv_start >= ? AND i.inv_start <= ?`, [monthStart, monthEnd])
      .select('i.booking_id'))
      .map(r => r.booking_id);

    let bookingsQ = db('edx_bookings')
      .where({ org_id: orgId, status: '4' })  // Active
      .whereNotNull('final_rate')
      .select('id', 'final_rate', 'service_start_date', 'service_end_date', 'user_id');

    if (existingInvBookingIds.length > 0) {
      bookingsQ = bookingsQ.whereNotIn('id', existingInvBookingIds);
    }

    const bookings = await bookingsQ;

    if (bookings.length === 0) {
      return res.json({ message: 'No bookings need invoicing this month.', generated: 0 });
    }

    let generated = 0;
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + paymentTermsDays);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    for (const booking of bookings) {
      try {
        // Clamp service period to current month
        const sStart = new Date(Math.max(new Date(booking.service_start_date), new Date(monthStart)));
        const sEnd   = new Date(Math.min(new Date(booking.service_end_date || monthEnd), new Date(monthEnd)));
        if (sEnd < sStart) continue;

        const totalDays = Math.ceil((sEnd - sStart) / (1000 * 60 * 60 * 24)) + 1;
        const invAmount = totalDays * parseFloat(booking.final_rate || 0);

        await db('edx_invoice').insert(withOrg(req, {
          booking_id:      booking.id,
          inv_raised_amnt: invAmount,
          inv_start:       sStart.toISOString().split('T')[0],
          inv_end:         sEnd.toISOString().split('T')[0],
          inv_date:        getCurrentDateTime(),
          due_date:        dueDateStr,
          invoice_type:    'Regular',
          created_by:      userId,
          created_on:      getCurrentDateTime(),
        }));
        generated++;
      } catch (rowErr) {
        logger.warn(`[bulkInvoice] booking #${booking.id} skipped: ${rowErr.message}`);
      }
    }

    res.json({ message: `${generated} invoice(s) generated for ${monthStr}/${year}.`, generated });
  } catch (err) {
    logger.error(`Error bulkGenerateInvoices: ${err.message}`);
    res.status(500).json({ error: 'An error occurred during bulk invoice generation.' });
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
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ message: 'month and year are required.' });
    const orgId = getOrgId(req);

    const existing = await db('edx_period_closing')
      .where({ org_id: orgId, period_month: month, period_year: year })
      .first();

    if (existing) {
      return res.status(409).json({ message: `Period ${month}/${year} is already closed.` });
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
    logger.error(`Error closePeriod: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while closing period.' });
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
    res.status(500).json({ error: 'An error occurred.' });
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
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const monthEnd   = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

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
      .where('i.inv_start', '>', today.toISOString().split('T')[0])
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
    res.status(500).json({ error: 'An error occurred while fetching revenue recognition data.' });
  }
};

// ── 16. Insurance Claims ──────────────────────────────────────────────────────

/**
 * POST /api/createInsuranceClaim
 */
const createInsuranceClaim = async (req, res) => {
  try {
    const { booking_id, user_id, tpa_name, policy_number, pre_auth_number, claim_amount, remarks } = req.body;
    if (!booking_id) return res.status(400).json({ message: 'booking_id is required.' });

    const [id] = await db('edx_insurance_claims').insert(withOrg(req, {
      booking_id,
      user_id:        user_id        || null,
      tpa_name:       tpa_name       || null,
      policy_number:  policy_number  || null,
      pre_auth_number:pre_auth_number|| null,
      claim_amount:   claim_amount   ? Number(claim_amount) : null,
      remarks:        remarks        || null,
      status:         'Pending',
      created_by:     req.login_data.id,
      created_on:     getCurrentDateTime(),
    }));

    const claim = await db('edx_insurance_claims').where({ id }).first();
    res.status(201).json({ message: 'Insurance claim created.', data: claim });
  } catch (err) {
    logger.error(`Error createInsuranceClaim: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
  }
};

/**
 * PATCH /api/updateInsuranceClaim
 * Body: { id, status, settled_amount, remarks, settled_date }
 */
const updateInsuranceClaim = async (req, res) => {
  try {
    const { id, status, settled_amount, remarks, settled_date } = req.body;
    if (!id || !status) return res.status(400).json({ message: 'id and status required.' });

    const validStatuses = ['Pending', 'Submitted', 'Approved', 'Rejected', 'Settled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const updateData = {
      status,
      remarks:     remarks     || undefined,
      updated_by:  req.login_data.id,
      updated_on:  getCurrentDateTime(),
    };
    if (settled_amount !== undefined) updateData.settled_amount = Number(settled_amount);
    if (settled_date)                 updateData.settled_date   = settled_date;

    const updated = await db('edx_insurance_claims')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .update(updateData);

    if (!updated) return res.status(404).json({ message: 'Claim not found.' });
    res.json({ message: `Claim updated to ${status}.` });
  } catch (err) {
    logger.error(`Error updateInsuranceClaim: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
  }
};

/**
 * GET /api/getInsuranceClaims?booking_id=&status=
 */
const getInsuranceClaims = async (req, res) => {
  try {
    let query = db('edx_insurance_claims as ic')
      .leftJoin('edx_bookings as b',       'ic.booking_id', 'b.id')
      .leftJoin('edx_web_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .where('ic.org_id', getOrgId(req))
      .select(
        'ic.*',
        'u.user_name   as client_name',
        'u.user_mobile as client_mobile',
        'p.patient_name',
      )
      .orderBy('ic.id', 'desc');

    if (req.query.booking_id) query = query.where('ic.booking_id', req.query.booking_id);
    if (req.query.status)     query = query.where('ic.status',     req.query.status);

    const data = await query;
    res.json(data);
  } catch (err) {
    logger.error(`Error getInsuranceClaims: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
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
    if (!booking_id) return res.status(400).json({ message: 'booking_id is required.' });

    const booking = await db('edx_bookings as b')
      .leftJoin('edx_web_app_users as u', 'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',       'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
      .where('b.id', booking_id)
      .where('b.org_id', getOrgId(req))
      .select(
        'b.*',
        'u.user_name   as client_name',
        'u.user_mobile as client_mobile',
        'p.patient_name',
        'ms.name as service_name',
      )
      .first();

    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    const cancelDate = cancel_date || new Date().toISOString().split('T')[0];
    const startDate  = booking.service_start_date;
    const finalRate  = parseFloat(booking.final_rate) || 0;

    // Days actually used
    const start    = new Date(startDate);
    const end      = new Date(cancelDate);
    const daysUsed = start <= end ? Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1 : 0;
    const amountDue = daysUsed * finalRate;

    // Total paid so far
    const paidRow = await db('edx_receipts')
      .where({ booking_id, status: 'Approved' })
      .sum('total_amount as total_paid')
      .first();
    const totalPaid = Number(paidRow.total_paid) || 0;

    const balance    = amountDue - totalPaid;
    const refundable = balance < 0 ? Math.abs(balance) : 0;
    const owing      = balance > 0 ? balance : 0;

    res.json({
      booking_id:      parseInt(booking_id),
      client_name:     booking.client_name,
      patient_name:    booking.patient_name,
      service_name:    booking.service_name,
      service_start:   startDate,
      cancel_date:     cancelDate,
      daily_rate:      finalRate,
      days_used:       daysUsed,
      amount_due:      Math.round(amountDue * 100) / 100,
      total_paid:      totalPaid,
      balance:         Math.round(balance * 100) / 100,
      refundable:      Math.round(refundable * 100) / 100,  // client overpaid
      owing:           Math.round(owing     * 100) / 100,   // client still owes
      action_required: balance > 0 ? 'RAISE_INVOICE' : balance < 0 ? 'PROCESS_REFUND' : 'SETTLED',
    });
  } catch (err) {
    logger.error(`Error getCancellationBilling: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
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
      return res.status(400).json({ message: 'invoice_id and amount are required.' });
    }
    const orgId  = getOrgId(req);
    const userId = req.login_data.id;

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

        // Fetch invoice details for description
        const inv = await db('edx_invoice as i')
          .leftJoin('edx_bookings as b', 'i.booking_id', 'b.id')
          .leftJoin('edx_web_app_users as u', 'b.user_id', 'u.id')
          .where('i.id', invoice_id)
          .select('u.user_name', 'u.user_mobile', 'u.user_email', 'i.booking_id')
          .first();

        const payLink = await rzp.paymentLink.create({
          amount:      Math.round(Number(amount) * 100), // paise
          currency:    'INR',
          description: `Invoice #${invoice_id} — Eldivex`,
          customer: {
            name:  inv?.user_name  || 'Client',
            email: inv?.user_email || undefined,
            contact: inv?.user_mobile || undefined,
          },
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
    res.status(500).json({ error: 'An error occurred.' });
  }
};

/**
 * POST /api/razorpay/webhook
 * Receives Razorpay payment.captured event → auto-creates Approved receipt.
 */
const razorpayWebhook = async (req, res) => {
  try {
    // Verify webhook signature
    const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (RAZORPAY_WEBHOOK_SECRET) {
      const crypto = require('crypto');
      const signature = req.headers['x-razorpay-signature'];
      const body      = JSON.stringify(req.body);
      const expected  = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
      if (signature !== expected) {
        return res.status(400).json({ message: 'Invalid webhook signature.' });
      }
    }

    const event = req.body;
    if (event.event !== 'payment.captured') {
      return res.status(200).json({ message: 'Event ignored.' });
    }

    const payment = event.payload?.payment?.entity;
    if (!payment) return res.status(400).json({ message: 'No payment entity.' });

    const amountPaise = payment.amount;
    const amountINR   = amountPaise / 100;
    const paymentId   = payment.id;
    const notes       = payment.notes || {};
    const invoiceId   = notes.invoice_id || null;

    if (!invoiceId) {
      logger.warn(`[webhook] Payment ${paymentId} has no invoice_id in notes.`);
      return res.status(200).json({ message: 'No invoice_id in notes.' });
    }

    // Fetch invoice → booking_id
    const inv = await db('edx_invoice').where({ id: invoiceId }).first();
    if (!inv) return res.status(200).json({ message: 'Invoice not found.' });

    // Auto-create Approved receipt
    await db('edx_receipts').insert({
      booking_id:     inv.booking_id,
      amount:         amountINR,
      tax_amount:     0,
      total_amount:   amountINR,
      payment_mode:   'Online',
      transaction_id: paymentId,
      receipt_date:   new Date().toISOString().split('T')[0],
      status:         'Approved',
      receipt_type:   'Payment',
      org_id:         inv.org_id,
      created_on:     getCurrentDateTime(),
    });

    // Mark payment link as Paid
    await db('edx_payment_links')
      .where({ invoice_id: invoiceId })
      .where('status', 'Created')
      .update({ status: 'Paid', paid_at: getCurrentDateTime() });

    logger.info(`[webhook] Auto-receipt created for invoice #${invoiceId}, amount ₹${amountINR}`);
    res.status(200).json({ message: 'Receipt auto-created.' });
  } catch (err) {
    logger.error(`Error razorpayWebhook: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
  }
};

// ── 19. Rate History ──────────────────────────────────────────────────────────

/**
 * GET /api/getRateHistory?booking_id=X
 */
const getRateHistory = async (req, res) => {
  try {
    const { booking_id } = req.query;
    if (!booking_id) return res.status(400).json({ message: 'booking_id is required.' });

    const data = await db('edx_rate_history as rh')
      .leftJoin('edx_web_app_users as u', 'rh.changed_by', 'u.id')
      .where('rh.booking_id', booking_id)
      .where('rh.org_id', getOrgId(req))
      .select('rh.*', 'u.user_name as changed_by_name')
      .orderBy('rh.id', 'desc');

    res.json(data);
  } catch (err) {
    logger.error(`Error getRateHistory: ${err.message}`);
    res.status(500).json({ error: 'An error occurred.' });
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
      .leftJoin('edx_web_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .where('r.org_id', getOrgId(req))
      .select(
        'r.*',
        db.raw("CONCAT('REC-', r.id) as receipt_number"),
        'u.user_name   as client_name',
        'u.user_mobile as client_mobile',
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
    res.status(500).json({ error: 'An error occurred while fetching receipts.' });
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
      .leftJoin('edx_web_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .where('wo.org_id', getOrgId(req))
      .select(
        'wo.*',
        'u.user_name   as client_name',
        'u.user_mobile as client_mobile',
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
    res.status(500).json({ error: 'An error occurred while fetching write-offs.' });
  }
};

module.exports = {
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
};
