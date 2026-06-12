/**
 * subscriptionController.js — Phase 5.2
 *
 * GET  /api/getPlans              — public; returns all plan tiers
 * GET  /api/getSubscriptionStatus — authenticated; returns org's current plan
 * PUT  /api/updateOrgPlan         — superadmin (role_id = 1) only
 * POST /api/createPlan            — superadmin; create a plan tier
 * PUT  /api/updatePlan/:id        — superadmin; edit a plan tier
 * PATCH /api/togglePlanActive/:id — superadmin; retire/restore a plan
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { logAudit }           = require('../../utils/auditLogger');

function requireSuperadmin(req, res) {
  // Owner = is_owner JWT claim from /ownerLogin, never a tenant role.
  if (req.login_data?.is_owner !== true) {
    res.status(403).json({ message: 'Owner access required.' });
    return false;
  }
  return true;
}

// ── 1. Get all plans (public) ─────────────────────────────────────────────────

const getPlans = async (req, res) => {
  try {
    const plans = await db('edx_plans').select(
      'id', 'name', 'features', 'booking_limit', 'hp_limit', 'price_per_month', 'is_active'
    );
    res.json(plans);
  } catch (err) {
    logger.error(`[subscriptionController] getPlans error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch plans.' });
  }
};

// ── 2. Get org subscription status ───────────────────────────────────────────

const getSubscriptionStatus = async (req, res) => {
  try {
    const orgId = req.login_data?.org_id ?? 1;

    const sub = await db('edx_subscriptions as s')
      .join('edx_plans as p', 's.plan_id', 'p.id')
      .where('s.org_id', orgId)
      .select(
        's.id as subscription_id',
        's.status',
        's.started_on',
        's.expires_on',
        'p.id as plan_id',
        'p.name as plan_name',
        'p.features',
        'p.booking_limit',
        'p.hp_limit',
        'p.price_per_month',
      )
      .orderBy('s.id', 'desc')
      .first();

    if (!sub) {
      return res.status(404).json({ message: 'No subscription found for this organisation.' });
    }

    res.json(sub);
  } catch (err) {
    logger.error(`[subscriptionController] getSubscriptionStatus error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch subscription status.' });
  }
};

// ── 3. Update org plan (superadmin only) ─────────────────────────────────────

const updateOrgPlan = async (req, res) => {
  try {
    if (req.login_data?.is_owner !== true) {
      return res.status(403).json({ message: 'Owner access required.' });
    }

    const { org_id, plan_id, status = 'active', expires_on, reason } = req.body;
    if (!org_id || !plan_id) {
      return res.status(400).json({ message: 'org_id and plan_id are required.' });
    }

    const targetPlan = await db('edx_plans').where('id', plan_id).first();
    if (!targetPlan) return res.status(404).json({ message: 'Plan not found.' });

    // Re-check downgrade viability on the server (can't be bypassed via direct API call)
    const currentSub = await db('edx_subscriptions')
      .where('org_id', org_id)
      .orderBy('id', 'desc')
      .first();

    if (currentSub && parseInt(currentSub.plan_id) > parseInt(plan_id)) {
      // Moving to a lower plan — check usage
      const bookingsUsed = await db('edx_bookings')
        .where('org_id', org_id)
        .whereNotIn('status', ['Cancelled'])
        .count('id as cnt')
        .first()
        .then(r => parseInt(r?.cnt || 0));

      const hpUsed = await db('edx_hp_registration')
        .where('org_id', org_id)
        .where('is_active', 1)
        .count('id as cnt')
        .first()
        .then(r => parseInt(r?.cnt || 0))
        .catch(() => 0);

      const bookingLimit = targetPlan.booking_limit || 0;
      const hpLimit      = targetPlan.hp_limit      || 0;
      const blockReasons = [];

      if (bookingLimit > 0 && bookingsUsed > bookingLimit)
        blockReasons.push(`${bookingsUsed} active bookings exceed the ${targetPlan.name} limit of ${bookingLimit}`);
      if (hpLimit > 0 && hpUsed > hpLimit)
        blockReasons.push(`${hpUsed} active HPs exceed the ${targetPlan.name} limit of ${hpLimit}`);

      if (blockReasons.length > 0) {
        return res.status(422).json({
          message: blockReasons.join('. '),
          code:    'DOWNGRADE_BLOCKED',
        });
      }
    }

    // Upsert: deactivate any existing active subscription, then insert new
    await db('edx_subscriptions')
      .where({ org_id, status: 'active' })
      .update({ status: 'cancelled' });

    const [id] = await db('edx_subscriptions').insert({
      org_id,
      plan_id,
      status,
      started_on:    getCurrentDateTime(),
      expires_on:    expires_on || null,
      activated_by:  req.login_data.id,
      created_on:    getCurrentDateTime(),
    });

    // Also update the org's plan_id reference
    await db('edx_organizations').where({ id: org_id }).update({ plan_id });

    const { logAudit } = require('../../utils/auditLogger');
    setImmediate(() => {
      logAudit({
        entityType: 'ORGANISATION',
        entityId:   org_id,
        action:     'STATUS_CHANGE',
        changedBy:  req.login_data.id,
        oldValues:  { plan_id: currentSub?.plan_id },
        newValues:  { plan_id, status, reason },
      });
    });

    const sub = await db('edx_subscriptions').where({ id }).first();
    res.json({ message: 'Subscription updated successfully.', data: sub });
  } catch (err) {
    logger.error(`[subscriptionController] updateOrgPlan error: ${err.message}`);
    res.status(500).json({ message: 'Failed to update subscription.' });
  }
};

// ── 4. Plans with usage (owner only — for the Plans management UI) ───────────

const getPlansWithUsage = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const plans = await db('edx_plans').select('*').orderBy('id', 'asc');

    // Orgs currently on each plan (via their latest subscription)
    const counts = await db('edx_subscriptions as s')
      .join(
        db('edx_subscriptions')
          .select('org_id')
          .max('id as sub_id')
          .groupBy('org_id')
          .as('latest_sub_ref'),
        'latest_sub_ref.sub_id', 's.id'
      )
      .whereIn('s.status', ['active', 'trial'])
      .groupBy('s.plan_id')
      .select('s.plan_id', db.raw('COUNT(*) as cnt'));

    const countMap = {};
    for (const row of counts) countMap[row.plan_id] = parseInt(row.cnt || 0);

    res.json(plans.map((p) => ({ ...p, active_orgs: countMap[p.id] || 0 })));
  } catch (err) {
    logger.error(`[subscriptionController] getPlansWithUsage error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch plans.' });
  }
};

// ── 5. Create plan (superadmin only) ─────────────────────────────────────────

const createPlan = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { name, features, booking_limit = 0, hp_limit = 0, price_per_month = 0 } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Plan name is required.' });
    }

    const duplicate = await db('edx_plans')
      .whereRaw('LOWER(name) = ?', [name.trim().toLowerCase()])
      .first();
    if (duplicate) {
      return res.status(409).json({ message: `A plan named "${duplicate.name}" already exists.` });
    }

    const [id] = await db('edx_plans').insert({
      name:            name.trim(),
      features:        features ? JSON.stringify(features) : null,
      booking_limit:   parseInt(booking_limit) || 0,
      hp_limit:        parseInt(hp_limit) || 0,
      price_per_month: parseFloat(price_per_month) || 0,
      is_active:       true,
      created_on:      getCurrentDateTime(),
    });

    logAudit({
      entityType: 'PLAN',
      entityId:   id,
      action:     'CREATE',
      changedBy:  req.login_data.id,
      newValues:  { name, booking_limit, hp_limit, price_per_month, features },
    });

    const plan = await db('edx_plans').where({ id }).first();
    res.status(201).json({ message: 'Plan created successfully.', data: plan });
  } catch (err) {
    logger.error(`[subscriptionController] createPlan error: ${err.message}`);
    res.status(500).json({ message: 'Failed to create plan.' });
  }
};

// ── 6. Update plan (superadmin only) ─────────────────────────────────────────

const updatePlan = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { id } = req.params;
    const { name, features, booking_limit, hp_limit, price_per_month, force } = req.body;

    const plan = await db('edx_plans').where({ id }).first();
    if (!plan) return res.status(404).json({ message: 'Plan not found.' });

    if (name && name.trim().toLowerCase() !== plan.name.toLowerCase()) {
      const duplicate = await db('edx_plans')
        .whereRaw('LOWER(name) = ?', [name.trim().toLowerCase()])
        .whereNot('id', id)
        .first();
      if (duplicate) {
        return res.status(409).json({ message: `A plan named "${duplicate.name}" already exists.` });
      }
    }

    // When tightening limits, surface orgs whose current usage would exceed
    // the new limits; require force:true to apply anyway (limits are enforced
    // at usage time, so existing orgs keep working but cannot grow).
    const newBookingLimit = booking_limit !== undefined ? parseInt(booking_limit) || 0 : plan.booking_limit;
    const newHpLimit      = hp_limit      !== undefined ? parseInt(hp_limit) || 0      : plan.hp_limit;
    const tightening =
      (newBookingLimit > 0 && (plan.booking_limit === 0 || newBookingLimit < plan.booking_limit)) ||
      (newHpLimit > 0 && (plan.hp_limit === 0 || newHpLimit < plan.hp_limit));

    if (tightening && !force) {
      const orgsOnPlan = await db('edx_subscriptions as s')
        .join(
          db('edx_subscriptions')
            .select('org_id')
            .max('id as sub_id')
            .groupBy('org_id')
            .as('latest_sub_ref'),
          'latest_sub_ref.sub_id', 's.id'
        )
        .join('edx_organizations as o', 's.org_id', 'o.id')
        .where('s.plan_id', id)
        .whereIn('s.status', ['active', 'trial'])
        .select('o.id', 'o.name');

      const affected = [];
      for (const org of orgsOnPlan) {
        const bookingsUsed = await db('edx_bookings')
          .where('org_id', org.id)
          .whereNotIn('status', ['Cancelled'])
          .count('id as cnt')
          .first()
          .then((r) => parseInt(r?.cnt || 0));
        const hpUsed = await db('edx_hp_registration')
          .where('org_id', org.id)
          .where('is_active', 1)
          .count('id as cnt')
          .first()
          .then((r) => parseInt(r?.cnt || 0))
          .catch(() => 0);

        const overBookings = newBookingLimit > 0 && bookingsUsed > newBookingLimit;
        const overHp       = newHpLimit > 0 && hpUsed > newHpLimit;
        if (overBookings || overHp) {
          affected.push({ org_id: org.id, org_name: org.name, bookings_used: bookingsUsed, hp_used: hpUsed });
        }
      }

      if (affected.length > 0) {
        return res.status(409).json({
          code: 'PLAN_LIMIT_CONFLICT',
          message: `${affected.length} organisation(s) on this plan already exceed the new limits. Send force:true to apply anyway.`,
          affected_orgs: affected,
        });
      }
    }

    const payload = {};
    if (name            !== undefined) payload.name            = name.trim();
    if (features        !== undefined) payload.features        = features ? JSON.stringify(features) : null;
    if (booking_limit   !== undefined) payload.booking_limit   = newBookingLimit;
    if (hp_limit        !== undefined) payload.hp_limit        = newHpLimit;
    if (price_per_month !== undefined) payload.price_per_month = parseFloat(price_per_month) || 0;

    await db('edx_plans').where({ id }).update(payload);

    logAudit({
      entityType: 'PLAN',
      entityId:   Number(id),
      action:     'UPDATE',
      changedBy:  req.login_data.id,
      oldValues:  {
        name: plan.name,
        booking_limit: plan.booking_limit,
        hp_limit: plan.hp_limit,
        price_per_month: plan.price_per_month,
      },
      newValues:  payload,
    });

    const updated = await db('edx_plans').where({ id }).first();
    res.json({ message: 'Plan updated successfully.', data: updated });
  } catch (err) {
    logger.error(`[subscriptionController] updatePlan error: ${err.message}`);
    res.status(500).json({ message: 'Failed to update plan.' });
  }
};

// ── 7. Toggle plan active (retire / restore) ─────────────────────────────────

const togglePlanActive = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { id } = req.params;
    const plan = await db('edx_plans').where({ id }).first();
    if (!plan) return res.status(404).json({ message: 'Plan not found.' });

    const newValue = !plan.is_active;
    await db('edx_plans').where({ id }).update({ is_active: newValue });

    logAudit({
      entityType: 'PLAN',
      entityId:   Number(id),
      action:     'STATUS_CHANGE',
      changedBy:  req.login_data.id,
      oldValues:  { is_active: !!plan.is_active },
      newValues:  { is_active: newValue },
    });

    res.json({ message: `Plan ${newValue ? 'restored' : 'retired'} successfully.`, is_active: newValue });
  } catch (err) {
    logger.error(`[subscriptionController] togglePlanActive error: ${err.message}`);
    res.status(500).json({ message: 'Failed to toggle plan.' });
  }
};

module.exports = {
  getPlans,
  getSubscriptionStatus,
  updateOrgPlan,
  getPlansWithUsage,
  createPlan,
  updatePlan,
  togglePlanActive,
};
