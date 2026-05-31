/**
 * dashboardController.js — Phase 4.1
 *
 * Replaces 7 client-side API calls + 6 in-browser aggregations with a single
 * server-side endpoint that runs 6 SQL aggregation queries in parallel.
 *
 * GET /api/getDashboardStats?from=YYYY-MM-DD&to=YYYY-MM-DD&branch_id=N
 */

const db = require('../../config/db');
const logger = require('../../logger');
const applyBranchFilter = require('../../utils/applyBranchFilter');
const { getOrgId } = require('../../utils/orgScope');

// Day-of-week mapping: MySQL DAYOFWEEK returns 1=Sun … 7=Sat
const DOW_TO_NAME = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri', 7: 'Sat' };
const WEEK_ORDER  = [2, 3, 4, 5, 6, 7, 1]; // Mon → Sun

// ── Helper: apply both JWT branch access AND optional explicit branch filter ──

function applyFilters(query, user, branchCol, { from, to, branch_id } = {}) {
  // Org isolation — always first
  query = query.where('b.org_id', user.org_id ?? 1);
  // JWT-level branch access (superadmin bypasses)
  query = applyBranchFilter(query, user, branchCol);
  // Caller-requested single-branch override
  if (branch_id) query = query.where(branchCol, branch_id);
  // Date range
  if (from && to) {
    query = query.whereBetween('b.created_on', [`${from} 00:00:00`, `${to} 23:59:59`]);
  }
  return query;
}

// ── Controller ───────────────────────────────────────────────────────────────

const getDashboardStats = async (req, res) => {
  try {
    const user      = req.login_data;
    const branch_id = req.query.branch_id ? parseInt(req.query.branch_id) : null;

    // Default date range: last 30 days
    const today = new Date();
    const to    = req.query.to   || today.toISOString().slice(0, 10);
    const from  = req.query.from ||
      new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const opts = { from, to, branch_id };

    const [summary, weeklyRows, serviceRows, topCgRows, cityRows, hpCount, statusRows] =
      await Promise.all([

        // ── 1. Summary: total, active, revenue ────────────────────────────────
        applyFilters(
          db('edx_bookings as b')
            .leftJoin(
              db('edx_invoice')
                .select('booking_id')
                .sum('inv_raised_amnt as total')
                .groupBy('booking_id')
                .as('inv'),
              'inv.booking_id', 'b.id'
            )
            .select(
              db.raw('COUNT(b.id)                                           AS total_bookings'),
              db.raw(`SUM(CASE WHEN b.status IN
                         ('Confirmed','Active','In-Progress','InProgress','confirmed','active')
                         THEN 1 ELSE 0 END)                               AS active_bookings`),
              db.raw('COALESCE(SUM(inv.total), 0)                         AS total_revenue')
            )
            .first(),
          user, 'b.branch_id', opts
        ),

        // ── 2. Weekly bookings: last 7 days grouped by day-of-week ───────────
        applyBranchFilter(
          db('edx_bookings as b')
            .where('b.org_id', user.org_id ?? 1)
            .whereRaw('b.created_on >= DATE_SUB(NOW(), INTERVAL 7 DAY)')
            .select(
              db.raw('DAYOFWEEK(b.created_on) AS dow'),
              db.raw('COUNT(*)                AS count')
            )
            .groupByRaw('DAYOFWEEK(b.created_on)'),
          user, 'b.branch_id'
        ).modify(q => { if (branch_id) q.where('b.branch_id', branch_id); }),

        // ── 3. Service distribution ───────────────────────────────────────────
        applyFilters(
          db('edx_bookings as b')
            .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
            .select(
              db.raw("COALESCE(ms.name, 'Other') AS service_name"),
              db.raw('COUNT(b.id)                AS count')
            )
            .groupBy('b.service_type_id', 'ms.name')
            .orderBy('count', 'desc')
            .limit(6),
          user, 'b.branch_id', opts
        ),

        // ── 4. Top CGs by booking count ───────────────────────────────────────
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

        // ── 5. City performance by branch ─────────────────────────────────────
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

        // ── 6. Total approved HPs ─────────────────────────────────────────────
        applyBranchFilter(
          db('edx_hp_registration')
            .where('org_id', user.org_id ?? 1)
            .where('hp_reg_status', 2)           // 2 = Approved
            .count('* as count')
            .first(),
          user, 'hp_reg_branch_id'
        ).modify(q => { if (branch_id) q.where('hp_reg_branch_id', branch_id); }),

        // ── 7. Booking status breakdown ───────────────────────────────────────
        applyFilters(
          db('edx_bookings as b')
            .select('b.status', db.raw('COUNT(*) AS count'))
            .groupBy('b.status'),
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

    return res.json({
      from,
      to,
      totalBookings:       Number(summary?.total_bookings)  || 0,
      activeBookings:      Number(summary?.active_bookings) || 0,
      totalRevenue:        Number(summary?.total_revenue)   || 0,
      totalHPs:            Number(hpCount?.count)           || 0,
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
    logger.error('[dashboardController] getDashboardStats error:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard stats.', details: error.message });
  }
};

module.exports = { getDashboardStats };
