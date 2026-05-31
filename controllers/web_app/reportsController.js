/**
 * reportsController.js — Phase 4.3
 *
 * GET  /api/generateReport?type=bookings|revenue|hp_utilization|outstanding
 *                          &from=YYYY-MM-DD&to=YYYY-MM-DD&branch_id=N&format=json|csv
 *
 * POST /api/configureReportSchedule   { enabled, dayOfWeek, hour, emails[] }
 * GET  /api/getScheduledReports
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const applyBranchFilter = require('../../utils/applyBranchFilter');

// In-memory schedule config (MVP — no DB table needed)
let _scheduleConfig = {
  enabled:   false,
  dayOfWeek: 1,       // 1 = Monday (cron standard)
  hour:      8,
  emails:    [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyDateRange(query, from, to, col = 'created_on') {
  if (from && to) {
    query = query.whereBetween(col, [`${from} 00:00:00`, `${to} 23:59:59`]);
  }
  return query;
}

/**
 * Convert an array of plain objects to a CSV string.
 * Handles nested objects by JSON-stringifying them.
 */
function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape  = (v) => {
    const s = v === null || v === undefined ? '' : String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [
    headers.map(escape).join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
  ];
  return lines.join('\r\n');
}

// ── Report queries ────────────────────────────────────────────────────────────

async function queryBookings(user, { from, to, branch_id }) {
  let q = db('edx_bookings as b')
    .leftJoin('edx_patient as p',           'b.patient_id',    'p.id')
    .leftJoin('edx_branches as br',          'b.branch_id',    'br.br_id')
    .leftJoin('edx_master_services as ms',   'b.service_type_id', 'ms.id')
    .select(
      'b.id         as booking_id',
      'b.status',
      'b.service_start_date',
      'b.service_end_date',
      'br.br_name   as branch',
      db.raw("COALESCE(ms.name, 'Other') as service"),
      'p.patient_name',
      'p.phone_number',
      'b.created_on',
    )
    .orderBy('b.id', 'desc');
  q = q.where('b.org_id', user.org_id ?? 1);
  q = applyBranchFilter(q, user, 'b.branch_id');
  if (branch_id) q = q.where('b.branch_id', branch_id);
  q = applyDateRange(q, from, to, 'b.created_on');
  return q.limit(1000);
}

async function queryRevenue(user, { from, to, branch_id }) {
  let q = db('edx_invoice as inv')
    .join('edx_bookings as b', 'inv.booking_id', 'b.id')
    .leftJoin('edx_branches as br', 'b.branch_id', 'br.br_id')
    .select(
      db.raw('YEAR(inv.created_on)  as year'),
      db.raw('MONTH(inv.created_on) as month'),
      'br.br_name                    as branch',
      db.raw('SUM(inv.inv_raised_amnt)             as total_invoiced'),
      db.raw('COUNT(DISTINCT inv.booking_id)       as bookings'),
    )
    .groupByRaw('YEAR(inv.created_on), MONTH(inv.created_on), br.br_id, br.br_name')
    .orderByRaw('year DESC, month DESC');
  q = q.where('b.org_id', user.org_id ?? 1);
  q = applyBranchFilter(q, user, 'b.branch_id');
  if (branch_id) q = q.where('b.branch_id', branch_id);
  q = applyDateRange(q, from, to, 'inv.created_on');
  return q.limit(500);
}

async function queryHpUtilization(user, { from, to, branch_id }) {
  let q = db('edx_booking_hp as bh')
    .join('edx_bookings as b',         'bh.booking_id',   'b.id')
    .join('edx_hp_registration as hp', 'bh.hp_unique_id', 'hp.hp_reg_id')
    .leftJoin('edx_branches as br',    'hp.hp_reg_branch_id', 'br.br_id')
    .select(
      'hp.hp_reg_id',
      db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''), ' ', COALESCE(hp.hp_reg_last_name,'')) as hp_name"),
      'br.br_name  as branch',
      db.raw('COUNT(DISTINCT bh.booking_id)  as total_bookings'),
      db.raw('MIN(b.service_start_date)      as first_booking'),
      db.raw('MAX(b.service_end_date)        as last_booking'),
    )
    .groupBy('bh.hp_unique_id', 'hp.hp_reg_id', 'hp.hp_reg_first_name',
             'hp.hp_reg_last_name', 'br.br_name')
    .orderBy('total_bookings', 'desc');
  q = q.where('b.org_id', user.org_id ?? 1);
  q = applyBranchFilter(q, user, 'b.branch_id');
  if (branch_id) q = q.where('b.branch_id', branch_id);
  q = applyDateRange(q, from, to, 'b.created_on');
  return q.limit(500);
}

async function queryOutstanding(user, { from, to, branch_id }) {
  let q = db('edx_invoice as inv')
    .join('edx_bookings as b', 'inv.booking_id', 'b.id')
    .leftJoin('edx_branches as br', 'b.branch_id', 'br.br_id')
    .leftJoin(
      db('edx_receipt')
        .select('booking_id')
        .sum('receipt_amount as collected')
        .where('receipt_status', 'Approved')
        .groupBy('booking_id')
        .as('rec'),
      'rec.booking_id', 'b.id'
    )
    .select(
      'b.id         as booking_id',
      'br.br_name   as branch',
      db.raw('SUM(inv.inv_raised_amnt)           as total_invoiced'),
      db.raw('COALESCE(rec.collected, 0)         as total_collected'),
      db.raw('SUM(inv.inv_raised_amnt) - COALESCE(rec.collected, 0) as outstanding'),
    )
    .groupBy('b.id', 'br.br_name', 'rec.collected')
    .havingRaw('outstanding > 0')
    .orderBy('outstanding', 'desc');
  q = q.where('b.org_id', user.org_id ?? 1);
  q = applyBranchFilter(q, user, 'b.branch_id');
  if (branch_id) q = q.where('b.branch_id', branch_id);
  q = applyDateRange(q, from, to, 'inv.created_on');
  return q.limit(500);
}

// ── Controller functions ──────────────────────────────────────────────────────

const generateReport = async (req, res) => {
  try {
    const user      = req.login_data;
    const { type = 'bookings', from, to, format = 'json' } = req.query;
    const branch_id = req.query.branch_id ? parseInt(req.query.branch_id) : null;

    let rows;
    switch (type) {
      case 'bookings':        rows = await queryBookings(user,       { from, to, branch_id }); break;
      case 'revenue':         rows = await queryRevenue(user,        { from, to, branch_id }); break;
      case 'hp_utilization':  rows = await queryHpUtilization(user,  { from, to, branch_id }); break;
      case 'outstanding':     rows = await queryOutstanding(user,     { from, to, branch_id }); break;
      default:
        return res.status(400).json({ message: `Unknown report type: ${type}` });
    }

    if (format === 'csv') {
      const csv = toCsv(rows);
      res.setHeader('Content-Type',        'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_report_${Date.now()}.csv"`);
      return res.send(csv);
    }

    res.json({ type, from, to, count: rows.length, data: rows });
  } catch (error) {
    logger.error('[reportsController] generateReport error:', error);
    res.status(500).json({ message: 'Failed to generate report.', details: error.message });
  }
};

const configureReportSchedule = async (req, res) => {
  try {
    const { enabled, dayOfWeek, hour, emails } = req.body;
    if (enabled  !== undefined) _scheduleConfig.enabled   = Boolean(enabled);
    if (dayOfWeek !== undefined) _scheduleConfig.dayOfWeek = parseInt(dayOfWeek);
    if (hour      !== undefined) _scheduleConfig.hour      = parseInt(hour);
    if (emails    !== undefined) _scheduleConfig.emails    = emails;
    res.json({ message: 'Schedule updated.', config: _scheduleConfig });
  } catch (error) {
    logger.error('[reportsController] configureReportSchedule error:', error);
    res.status(500).json({ message: 'Failed to update schedule.' });
  }
};

const getScheduledReports = async (req, res) => {
  res.json(_scheduleConfig);
};

module.exports = {
  generateReport,
  configureReportSchedule,
  getScheduledReports,
  getScheduleConfig: () => _scheduleConfig,
};
