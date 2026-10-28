/**
 * planRequestController.js — an organisation's plan, and requests to extend
 * or change it.
 *
 * Super Admin of the org (auth + requireStaff + requireSuperAdmin):
 *   GET   /api/getPlanOverview             — current plan, usage, plans, requests
 *   POST  /api/requestPlanExtension        — { plan_id?, extend_months, notes? }
 *   PATCH /api/cancelPlanRequest/:id       — withdraw a pending request
 *
 * Platform owner (auth + requireOwner):
 *   GET   /api/saas/getPlanRequests?status=  — every org's requests
 *   PATCH /api/saas/resolvePlanRequest/:id   — { action: APPROVE|REJECT, notes?, expires_on? }
 */
const db = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { getOrgId } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');
const { notifyOrgAdmins } = require('../../utils/notify');
const { countBookingsThisMonth, countActiveHPs } = require('../../utils/planUsage');
const { parseLocalDate } = require('../../utils/accountsCalc');
const {
  latestSubscription, dateOnly, extendedExpiry, applyOrgPlan,
} = require('../../utils/orgPlan');

const EXTEND_MONTHS = [1, 3, 6, 12];
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

class Conflict extends Error {}

// Requests with their plan names (and the requester's name).
function requestsQuery() {
  return db('edx_plan_requests as r')
    .leftJoin('edx_plans as cp', 'cp.id', 'r.current_plan_id')
    .leftJoin('edx_plans as rp', 'rp.id', 'r.requested_plan_id')
    .leftJoin('edx_web_app_users as u', 'u.id', 'r.requested_by')
    .select('r.*', 'cp.name as current_plan_name', 'rp.name as requested_plan_name',
      'u.user_name as requested_by_name')
    .orderBy('r.id', 'desc');
}

const withDates = (r) => ({ ...r, new_expires_on: dateOnly(r.new_expires_on) });

// Whole days from today to `expiresOn` (negative once expired), or null.
function daysLeft(expiresOn) {
  const end = parseLocalDate(expiresOn);
  if (!end) return null;
  const today = parseLocalDate(new Date());
  return Math.round((end - today) / 86400000);
}

// ── Super Admin ──────────────────────────────────────────────────────────────

const getPlanOverview = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const [sub, bookingsThisMonth, activeHps, plans, requests] = await Promise.all([
      latestSubscription(orgId),
      countBookingsThisMonth(orgId),
      countActiveHPs(orgId),
      db('edx_plans').where('is_active', 1)
        .select('id', 'name', 'features', 'booking_limit', 'hp_limit', 'price_per_month')
        .orderBy('price_per_month', 'asc'),
      requestsQuery().where('r.org_id', orgId).limit(20),
    ]);

    const subscription = sub ? {
      ...sub,
      started_on: dateOnly(sub.started_on),
      expires_on: dateOnly(sub.expires_on),
      days_left: daysLeft(sub.expires_on),
    } : null;
    const list = (requests || []).map(withDates);
    res.json({
      subscription,
      usage: {
        bookings_this_month: bookingsThisMonth,
        booking_limit: sub?.booking_limit ?? null,
        active_caregivers: activeHps,
        hp_limit: sub?.hp_limit ?? null,
      },
      plans,
      requests: list,
      pending_request: list.find((r) => r.status === 'PENDING') || null,
    });
  } catch (err) {
    logger.error(`[planRequestController] getPlanOverview error: ${err.message}`);
    res.status(500).json({ message: 'Failed to load your plan.' });
  }
};

const requestPlanExtension = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const months = parseInt(req.body.extend_months, 10);
    if (!EXTEND_MONTHS.includes(months)) {
      return res.status(400).json({ message: `extend_months must be one of: ${EXTEND_MONTHS.join(', ')}.` });
    }
    const notes = String(req.body.notes ?? '').trim().slice(0, 500) || null;

    const sub = await latestSubscription(orgId);
    if (!sub) return res.status(404).json({ message: 'No subscription found for your organisation.' });

    const planId = req.body.plan_id != null && req.body.plan_id !== ''
      ? parseInt(req.body.plan_id, 10) : sub.plan_id;
    if (!Number.isInteger(planId)) return res.status(400).json({ message: 'plan_id must be a number.' });
    if (planId !== sub.plan_id) {
      const plan = await db('edx_plans').where({ id: planId, is_active: 1 }).first('id');
      if (!plan) return res.status(404).json({ message: 'That plan is not available.' });
    }

    const pending = await db('edx_plan_requests').where({ org_id: orgId, status: 'PENDING' }).first('id');
    if (pending) {
      return res.status(409).json({ message: `Request #${pending.id} is still waiting for approval.` });
    }

    const [id] = await db('edx_plan_requests').insert({
      org_id: orgId,
      subscription_id: sub.subscription_id,
      current_plan_id: sub.plan_id,
      requested_plan_id: planId,
      extend_months: months,
      notes,
      status: 'PENDING',
      requested_by: req.login_data?.id ?? null,
      requested_on: getCurrentDateTime(),
    });
    const created = await requestsQuery().where('r.id', id).first();
    res.status(201).json({ message: 'Request sent to the Eldivex team.', data: withDates(created) });
  } catch (err) {
    logger.error(`[planRequestController] requestPlanExtension error: ${err.message}`);
    res.status(500).json({ message: 'Failed to send the request.' });
  }
};

const cancelPlanRequest = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const id = parseInt(req.params.id, 10);
    const changed = await db('edx_plan_requests')
      .where({ id, org_id: orgId, status: 'PENDING' })
      .update({
        status: 'CANCELLED',
        resolved_by: req.login_data?.id ?? null,
        resolved_on: getCurrentDateTime(),
      });
    if (!changed) return res.status(409).json({ message: 'Only a pending request can be withdrawn.' });
    res.json({ message: 'Request withdrawn.' });
  } catch (err) {
    logger.error(`[planRequestController] cancelPlanRequest error: ${err.message}`);
    res.status(500).json({ message: 'Failed to withdraw the request.' });
  }
};

// ── Platform owner ───────────────────────────────────────────────────────────

const getPlanRequests = async (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const q = requestsQuery()
      .leftJoin('edx_organizations as o', 'o.id', 'r.org_id')
      .select('o.name as org_name', 'o.org_code');
    if (STATUSES.includes(status)) q.where('r.status', status);
    const rows = await q.limit(200);

    // Each org's latest subscription, for the expiry an approval would set.
    const orgIds = [...new Set((rows || []).map((r) => r.org_id))];
    const subs = orgIds.length
      ? await db('edx_subscriptions').whereIn('org_id', orgIds).orderBy('id', 'desc')
        .select('org_id', 'plan_id', 'status', 'expires_on')
      : [];
    const latest = new Map();
    for (const s of subs || []) if (!latest.has(s.org_id)) latest.set(s.org_id, s);

    res.json((rows || []).map((r) => {
      const s = latest.get(r.org_id);
      return {
        ...withDates(r),
        current_status: s?.status ?? null,
        current_expires_on: dateOnly(s?.expires_on),
        proposed_expires_on: r.status === 'PENDING' ? extendedExpiry(s?.expires_on, r.extend_months) : null,
      };
    }));
  } catch (err) {
    logger.error(`[planRequestController] getPlanRequests error: ${err.message}`);
    res.status(500).json({ message: 'Failed to load plan requests.' });
  }
};

const resolvePlanRequest = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const action = String(req.body.action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ message: 'action must be APPROVE or REJECT.' });
    }
    const notes = String(req.body.notes ?? '').trim().slice(0, 500) || null;
    const ownerId = req.login_data?.id ?? null;

    const request = await db('edx_plan_requests').where({ id }).first();
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (request.status !== 'PENDING') {
      return res.status(409).json({ message: `Request is already ${request.status.toLowerCase()}.` });
    }
    const resolved = (status, extra = {}) => ({
      status, resolved_by: ownerId, resolved_on: getCurrentDateTime(), resolution_notes: notes, ...extra,
    });

    if (action === 'REJECT') {
      const changed = await db('edx_plan_requests').where({ id, status: 'PENDING' }).update(resolved('REJECTED'));
      if (!changed) return res.status(409).json({ message: 'Request was already resolved.' });
      notifyOrgAdmins(request.org_id, {
        type: 'subscription',
        title: 'Plan request declined',
        body: notes || 'Your plan extension request was declined. Contact the Eldivex team for details.',
        data: { plan_request_id: id, route: 'settings' },
      });
      return res.json({ message: 'Request rejected.' });
    }

    // Owner-chosen expiry wins; otherwise extend the current one.
    let expiresOn = null;
    if (req.body.expires_on) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expires_on)) || !parseLocalDate(req.body.expires_on)) {
        return res.status(400).json({ message: 'expires_on must be YYYY-MM-DD.' });
      }
      expiresOn = String(req.body.expires_on);
    } else {
      const sub = await latestSubscription(request.org_id);
      expiresOn = extendedExpiry(sub?.expires_on, request.extend_months);
    }

    const plan = await db('edx_plans').where('id', request.requested_plan_id).first();
    if (!plan) return res.status(404).json({ message: 'The requested plan no longer exists.' });

    let result;
    try {
      result = await applyOrgPlan({
        orgId: request.org_id,
        plan,
        status: 'active',
        expiresOn,
        changedBy: ownerId,
        reason: `Plan request #${id}${notes ? `: ${notes}` : ''}`,
        inTransaction: async (trx) => {
          const changed = await trx('edx_plan_requests').where({ id, status: 'PENDING' })
            .update(resolved('APPROVED', { new_expires_on: expiresOn }));
          if (!changed) throw new Conflict('Request was already resolved.');
        },
      });
    } catch (err) {
      if (err instanceof Conflict) return res.status(409).json({ message: err.message });
      throw err;
    }
    if (result.blocked) return res.status(422).json({ message: result.blocked, code: 'DOWNGRADE_BLOCKED' });

    notifyOrgAdmins(request.org_id, {
      type: 'subscription',
      title: `Plan request approved — ${plan.name}`,
      body: expiresOn ? `Your plan is now valid until ${expiresOn}.` : 'Your plan has no end date.',
      data: { plan_request_id: id, route: 'settings' },
    });
    res.json({ message: 'Request approved.', expires_on: expiresOn, subscription_id: result.subscriptionId });
  } catch (err) {
    logger.error(`[planRequestController] resolvePlanRequest error: ${err.message}`);
    res.status(500).json({ message: 'Failed to resolve the request.' });
  }
};

module.exports = {
  ...guardOrgHandlers({ getPlanOverview, requestPlanExtension, cancelPlanRequest }),
  getPlanRequests,
  resolvePlanRequest,
};
