/**
 * planGate.js — Phase 5.2
 *
 * Usage:  router.get('/generateReport', auth, planGate(['Growth', 'Enterprise']), handler)
 *
 * Reads the org's active subscription plan from DB and rejects with 403 if the
 * plan is not in the allowed list.  Caches the result on req.orgPlan so
 * chained middleware or the controller can read it without a second query.
 */

const db     = require('../config/db');
const logger = require('../logger');
const { getOrgId } = require('../utils/orgScope');

module.exports = function planGate(allowedPlans) {
  return async (req, res, next) => {
    try {
      const orgId = getOrgId(req);
      if (!orgId) return res.status(401).json({ error: 'Invalid token for this endpoint' });

      const sub = await db('edx_subscriptions as s')
        .join('edx_plans as p', 's.plan_id', 'p.id')
        .where({ 's.org_id': orgId, 's.status': 'active' })
        .select('p.name as plan_name')
        .first();

      if (!sub || !allowedPlans.includes(sub.plan_name)) {
        return res.status(403).json({
          message: `This feature requires the ${allowedPlans[0]} plan or above.`,
          current_plan: sub?.plan_name || 'None',
        });
      }

      req.orgPlan = sub.plan_name;
      next();
    } catch (err) {
      logger.error(`[planGate] error: ${err.message}`);
      res.status(500).json({ message: 'Failed to verify subscription plan.' });
    }
  };
};
