/**
 * planUsage.js — org usage vs plan limits.
 *
 * Usage counts (shared by the owner usage/downgrade screens and enforcement):
 *   bookings — every booking of the org that is not cancelled (status 3/6)
 *   HPs      — caregivers whose hp_reg_status is 2 (approved), 5 (on an active
 *              booking) or 6 (in a booking pipeline) — the same set allowed to
 *              log in to the caregiver portal. edx_hp_registration has no
 *              is_active column; its PK is hp_reg_id.
 *
 * checkPlanLimit() enforces booking_limit (bookings created this calendar
 * month) and hp_limit (active HPs) only when ENFORCE_PLAN_LIMITS === 'true'.
 * A null/0 limit means unlimited.
 */

const db = require('../config/db');
const { CANCELLED_BOOKING_STATUSES } = require('./bookingStatus');

const ACTIVE_HP_STATUSES = [2, 5, 6];

const PLAN_LIMIT_CODE = 'PLAN_LIMIT';

async function countActiveBookings(orgId, conn = db) {
  const row = await conn('edx_bookings')
    .where('org_id', orgId)
    .whereNotIn('status', CANCELLED_BOOKING_STATUSES)
    .count('id as cnt')
    .first();
  return parseInt(row?.cnt || 0, 10);
}

async function countActiveHPs(orgId, conn = db) {
  const row = await conn('edx_hp_registration')
    .where('org_id', orgId)
    .whereIn('hp_reg_status', ACTIVE_HP_STATUSES)
    .count('hp_reg_id as cnt')
    .first();
  return parseInt(row?.cnt || 0, 10);
}

/** Booking counts per org (owner dashboards), keyed by org_id. */
async function activeBookingCountsByOrg(conn = db) {
  const rows = await conn('edx_bookings')
    .whereNotIn('status', CANCELLED_BOOKING_STATUSES)
    .groupBy('org_id')
    .select('org_id', conn.raw('COUNT(id) as cnt'));
  const map = {};
  for (const r of rows) map[r.org_id] = parseInt(r.cnt || 0, 10);
  return map;
}

function monthBounds(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  return { start: `${y}-${pad(m)}-01 00:00:00`, end: `${y}-${pad(m)}-${pad(last)} 23:59:59` };
}

async function countBookingsThisMonth(orgId, conn = db) {
  const { start, end } = monthBounds();
  const row = await conn('edx_bookings')
    .where('org_id', orgId)
    .whereBetween('created_on', [start, end])
    .count('id as cnt')
    .first();
  return parseInt(row?.cnt || 0, 10);
}

async function currentPlan(orgId, conn = db) {
  return conn('edx_subscriptions as s')
    .join('edx_plans as p', 's.plan_id', 'p.id')
    .where('s.org_id', orgId)
    .orderBy('s.id', 'desc')
    .select('p.name', 'p.booking_limit', 'p.hp_limit')
    .first();
}

/**
 * Returns null when the action is allowed, or a 403 body
 * { error, message, code: 'PLAN_LIMIT' } when it would exceed the plan.
 * kind: 'booking' | 'hp'
 */
async function checkPlanLimit(orgId, kind, conn = db) {
  if (process.env.ENFORCE_PLAN_LIMITS !== 'true') return null;
  const plan = await currentPlan(orgId, conn);
  if (!plan) return null;

  const limit = Number(kind === 'booking' ? plan.booking_limit : plan.hp_limit) || 0;
  if (limit <= 0) return null; // unlimited

  const used = kind === 'booking'
    ? await countBookingsThisMonth(orgId, conn)
    : await countActiveHPs(orgId, conn);
  if (used < limit) return null;

  const text = kind === 'booking'
    ? `Your ${plan.name} plan allows ${limit} bookings per month. Upgrade your plan to create more.`
    : `Your ${plan.name} plan allows ${limit} active caregivers. Upgrade your plan to add more.`;
  return { error: text, message: text, code: PLAN_LIMIT_CODE, limit, used };
}

module.exports = {
  ACTIVE_HP_STATUSES,
  PLAN_LIMIT_CODE,
  countActiveBookings,
  countActiveHPs,
  activeBookingCountsByOrg,
  countBookingsThisMonth,
  checkPlanLimit,
};
