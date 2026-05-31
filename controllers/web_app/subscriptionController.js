/**
 * subscriptionController.js — Phase 5.2
 *
 * GET  /api/getPlans              — public; returns all plan tiers
 * GET  /api/getSubscriptionStatus — authenticated; returns org's current plan
 * PUT  /api/updateOrgPlan         — superadmin (role_id = 1) only
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');

// ── 1. Get all plans (public) ─────────────────────────────────────────────────

const getPlans = async (req, res) => {
  try {
    const plans = await db('edx_plans').select(
      'id', 'name', 'features', 'booking_limit', 'hp_limit', 'price_per_month'
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
    const roleId = req.login_data?.role_id;
    if (roleId !== 1 && roleId !== '1') {
      return res.status(403).json({ message: 'Superadmin access required.' });
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

module.exports = { getPlans, getSubscriptionStatus, updateOrgPlan };
