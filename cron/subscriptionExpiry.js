/**
 * subscriptionExpiry.js — daily subscription expiry (00:30 server time).
 *
 * Finds each org's LATEST subscription that is still 'active' / 'trial' but
 * whose expires_on is before today, and:
 *   1. sets that subscription to 'expired';
 *   2. syncs edx_organizations.status via orgStatusForSubscription
 *      ('expired' → 'suspended', so logins are blocked);
 *   3. invalidates the orgStatusGate cache so the block is immediate;
 *   4. writes an audit row (org = the expired org) and notifies its admins.
 *
 * Safety switch: unless ENABLE_SUBSCRIPTION_EXPIRY === 'true' the job only
 * logs what it WOULD change (dry run). Subscriptions with no expires_on never
 * expire.
 *
 * Registered from index.js:
 *   const { startSubscriptionExpiryCron } = require('./cron/subscriptionExpiry');
 *   startSubscriptionExpiryCron();
 */

const cron   = require('node-cron');
const db     = require('../config/db');
const logger = require('../logger');
const withTransaction = require('../utils/withTransaction');
const { getCurrentDateTime } = require('../utils/dateTime');
const { orgStatusForSubscription } = require('../utils/orgStatus');
const { invalidateOrgStatusCache } = require('../middlewares/orgStatusGate');
const { logAudit } = require('../utils/auditLogger');
const { notifyOrgAdmins } = require('../utils/notify');

function todayStr(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Latest subscription per org that is live but past its expiry date. */
async function findExpiredSubscriptions(today) {
  return db('edx_subscriptions as s')
    .join(
      db('edx_subscriptions').select('org_id').max('id as sub_id').groupBy('org_id').as('latest'),
      'latest.sub_id', 's.id'
    )
    .join('edx_organizations as o', 'o.id', 's.org_id')
    .whereIn('s.status', ['active', 'trial'])
    .whereNotNull('s.expires_on')
    .where('s.expires_on', '<', today)
    .select('s.id as sub_id', 's.org_id', 's.status', 's.expires_on', 'o.name as org_name', 'o.status as org_status');
}

async function runSubscriptionExpiry(now = new Date()) {
  const today   = todayStr(now);
  const enabled = process.env.ENABLE_SUBSCRIPTION_EXPIRY === 'true';
  const newOrgStatus = orgStatusForSubscription('expired');

  let rows;
  try {
    rows = await findExpiredSubscriptions(today);
  } catch (err) {
    logger.error(`[subscriptionExpiry] query failed: ${err.message}`);
    return { expired: 0, candidates: 0 };
  }

  if (!enabled) {
    for (const r of rows) {
      const exp = String(r.expires_on instanceof Date ? todayStr(r.expires_on) : r.expires_on).slice(0, 10);
      logger.info(`[subscriptionExpiry] DRY RUN — would expire subscription #${r.sub_id} (org ${r.org_id} "${r.org_name}", ${r.status}, expired ${exp}) and set org status '${r.org_status}' → '${newOrgStatus}'.`);
    }
    logger.info(`[subscriptionExpiry] DRY RUN — ${rows.length} subscription(s) past expiry. Set ENABLE_SUBSCRIPTION_EXPIRY=true to apply.`);
    return { expired: 0, candidates: rows.length };
  }

  let expired = 0;
  for (const r of rows) {
    try {
      const changed = await withTransaction(async (trx) => {
        // Conditional on the status we read, so a concurrent owner action wins.
        const n = await trx('edx_subscriptions')
          .where({ id: r.sub_id })
          .whereIn('status', ['active', 'trial'])
          .update({ status: 'expired', updated_on: getCurrentDateTime() });
        if (!n) return false;
        await trx('edx_organizations').where({ id: r.org_id }).update({ status: newOrgStatus });
        return true;
      });
      if (!changed) continue;

      invalidateOrgStatusCache(r.org_id);
      expired++;

      logAudit({
        entityType: 'ORGANISATION',
        entityId:   r.org_id,
        action:     'STATUS_CHANGE',
        changedBy:  null,
        org_id:     r.org_id,
        oldValues:  { sub_status: r.status, org_status: r.org_status },
        newValues:  { sub_status: 'expired', org_status: newOrgStatus, reason: 'Subscription expired (automatic)' },
      });
      notifyOrgAdmins(r.org_id, {
        type:      'subscription',
        title:     'Subscription expired',
        body:      'Your subscription has expired and access is suspended. Please renew to restore access.',
        data:      { subscription_id: r.sub_id },
        dedupeKey: `subexp:${r.sub_id}`,
      });
      logger.info(`[subscriptionExpiry] expired subscription #${r.sub_id} — org ${r.org_id} → '${newOrgStatus}'.`);
    } catch (err) {
      logger.error(`[subscriptionExpiry] org ${r.org_id} failed: ${err.message}`);
    }
  }

  logger.info(`[subscriptionExpiry] ${today} — expired ${expired} of ${rows.length} candidate(s).`);
  return { expired, candidates: rows.length };
}

function startSubscriptionExpiryCron() {
  const cronExpr = '30 0 * * *'; // daily 00:30
  cron.schedule(cronExpr, () => {
    runSubscriptionExpiry().catch((e) =>
      logger.error(`[subscriptionExpiry] unhandled error: ${e.message}`)
    );
  });
  logger.info(`[subscriptionExpiry] cron scheduled: ${cronExpr} (${process.env.ENABLE_SUBSCRIPTION_EXPIRY === 'true' ? 'enforcing' : 'dry run'})`);
}

module.exports = { startSubscriptionExpiryCron, runSubscriptionExpiry };
