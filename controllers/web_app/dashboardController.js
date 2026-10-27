/**
 * dashboardController.js — Phase 4.1 (+ dashboard accuracy rework)
 *
 * Replaces 7 client-side API calls + 6 in-browser aggregations with a single
 * server-side endpoint that runs SQL aggregation queries in parallel.
 *
 * GET /api/getDashboardStats?from=YYYY-MM-DD&to=YYYY-MM-DD&branch_id=N
 *
 * Booking status is stored as a numeric varchar ('1'..'7'):
 *   1=Booking Submitted 2=HP Assigned 3=Booking Cancelled 4=Service Started
 *   5=On Hold 6=Service Cancelled 7=Suspended
 *   active = 1,2,4 · completed = has a row in edx_service_closed
 */

const db = require('../../config/db');
const logger = require('../../logger');
const applyBranchFilter = require('../../utils/applyBranchFilter');
const { getOrgId } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');

// Day-of-week mapping: MySQL DAYOFWEEK returns 1=Sun … 7=Sat
const DOW_TO_NAME = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri', 7: 'Sat' };
const WEEK_ORDER  = [2, 3, 4, 5, 6, 7, 1]; // Mon → Sun

const ACTIVE_STATUSES = ['1', '2', '4'];
const CANCELLED_STATUSES = ['3', '6'];

// ── Helpers ────────────────────────────────────────────────────────────────

// Apply org isolation + JWT branch access + optional explicit branch + date range
// to a query whose bookings table is aliased `b`.
function applyFilters(query, user, branchCol, { from, to, branch_id } = {}) {
  query = query.where('b.org_id', user.org_id);
  query = applyBranchFilter(query, user, branchCol);
  if (branch_id) query = query.where(branchCol, branch_id);
  if (from && to) {
    query = query.whereBetween('b.created_on', [`${from} 00:00:00`, `${to} 23:59:59`]);
  }
  return query;
}

// Is this caller scoped to one or more specific branches?
// (explicit branch_id filter, or a non-superadmin with branch_access)
// Mirrors applyBranchFilter: only role 1 or branch_access 'all' is unrestricted.
function isBranchScoped(user, branch_id) {
  if (branch_id) return true;
  if (Number(user.role_id) === 1) return false;
  return String(user.branch_access ?? '').trim().toLowerCase() !== 'all';
}

// Compute the equal-length window immediately preceding [from, to].
function previousWindow(from, to) {
  const DAY = 24 * 60 * 60 * 1000;
  const fromDate = new Date(`${from}T00:00:00`);
  const toDate   = new Date(`${to}T00:00:00`);
  const lengthDays = Math.round((toDate - fromDate) / DAY) + 1; // inclusive
  const prevTo   = new Date(fromDate - DAY);
  const prevFrom = new Date(prevTo - (lengthDays - 1) * DAY);
  return {
    from: prevFrom.toISOString().slice(0, 10),
    to:   prevTo.toISOString().slice(0, 10),
  };
}

// Signed percentage change current vs previous. null when previous is 0/unknown.
function pctChange(current, previous) {
  if (!previous || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10; // 1 decimal
}

// ── Per-metric, single-window queries (returned as Promises of numbers) ──────

function totalBookingsFor(user, branch_id, opts) {
  return applyFilters(
    db('edx_bookings as b').count('b.id as count').first(),
    user, 'b.branch_id', opts
  ).then(r => Number(r?.count) || 0);
}

function activeBookingsFor(user, branch_id, opts) {
  return applyFilters(
    db('edx_bookings as b').whereIn('b.status', ACTIVE_STATUSES).count('b.id as count').first(),
    user, 'b.branch_id', opts
  ).then(r => Number(r?.count) || 0);
}

function cancelledBookingsFor(user, branch_id, opts) {
  return applyFilters(
    db('edx_bookings as b').whereIn('b.status', CANCELLED_STATUSES).count('b.id as count').first(),
    user, 'b.branch_id', opts
  ).then(r => Number(r?.count) || 0);
}

// New bookings created today — ignores the selected date range, honours branch scope.
function newBookingsTodayFor(user, branch_id, todayStr) {
  return applyFilters(
    db('edx_bookings as b')
      .whereBetween('b.created_on', [`${todayStr} 00:00:00`, `${todayStr} 23:59:59`])
      .count('b.id as count').first(),
    user, 'b.branch_id', { branch_id }
  ).then(r => Number(r?.count) || 0);
}

function completedBookingsFor(user, branch_id, opts) {
  return applyFilters(
    db('edx_bookings as b')
      .join('edx_service_closed as sc', 'sc.booking_id', 'b.id')
      .countDistinct('b.id as count').first(),
    user, 'b.branch_id', opts
  ).then(r => Number(r?.count) || 0);
}

function revenueFor(user, branch_id, opts) {
  return applyFilters(
    db('edx_bookings as b')
      .leftJoin('edx_invoice as inv', 'inv.booking_id', 'b.id')
      .sum('inv.inv_raised_amnt as total').first(),
    user, 'b.branch_id', opts
  ).then(r => Number(r?.total) || 0);
}

function collectedFor(user, branch_id, opts) {
  return applyFilters(
    db('edx_bookings as b')
      .leftJoin('edx_receipts as r', function () {
        this.on('r.booking_id', 'b.id').andOnVal('r.status', '=', 'Approved');
      })
      .sum('r.total_amount as total').first(),
    user, 'b.branch_id', opts
  ).then(r => Number(r?.total) || 0);
}

// Clients: edx_client_app_users has org_id but NO branch_id. When branch-scoped,
// count distinct booking users for that branch instead.
function clientsFor(user, branch_id, opts) {
  if (isBranchScoped(user, branch_id)) {
    return applyFilters(
      db('edx_bookings as b').whereNotNull('b.user_id').countDistinct('b.user_id as count').first(),
      user, 'b.branch_id', opts
    ).then(r => Number(r?.count) || 0);
  }
  let q = db('edx_client_app_users').where('org_id', user.org_id);
  if (opts.from && opts.to) {
    q = q.whereBetween('created_on', [`${opts.from} 00:00:00`, `${opts.to} 23:59:59`]);
  }
  return q.count('* as count').first().then(r => Number(r?.count) || 0);
}

// ── Controller ───────────────────────────────────────────────────────────────

const getDashboardStats = async (req, res) => {
  try {
    // org_id always from getOrgId (never a default org; guarded → 401 when null)
    const user      = { ...req.login_data, org_id: getOrgId(req) };
    const branch_id = req.query.branch_id ? parseInt(req.query.branch_id) : null;

    // Default date range: last 30 days
    const today = new Date();
    const to    = req.query.to   || today.toISOString().slice(0, 10);
    const from  = req.query.from ||
      new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const opts = { from, to, branch_id };
    const prev = previousWindow(from, to);
    const prevOpts = { from: prev.from, to: prev.to, branch_id };
    const todayStr = today.toISOString().slice(0, 10);

    const [
      // current-period summary metrics
      totalBookings, activeBookings, completedBookings,
      totalRevenue, totalCollected, totalClients,
      // billed (for outstanding)
      billedRow,
      // operational mini-stats
      cancelledBookings, newBookingsToday,
      // previous-period metrics (for trends)
      pTotalBookings, pActiveBookings, pCompletedBookings,
      pRevenue, pCollected, pClients,
      // charts
      weeklyRows, serviceRows, topCgRows, cityRows, hpCount, statusRows,
    ] = await Promise.all([
      totalBookingsFor(user, branch_id, opts),
      activeBookingsFor(user, branch_id, opts),
      completedBookingsFor(user, branch_id, opts),
      revenueFor(user, branch_id, opts),
      collectedFor(user, branch_id, opts),
      clientsFor(user, branch_id, opts),

      // total billed = total revenue (raised); kept explicit for outstanding calc
      revenueFor(user, branch_id, opts),

      cancelledBookingsFor(user, branch_id, opts),
      newBookingsTodayFor(user, branch_id, todayStr),

      totalBookingsFor(user, branch_id, prevOpts),
      activeBookingsFor(user, branch_id, prevOpts),
      completedBookingsFor(user, branch_id, prevOpts),
      revenueFor(user, branch_id, prevOpts),
      collectedFor(user, branch_id, prevOpts),
      clientsFor(user, branch_id, prevOpts),

      // ── Weekly bookings: last 7 days grouped by day-of-week ───────────────
      applyBranchFilter(
        db('edx_bookings as b')
          .where('b.org_id', user.org_id)
          .whereRaw('b.created_on >= DATE_SUB(NOW(), INTERVAL 7 DAY)')
          .select(
            db.raw('DAYOFWEEK(b.created_on) AS dow'),
            db.raw('COUNT(*)                AS count')
          )
          .groupByRaw('DAYOFWEEK(b.created_on)'),
        user, 'b.branch_id'
      ).modify(q => { if (branch_id) q.where('b.branch_id', branch_id); }),

      // ── Service distribution grouped by CATEGORY ──────────────────────────
      applyFilters(
        db('edx_bookings as b')
          .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
          .leftJoin('edx_master_services_category as msc', 'ms.service_category_id', 'msc.id')
          .select(
            db.raw("COALESCE(msc.name, 'Other') AS service_name"),
            db.raw('COUNT(b.id)                AS count')
          )
          .groupBy('msc.id', 'msc.name')
          .orderBy('count', 'desc')
          .limit(6),
        user, 'b.branch_id', opts
      ),

      // ── Top CGs by booking count ──────────────────────────────────────────
      applyFilters(
        db('edx_bookings as b')
          .join('edx_booking_hp as bh', 'bh.bkng_id', 'b.id')
          .join('edx_hp_registration as hp', 'bh.hp_unique_id', 'hp.hp_reg_id')
          .select(
            'hp.hp_reg_id',
            db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''), ' ', COALESCE(hp.hp_reg_last_name,'')) AS hp_name"),
            db.raw('COUNT(bh.bkng_id) AS booking_count')
          )
          .groupBy('bh.hp_unique_id', 'hp.hp_reg_id',
                   'hp.hp_reg_first_name', 'hp.hp_reg_last_name')
          .orderBy('booking_count', 'desc')
          .limit(4),
        user, 'b.branch_id', opts
      ),

      // ── City performance by branch ────────────────────────────────────────
      applyFilters(
        db('edx_bookings as b')
          .join('edx_branches as br', 'b.branch_id', 'br.br_id')
          .leftJoin(
            db('edx_invoice')
              .select('booking_id')
              .sum('inv_raised_amnt as total')
              .groupBy('booking_id')
              .as('inv'),
            'inv.booking_id', 'b.id'
          )
          .select(
            'br.br_id',
            db.raw('br.br_name AS city'),
            db.raw('COUNT(b.id) AS bookings'),
            db.raw('COALESCE(SUM(inv.total),0) AS revenue')
          )
          .groupBy('br.br_id', 'br.br_name')
          .orderBy('bookings', 'desc')
          .limit(5),
        user, 'b.branch_id', opts
      ),

      // ── Total approved HPs ────────────────────────────────────────────────
      applyBranchFilter(
        db('edx_hp_registration')
          .where('org_id', user.org_id)
          .where('hp_reg_status', 2)           // 2 = Approved
          .count('* as count')
          .first(),
        user, 'hp_reg_branch_id'
      ).modify(q => { if (branch_id) q.where('hp_reg_branch_id', branch_id); }),

      // ── Booking status breakdown (numeric → readable label) ───────────────
      applyFilters(
        db('edx_bookings as b')
          .select(
            db.raw(`CASE b.status
                      WHEN '1' THEN 'Booking Submitted'
                      WHEN '2' THEN 'HP Assigned'
                      WHEN '3' THEN 'Booking Cancelled'
                      WHEN '4' THEN 'Service Started'
                      WHEN '5' THEN 'On Hold'
                      WHEN '6' THEN 'Service Cancelled'
                      WHEN '7' THEN 'Suspended'
                      ELSE 'Unknown' END AS status`),
            db.raw('COUNT(*) AS count')
          )
          .groupByRaw('b.status'),
        user, 'b.branch_id', opts
      ),
    ]);

    // Map DAYOFWEEK rows → ordered Mon-Sun array
    const dowMap = {};
    weeklyRows.forEach(r => { dowMap[r.dow] = Number(r.count); });
    const weeklyBookings = WEEK_ORDER.map(dow => ({
      day:   DOW_TO_NAME[dow],
      count: dowMap[dow] || 0,
    }));

    const totalBilled = Number(billedRow) || 0;
    const outstanding = Math.max(0, totalBilled - totalCollected);
    const cancellationRate = totalBookings > 0
      ? Math.round((cancelledBookings / totalBookings) * 1000) / 10
      : 0;

    return res.json({
      from,
      to,
      totalClients,
      totalBookings,
      activeBookings,
      completedBookings,
      cancelledBookings,
      cancellationRate,
      newBookingsToday,
      totalRevenue,
      totalBilled,
      totalCollected,
      outstanding,
      totalHPs: Number(hpCount?.count) || 0,
      trends: {
        totalClients:      pctChange(totalClients,      pClients),
        totalBookings:     pctChange(totalBookings,     pTotalBookings),
        activeBookings:    pctChange(activeBookings,    pActiveBookings),
        completedBookings: pctChange(completedBookings, pCompletedBookings),
        totalRevenue:      pctChange(totalRevenue,      pRevenue),
        totalCollected:    pctChange(totalCollected,    pCollected),
      },
      weeklyBookings,
      serviceDistribution: serviceRows.map(r => ({
        name:  r.service_name || 'Other',
        count: Number(r.count),
      })),
      topCgs: topCgRows.map(r => ({
        hp_reg_id: r.hp_reg_id,
        name:      (r.hp_name || '').trim() || `HP #${r.hp_reg_id}`,
        bookings:  Number(r.booking_count),
      })),
      cityPerformance: cityRows.map((r, i) => ({
        rank:     i + 1,
        city:     r.city,
        bookings: Number(r.bookings),
        revenue:  Number(r.revenue),
      })),
      bookingStatusBreakdown: statusRows.map(r => ({
        status: r.status || 'Unknown',
        count:  Number(r.count),
      })),
    });
  } catch (error) {
    logger.error(`[dashboardController] getDashboardStats error: ${error.message}`);
    res.status(500).json({ message: 'Failed to fetch dashboard stats.' });
  }
};

module.exports = guardOrgHandlers({ getDashboardStats });
