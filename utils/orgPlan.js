/**
 * orgPlan.js — move an organisation onto a plan: close its live
 * subscription(s), open the new one and keep edx_organizations (plan and
 * kill-switch status) in step. Shared by the owner's direct plan change
 * (updateOrgPlan) and by approving a Super Admin's plan request.
 */
const db = require('../config/db');
const { getCurrentDateTime } = require('./dateTime');
const { logAudit } = require('./auditLogger');
const withTransaction = require('./withTransaction');
const { orgStatusForSubscription } = require('./orgStatus');
const { invalidateOrgStatusCache } = require('../middlewares/orgStatusGate');
const { countActiveBookings, countActiveHPs } = require('./planUsage');
const { parseLocalDate, formatLocalDate } = require('./accountsCalc');

// The org's latest subscription with its plan (any status).
function latestSubscription(orgId, conn = db) {
  return conn('edx_subscriptions as s')
    .join('edx_plans as p', 's.plan_id', 'p.id')
    .where('s.org_id', orgId)
    .select(
      's.id as subscription_id', 's.status', 's.started_on', 's.expires_on',
      'p.id as plan_id', 'p.name as plan_name', 'p.features', 'p.booking_limit',
      'p.hp_limit', 'p.price_per_month',
    )
    .orderBy('s.id', 'desc')
    .first();
}

// DATE column value (a Date from mysql2, or a string) → 'YYYY-MM-DD' or null.
function dateOnly(value) {
  const d = parseLocalDate(value);
  return d ? formatLocalDate(d) : null;
}

// `d` + `months` calendar months, clamped to the target month's last day.
function addMonths(d, months) {
  const first = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), lastDay));
}

/**
 * Expiry after extending by `months`: from the current expiry while it is in
 * the future, else from today. A subscription with no end date keeps none.
 */
function extendedExpiry(currentExpiresOn, months, today = new Date()) {
  const current = parseLocalDate(currentExpiresOn);
  if (!current) return null;
  const start = parseLocalDate(today);
  return formatLocalDate(addMonths(current > start ? current : start, months));
}

// Why the org can't move down to `plan` (usage above its limits), or null.
async function downgradeBlockReason(orgId, currentPlanId, plan) {
  if (currentPlanId == null || !(parseInt(currentPlanId, 10) > parseInt(plan.id, 10))) return null;
  const bookingsUsed = await countActiveBookings(orgId);
  const hpUsed = await countActiveHPs(orgId);
  const bookingLimit = plan.booking_limit || 0;
  const hpLimit = plan.hp_limit || 0;
  const reasons = [];
  if (bookingLimit > 0 && bookingsUsed > bookingLimit) {
    reasons.push(`${bookingsUsed} active bookings exceed the ${plan.name} limit of ${bookingLimit}`);
  }
  if (hpLimit > 0 && hpUsed > hpLimit) {
    reasons.push(`${hpUsed} active HPs exceed the ${plan.name} limit of ${hpLimit}`);
  }
  return reasons.length ? reasons.join('. ') : null;
}

/**
 * Put org `orgId` on `plan` (an edx_plans row). Returns { subscriptionId } or
 * { blocked } when it is a downgrade the org's usage doesn't fit.
 * `inTransaction(trx)` runs inside the same transaction (e.g. to mark the
 * request that asked for it approved); throwing from it rolls everything back.
 */
async function applyOrgPlan({
  orgId, plan, status = 'active', expiresOn = null, changedBy, reason, inTransaction,
}) {
  const org = await db('edx_organizations').where('id', orgId).first('id', 'status');
  const currentSub = await db('edx_subscriptions').where('org_id', orgId).orderBy('id', 'desc').first();

  const blocked = await downgradeBlockReason(orgId, currentSub?.plan_id, plan);
  if (blocked) return { blocked };

  const newOrgStatus = orgStatusForSubscription(status);
  const subscriptionId = await withTransaction(async (trx) => {
    await trx('edx_subscriptions')
      .where({ org_id: orgId })
      .whereIn('status', ['active', 'trial'])
      .update({ status: 'cancelled', updated_on: getCurrentDateTime() });

    const [subId] = await trx('edx_subscriptions').insert({
      org_id: orgId,
      plan_id: plan.id,
      status,
      started_on: getCurrentDateTime(),
      expires_on: expiresOn || null,
      activated_by: changedBy,
      created_on: getCurrentDateTime(),
    });

    await trx('edx_organizations').where({ id: orgId }).update({ plan_id: plan.id, status: newOrgStatus });
    if (inTransaction) await inTransaction(trx, subId);
    return subId;
  });
  invalidateOrgStatusCache(orgId);

  logAudit({
    entityType: 'ORGANISATION',
    entityId: Number(orgId),
    action: 'STATUS_CHANGE',
    changedBy,
    org_id: Number(orgId),
    oldValues: { plan_id: currentSub?.plan_id, sub_status: currentSub?.status, org_status: org?.status },
    newValues: { plan_id: plan.id, status, org_status: newOrgStatus, expires_on: expiresOn || null, reason },
  });

  return { subscriptionId };
}

module.exports = {
  latestSubscription,
  dateOnly,
  addMonths,
  extendedExpiry,
  downgradeBlockReason,
  applyOrgPlan,
};
