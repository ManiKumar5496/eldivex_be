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
const { getCurrentDateTime, toMysqlDate } = require('../../utils/dateTime');
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope');
const withTransaction = require('../../utils/withTransaction');
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
      .leftJoin('edx_client_app_users as u', 'b.user_id', 'u.id')
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
    const receipt_number = `RCP-${orgId}-${String((Number(countRow.cnt) || 0) + 1).padStart(6, '0')}`;

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
      .leftJoin('edx_client_app_users as u',   'b.user_id', 'u.id')
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
        'u.phone_number as client_mobile',
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
          .leftJoin('edx_client_app_users as u', 'b.user_id', 'u.id')
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
      .leftJoin('edx_client_app_users as u',  'b.user_id', 'u.id')
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
          .leftJoin('edx_client_app_users as u', 'b.user_id', 'u.id')
          .where('i.id', invoice_id)
          .select('u.user_name', 'u.phone_number as user_mobile', 'u.user_email', 'i.booking_id')
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
      .leftJoin('edx_client_app_users as u',  'b.user_id', 'u.id')
      .leftJoin('edx_patient as p',        'b.patient_id', 'p.id')
      .leftJoin('edx_master_services as ms','b.service_type_id', 'ms.id')
      .where('r.org_id', getOrgId(req))
      .select(
        'r.*',
        db.raw("CONCAT('REC-', r.id) as receipt_number"),
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
    res.status(500).json({ error: 'An error occurred while fetching write-offs.' });
  }
};

// ════════════════════════════════════════════════════════════════════
// PHASE 2.4 EXTENSION — Transaction Ledger, Write-Off V2, Refund,
// Credit Note Application, Internal Transfer  (Added 2026-06-06)
// ════════════════════════════════════════════════════════════════════

// ── Internal Helpers ─────────────────────────────────────────────────────────

async function _createTransactionEntry(trxOrDb, { orgId, clientId, bookingId, invoiceId, transactionType, direction, amount, referenceId, referenceType, description, notes, createdBy }) {
  const clientRows = await trxOrDb('edx_transaction_ledger')
    .where({ org_id: orgId, client_id: clientId, status: 'COMPLETED' })
    .sum({ total_debit: trxOrDb.raw('CASE WHEN direction="DEBIT" THEN amount ELSE 0 END') })
    .sum({ total_credit: trxOrDb.raw('CASE WHEN direction="CREDIT" THEN amount ELSE 0 END') })
    .first();
  const prevClientBalance = (parseFloat(clientRows.total_debit) || 0) - (parseFloat(clientRows.total_credit) || 0);
  const newClientBalance = direction === 'DEBIT' ? prevClientBalance + amount : prevClientBalance - amount;

  let newBookingBalance = null;
  if (bookingId) {
    const bkRows = await trxOrDb('edx_transaction_ledger')
      .where({ org_id: orgId, booking_id: bookingId, status: 'COMPLETED' })
      .sum({ total_debit: trxOrDb.raw('CASE WHEN direction="DEBIT" THEN amount ELSE 0 END') })
      .sum({ total_credit: trxOrDb.raw('CASE WHEN direction="CREDIT" THEN amount ELSE 0 END') })
      .first();
    const prevBkBalance = (parseFloat(bkRows.total_debit) || 0) - (parseFloat(bkRows.total_credit) || 0);
    newBookingBalance = direction === 'DEBIT' ? prevBkBalance + amount : prevBkBalance - amount;
  }

  const [id] = await trxOrDb('edx_transaction_ledger').insert({
    org_id: orgId,
    client_id: clientId,
    booking_id: bookingId || null,
    invoice_id: invoiceId || null,
    transaction_type: transactionType,
    direction,
    amount,
    reference_id: referenceId || null,
    reference_type: referenceType || null,
    status: 'COMPLETED',
    description: description || null,
    notes: notes || null,
    running_balance_client: newClientBalance,
    running_balance_booking: newBookingBalance,
    created_by: createdBy || null,
    created_on: getCurrentDateTime(),
  });
  return id;
}

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
        db.raw("CONCAT(IFNULL(u.first_name,''), ' ', IFNULL(u.last_name,'')) as created_by_name")
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
    const [{ total }] = await countQ.count('id as total');
    return res.json({ data, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    console.error('getTransactionLedger error', err);
    return res.status(500).json({ error: 'Failed to fetch transaction ledger' });
  }
};

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

    const totalBilled = totals['INVOICE'] || 0;
    const totalPaid = totals['RECEIPT'] || 0;
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
    console.error('getClientOutstanding error', err);
    return res.status(500).json({ error: 'Failed to compute outstanding' });
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

    const totalBilled = totals['INVOICE'] || 0;
    const totalPaid = totals['RECEIPT'] || 0;
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
    console.error('getBookingOutstanding error', err);
    return res.status(500).json({ error: 'Failed to compute booking outstanding' });
  }
};

// ── createWriteOffV2 ─────────────────────────────────────────────────────────

const createWriteOffV2 = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { booking_id, user_id, write_off_type = 'BAD_DEBT', invoice_ids = [], write_off_amount, reason, remarks } = req.body;

    if (!booking_id || !write_off_amount || !reason) return res.status(400).json({ error: 'booking_id, write_off_amount and reason are required' });
    const amount = parseFloat(write_off_amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'write_off_amount must be a positive number' });

    const booking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status == 6) return res.status(400).json({ error: 'Cannot write off a cancelled booking' });

    const existing = await db('edx_write_offs').where({ booking_id, org_id: orgId, status: 'Pending' }).first();
    if (existing) return res.status(400).json({ error: 'A pending write-off already exists for this booking' });

    const approvalLevel = _determineApprovalLevel(amount);
    const now = getCurrentDateTime();

    const [id] = await db('edx_write_offs').insert(withOrg(req, {
      booking_id,
      user_id: user_id || booking.user_id,
      write_off_amount: amount,
      write_off_type,
      invoice_ids: JSON.stringify(invoice_ids),
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
    console.error('createWriteOffV2 error', err);
    return res.status(500).json({ error: 'Failed to create write-off' });
  }
};

// ── approveWriteOff ──────────────────────────────────────────────────────────

const approveWriteOff = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { write_off_id, action, notes } = req.body;
    if (!write_off_id || !action) return res.status(400).json({ error: 'write_off_id and action required' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'action must be Approved or Rejected' });

    const wo = await db('edx_write_offs').where({ id: write_off_id, org_id: orgId }).first();
    if (!wo) return res.status(404).json({ error: 'Write-off not found' });
    if (wo.status !== 'Pending') return res.status(400).json({ error: 'Only Pending write-offs can be approved or rejected' });

    const now = getCurrentDateTime();

    if (action === 'Approved') {
      await withTransaction(async (trx) => {
        const booking = await trx('edx_bookings').where('id', wo.booking_id).first();
        const entryId = await _createTransactionEntry(trx, {
          orgId, clientId: wo.user_id || booking.user_id, bookingId: wo.booking_id,
          transactionType: 'WRITE_OFF', direction: 'CREDIT',
          amount: parseFloat(wo.write_off_amount),
          referenceId: wo.id, referenceType: 'WRITE_OFF',
          description: 'Write-off approved: ' + wo.reason,
          createdBy: userId,
        });
        await trx('edx_write_offs').where('id', wo.id).update({
          status: 'Approved', approved_by: String(userId),
          transaction_entry_id: entryId, updated_by: userId, updated_on: now,
        });
        await _addApprovalHistory(trx, {
          orgId, referenceType: 'WRITE_OFF', referenceId: wo.id,
          action: 'APPROVED', actionBy: userId, notes,
          approvalLevel: wo.approval_level === 'L1' ? 1 : wo.approval_level === 'L2' ? 2 : 3,
        });
      });
    } else {
      await db('edx_write_offs').where('id', wo.id).update({ status: 'Rejected', updated_by: userId, updated_on: now });
      await _addApprovalHistory(db, {
        orgId, referenceType: 'WRITE_OFF', referenceId: wo.id, action: 'REJECTED', actionBy: userId, notes,
      });
    }

    const updated = await db('edx_write_offs').where('id', wo.id).first();
    const history = await db('edx_approval_history').where({ reference_type: 'WRITE_OFF', reference_id: wo.id, org_id: orgId }).orderBy('id');
    return res.json({ ...updated, approval_history: history });
  } catch (err) {
    console.error('approveWriteOff error', err);
    return res.status(500).json({ error: 'Failed to update write-off status' });
  }
};

// ── createRefund ─────────────────────────────────────────────────────────────

const createRefund = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { booking_id, client_id, invoice_id, receipt_ids = [], refund_amount, refund_channel, refund_reason, channel_details = {}, notes } = req.body;

    if (!booking_id || !refund_amount || !refund_channel || !refund_reason) {
      return res.status(400).json({ error: 'booking_id, refund_amount, refund_channel, refund_reason are required' });
    }
    const amount = parseFloat(refund_amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'refund_amount must be positive' });

    const booking = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const paidRows = await db('edx_receipts').where({ booking_id, org_id: orgId, status: 'Approved' }).sum('total_amount as total').first();
    const alreadyRefunded = await db('edx_refunds').where({ booking_id, org_id: orgId }).whereIn('status', ['APPROVED', 'PROCESSING', 'COMPLETED']).sum('refund_amount as total').first();
    const maxRefund = (parseFloat(paidRows?.total) || 0) - (parseFloat(alreadyRefunded?.total) || 0);
    if (amount > maxRefund) return res.status(400).json({ error: 'Refund amount exceeds refundable balance of ' + maxRefund });

    const approvalLevel = _determineApprovalLevel(amount);
    const now = getCurrentDateTime();

    const [id] = await db('edx_refunds').insert(withOrg(req, {
      client_id: client_id || booking.user_id,
      booking_id,
      invoice_id: invoice_id || null,
      receipt_ids: JSON.stringify(receipt_ids),
      refund_amount: amount,
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
    console.error('createRefund error', err);
    return res.status(500).json({ error: 'Failed to create refund' });
  }
};

// ── getRefunds ───────────────────────────────────────────────────────────────

const getRefunds = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { booking_id, status, from_date, to_date } = req.query;
    let q = db('edx_refunds as r')
      .leftJoin('edx_bookings as b', 'b.id', 'r.booking_id')
      .leftJoin('edx_client_app_users as u', 'u.id', 'r.client_id')
      .where('r.org_id', orgId)
      .select('r.*',
        db.raw("CONCAT(IFNULL(u.first_name,''), ' ', IFNULL(u.last_name,'')) as client_name"),
        db.raw("CONCAT('BK-', LPAD(b.id, 6, '0')) as booking_ref")
      )
      .orderBy('r.id', 'desc');
    if (booking_id) q = q.where('r.booking_id', booking_id);
    if (status) q = q.where('r.status', status);
    if (from_date) q = q.where('r.created_on', '>=', from_date);
    if (to_date) q = q.where('r.created_on', '<=', to_date + ' 23:59:59');
    const data = await q;
    return res.json(data);
  } catch (err) {
    console.error('getRefunds error', err);
    return res.status(500).json({ error: 'Failed to fetch refunds' });
  }
};

// ── getRefundById ────────────────────────────────────────────────────────────

const getRefundById = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const refund = await db('edx_refunds as r')
      .leftJoin('edx_bookings as b', 'b.id', 'r.booking_id')
      .leftJoin('edx_client_app_users as u', 'u.id', 'r.client_id')
      .where('r.id', id).where('r.org_id', orgId)
      .select('r.*',
        db.raw("CONCAT(IFNULL(u.first_name,''), ' ', IFNULL(u.last_name,'')) as client_name"),
        db.raw("CONCAT('BK-', LPAD(b.id, 6, '0')) as booking_ref")
      ).first();
    if (!refund) return res.status(404).json({ error: 'Refund not found' });
    const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: id, org_id: orgId }).orderBy('id');
    return res.json({ ...refund, approval_history: history });
  } catch (err) {
    console.error('getRefundById error', err);
    return res.status(500).json({ error: 'Failed to fetch refund' });
  }
};

// ── approveRefund ────────────────────────────────────────────────────────────

const approveRefund = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { refund_id, action, notes, dispatch_details } = req.body;
    if (!refund_id || !action) return res.status(400).json({ error: 'refund_id and action required' });

    const refund = await db('edx_refunds').where({ id: refund_id, org_id: orgId }).first();
    if (!refund) return res.status(404).json({ error: 'Refund not found' });

    const now = getCurrentDateTime();
    const allowed = { PENDING_APPROVAL: ['Approved', 'Rejected'], APPROVED: ['Processing'], PROCESSING: ['Completed'] };
    if (!allowed[refund.status]?.includes(action)) {
      return res.status(400).json({ error: 'Invalid status transition: ' + refund.status + ' → ' + action });
    }

    const updates = { updated_by: userId, updated_on: now };
    let historyAction = action === 'Approved' ? 'APPROVED' : action === 'Rejected' ? 'REJECTED' : 'APPROVED';

    if (action === 'Approved') {
      Object.assign(updates, { status: 'APPROVED', approved_by: userId, approved_at: now });
    } else if (action === 'Rejected') {
      Object.assign(updates, { status: 'REJECTED' });
      historyAction = 'REJECTED';
    } else if (action === 'Processing') {
      Object.assign(updates, { status: 'PROCESSING', processed_by: userId });
    } else if (action === 'Completed') {
      await withTransaction(async (trx) => {
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
        await trx('edx_refunds').where('id', refund.id).update(updates);
        await _addApprovalHistory(trx, { orgId, referenceType: 'REFUND', referenceId: refund.id, action: 'APPROVED', actionBy: userId, notes });
      });
      const updated = await db('edx_refunds').where('id', refund.id).first();
      const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: refund.id, org_id: orgId }).orderBy('id');
      return res.json({ ...updated, approval_history: history });
    }

    await db('edx_refunds').where('id', refund.id).update(updates);
    await _addApprovalHistory(db, { orgId, referenceType: 'REFUND', referenceId: refund.id, action: historyAction, actionBy: userId, notes });
    const updated = await db('edx_refunds').where('id', refund.id).first();
    const history = await db('edx_approval_history').where({ reference_type: 'REFUND', reference_id: refund.id, org_id: orgId }).orderBy('id');
    return res.json({ ...updated, approval_history: history });
  } catch (err) {
    console.error('approveRefund error', err);
    return res.status(500).json({ error: 'Failed to update refund status' });
  }
};

// ── applyCreditNote ──────────────────────────────────────────────────────────

const applyCreditNote = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { credit_note_id, target_booking_id, target_invoice_id, amount_to_apply, notes } = req.body;
    if (!credit_note_id || !target_booking_id || !target_invoice_id || !amount_to_apply) {
      return res.status(400).json({ error: 'credit_note_id, target_booking_id, target_invoice_id, amount_to_apply required' });
    }
    const applyAmt = parseFloat(amount_to_apply);
    const cn = await db('edx_credit_notes').where({ id: credit_note_id, org_id: orgId }).first();
    if (!cn) return res.status(404).json({ error: 'Credit note not found' });
    const remaining = parseFloat(cn.remaining_amount ?? cn.amount);
    if (remaining < applyAmt) return res.status(400).json({ error: 'Amount exceeds credit note remaining balance of ' + remaining });
    if (!['Approved'].includes(cn.status)) return res.status(400).json({ error: 'Credit note must be Approved to apply' });

    const invoice = await db('edx_invoice').where({ id: target_invoice_id, org_id: orgId }).first();
    if (!invoice) return res.status(404).json({ error: 'Target invoice not found' });

    const targetBooking = await db('edx_bookings').where({ id: target_booking_id, org_id: orgId }).first();
    if (!targetBooking) return res.status(404).json({ error: 'Target booking not found' });

    let applicationId;
    await withTransaction(async (trx) => {
      const newRemaining = remaining - applyAmt;
      const newUsed = (parseFloat(cn.used_amount) || 0) + applyAmt;
      const extStatus = newRemaining <= 0 ? 'FULLY_APPLIED' : 'PARTIALLY_APPLIED';
      await trx('edx_credit_notes').where('id', credit_note_id).update({
        remaining_amount: newRemaining, used_amount: newUsed, extended_status: extStatus,
        updated_on: getCurrentDateTime(), updated_by: userId,
      });

      const entryId = await _createTransactionEntry(trx, {
        orgId, clientId: targetBooking.user_id, bookingId: target_booking_id,
        invoiceId: target_invoice_id, transactionType: 'CREDIT_NOTE_APPLIED', direction: 'CREDIT',
        amount: applyAmt, referenceId: credit_note_id, referenceType: 'CREDIT_NOTE',
        description: 'Credit note applied to invoice #' + target_invoice_id,
        createdBy: userId,
      });

      const [appId] = await trx('edx_credit_note_applications').insert({
        org_id: orgId, credit_note_id, target_booking_id, target_invoice_id,
        amount_applied: applyAmt, status: 'APPLIED',
        applied_by: userId, applied_at: getCurrentDateTime(),
        ledger_entry_id: entryId, notes: notes || null,
      });
      applicationId = appId;
    });

    const application = await db('edx_credit_note_applications').where('id', applicationId).first();
    return res.json(application);
  } catch (err) {
    console.error('applyCreditNote error', err);
    return res.status(500).json({ error: 'Failed to apply credit note' });
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
    console.error('getCreditNoteApplications error', err);
    return res.status(500).json({ error: 'Failed to fetch credit note applications' });
  }
};

// ── createInternalTransfer ───────────────────────────────────────────────────

const createInternalTransfer = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { client_id, source_booking_id, target_booking_id, transfer_amount, transfer_type, reason, notes } = req.body;
    if (!client_id || !source_booking_id || !target_booking_id || !transfer_amount || !transfer_type || !reason) {
      return res.status(400).json({ error: 'client_id, source_booking_id, target_booking_id, transfer_amount, transfer_type, reason are required' });
    }
    if (source_booking_id == target_booking_id) return res.status(400).json({ error: 'Source and target bookings must be different' });

    const amount = parseFloat(transfer_amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'transfer_amount must be positive' });

    const [srcBk, tgtBk] = await Promise.all([
      db('edx_bookings').where({ id: source_booking_id, org_id: orgId }).first(),
      db('edx_bookings').where({ id: target_booking_id, org_id: orgId }).first(),
    ]);
    if (!srcBk) return res.status(404).json({ error: 'Source booking not found' });
    if (!tgtBk) return res.status(404).json({ error: 'Target booking not found' });
    if (srcBk.user_id != tgtBk.user_id) return res.status(400).json({ error: 'Both bookings must belong to the same client' });

    const now = getCurrentDateTime();
    const [id] = await db('edx_internal_transfers').insert(withOrg(req, {
      client_id,
      source_booking_id,
      target_booking_id,
      transfer_amount: amount,
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
    console.error('createInternalTransfer error', err);
    return res.status(500).json({ error: 'Failed to create internal transfer' });
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
      .leftJoin('edx_client_app_users as u', 'u.id', 't.client_id')
      .where('t.org_id', orgId)
      .select('t.*',
        db.raw("CONCAT(IFNULL(u.first_name,''), ' ', IFNULL(u.last_name,'')) as client_name"),
        db.raw("CONCAT('BK-', LPAD(sb.id, 6, '0')) as source_booking_ref"),
        db.raw("CONCAT('BK-', LPAD(tb.id, 6, '0')) as target_booking_ref")
      ).orderBy('t.id', 'desc');
    if (client_id) q = q.where('t.client_id', client_id);
    if (status) q = q.where('t.status', status);
    const data = await q;
    return res.json(data);
  } catch (err) {
    console.error('getInternalTransfers error', err);
    return res.status(500).json({ error: 'Failed to fetch transfers' });
  }
};

// ── approveInternalTransfer ──────────────────────────────────────────────────

const approveInternalTransfer = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.login_data.id;
    const { transfer_id, action, notes } = req.body;
    if (!transfer_id || !action) return res.status(400).json({ error: 'transfer_id and action required' });
    if (!['Approved', 'Rejected'].includes(action)) return res.status(400).json({ error: 'action must be Approved or Rejected' });

    const transfer = await db('edx_internal_transfers').where({ id: transfer_id, org_id: orgId }).first();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'PENDING_APPROVAL') return res.status(400).json({ error: 'Only PENDING_APPROVAL transfers can be actioned' });

    const now = getCurrentDateTime();

    if (action === 'Approved') {
      await withTransaction(async (trx) => {
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
        await trx('edx_internal_transfers').where('id', transfer.id).update({
          status: 'COMPLETED', approved_by: userId, approved_at: now,
          source_transaction_entry_id: outEntryId, target_transaction_entry_id: inEntryId,
          updated_by: userId, updated_on: now,
        });
        await _addApprovalHistory(trx, { orgId, referenceType: 'INTERNAL_TRANSFER', referenceId: transfer.id, action: 'APPROVED', actionBy: userId, notes, approvalLevel: 2 });
      });
    } else {
      await db('edx_internal_transfers').where('id', transfer.id).update({ status: 'REJECTED', updated_by: userId, updated_on: now });
      await _addApprovalHistory(db, { orgId, referenceType: 'INTERNAL_TRANSFER', referenceId: transfer.id, action: 'REJECTED', actionBy: userId, notes, approvalLevel: 2 });
    }

    const updated = await db('edx_internal_transfers').where('id', transfer.id).first();
    const history = await db('edx_approval_history').where({ reference_type: 'INTERNAL_TRANSFER', reference_id: transfer.id, org_id: orgId }).orderBy('id');
    return res.json({ ...updated, approval_history: history });
  } catch (err) {
    console.error('approveInternalTransfer error', err);
    return res.status(500).json({ error: 'Failed to update transfer status' });
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
  applyCreditNote,
  getCreditNoteApplications,
  createInternalTransfer,
  getInternalTransfers,
  approveInternalTransfer,
};

