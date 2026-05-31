/**
 * saasAccountsController.js — SaaS Accounts Module
 *
 * All routes require superadmin (role_id = 1).
 *
 * GET  /api/saas/checkSlugAvailable           — real-time slug uniqueness
 * GET  /api/saas/checkEmailAvailable          — real-time email uniqueness
 * GET  /api/saas/getOrgUsage                 — usage vs plan limits
 * GET  /api/saas/getSubscriptionHistory       — full sub history for an org
 * PATCH /api/saas/transitionSubscriptionStatus — state-machine enforced status change
 * POST /api/saas/checkDowngradeViability      — pre-flight downgrade check
 * POST /api/saas/generateSaasInvoice          — create subscription invoice
 * GET  /api/saas/getSaasInvoices              — list SaaS invoices
 * PATCH /api/saas/markSaasInvoicePaid         — record payment
 * GET  /api/saas/getAccountHealthSummary      — usage alerts across all orgs
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { logAudit }           = require('../../utils/auditLogger');

// ── Allowed subscription status transitions ───────────────────────────────────
const ALLOWED_TRANSITIONS = {
  trial:     ['active', 'cancelled'],
  active:    ['suspended', 'cancelled', 'expired'],
  suspended: ['active', 'cancelled'],
  expired:   ['active', 'cancelled'],
  cancelled: [],
};

function requireSuperadmin(req, res) {
  const roleId = req.login_data?.role_id;
  if (roleId !== 1 && roleId !== '1') {
    res.status(403).json({ message: 'Superadmin access required.' });
    return false;
  }
  return true;
}

// ── 1. Check slug availability ────────────────────────────────────────────────

const checkSlugAvailable = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { slug } = req.query;
    if (!slug || slug.trim().length < 3) {
      return res.json({ available: false, message: 'Slug too short.' });
    }
    const existing = await db('edx_organizations')
      .whereRaw('LOWER(slug) = ?', [slug.trim().toLowerCase()])
      .first();
    res.json({ available: !existing });
  } catch (err) {
    logger.error(`[saasAccounts] checkSlugAvailable error: ${err.message}`);
    res.status(500).json({ message: 'Check failed.' });
  }
};

// ── 2. Check email availability ───────────────────────────────────────────────

const checkEmailAvailable = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { email } = req.query;
    if (!email) return res.json({ available: true });

    const existingOrg = await db('edx_organizations')
      .whereRaw('LOWER(email) = ?', [email.trim().toLowerCase()])
      .first();

    const existingUser = await db('edx_web_app_users')
      .whereRaw('LOWER(user_email) = ?', [email.trim().toLowerCase()])
      .first();

    res.json({ available: !existingOrg && !existingUser });
  } catch (err) {
    logger.error(`[saasAccounts] checkEmailAvailable error: ${err.message}`);
    res.status(500).json({ message: 'Check failed.' });
  }
};

// ── 3. Get org usage vs plan limits ──────────────────────────────────────────

const getOrgUsage = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { org_id } = req.query;
    if (!org_id) return res.status(400).json({ message: 'org_id required.' });

    const sub = await db('edx_subscriptions as s')
      .join('edx_plans as p', 's.plan_id', 'p.id')
      .where('s.org_id', org_id)
      .orderBy('s.id', 'desc')
      .select('p.booking_limit', 'p.hp_limit', 'p.name as plan_name', 's.status', 's.expires_on')
      .first();

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

    const bookingLimit = sub?.booking_limit || 0;
    const hpLimit      = sub?.hp_limit      || 0;

    res.json({
      plan_name:        sub?.plan_name  || 'Unknown',
      sub_status:       sub?.status     || 'none',
      expires_on:       sub?.expires_on || null,
      bookings_used:    bookingsUsed,
      bookings_limit:   bookingLimit,
      hp_used:          hpUsed,
      hp_limit:         hpLimit,
      usage_pct_bookings: bookingLimit > 0 ? Math.round((bookingsUsed / bookingLimit) * 100) : 0,
      usage_pct_hp:       hpLimit > 0      ? Math.round((hpUsed      / hpLimit)      * 100) : 0,
    });
  } catch (err) {
    logger.error(`[saasAccounts] getOrgUsage error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch usage.' });
  }
};

// ── 4. Get subscription history for an org ───────────────────────────────────

const getSubscriptionHistory = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { org_id } = req.query;
    if (!org_id) return res.status(400).json({ message: 'org_id required.' });

    const history = await db('edx_subscriptions as s')
      .leftJoin('edx_plans as p', 's.plan_id', 'p.id')
      .leftJoin('edx_web_app_users as u', 's.activated_by', 'u.id')
      .where('s.org_id', org_id)
      .select(
        's.id',
        's.status',
        's.started_on',
        's.expires_on',
        's.created_on',
        'p.id as plan_id',
        'p.name as plan_name',
        'p.price_per_month',
        'u.user_name as activated_by_name',
      )
      .orderBy('s.id', 'desc');

    res.json(history);
  } catch (err) {
    logger.error(`[saasAccounts] getSubscriptionHistory error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch subscription history.' });
  }
};

// ── 5. Transition subscription status (state-machine enforced) ───────────────

const transitionSubscriptionStatus = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { org_id, new_status, reason } = req.body;
    if (!org_id || !new_status) {
      return res.status(400).json({ message: 'org_id and new_status are required.' });
    }
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({ message: 'A reason of at least 10 characters is required.' });
    }

    const currentSub = await db('edx_subscriptions')
      .where('org_id', org_id)
      .orderBy('id', 'desc')
      .first();

    if (!currentSub) {
      return res.status(404).json({ message: 'No subscription found for this org.' });
    }

    const allowed = ALLOWED_TRANSITIONS[currentSub.status] || [];
    if (!allowed.includes(new_status)) {
      return res.status(422).json({
        message: `Cannot transition from '${currentSub.status}' to '${new_status}'.`,
        code: 'INVALID_TRANSITION',
        current_status: currentSub.status,
        allowed_next: allowed,
      });
    }

    const oldStatus = currentSub.status;

    await db('edx_subscriptions')
      .where('id', currentSub.id)
      .update({
        status:     new_status,
        updated_on: getCurrentDateTime(),
      });

    // If reactivating, also update org status
    if (new_status === 'active') {
      await db('edx_organizations').where('id', org_id).update({ status: 'active' });
    }
    if (new_status === 'suspended') {
      await db('edx_organizations').where('id', org_id).update({ status: 'suspended' });
    }
    if (new_status === 'cancelled') {
      await db('edx_organizations').where('id', org_id).update({ status: 'cancelled' });
    }

    setImmediate(() => {
      logAudit({
        entityType:  'ORGANISATION',
        entityId:    org_id,
        action:      'STATUS_CHANGE',
        changedBy:   req.login_data.id,
        oldValues:   { status: oldStatus },
        newValues:   { status: new_status, reason },
      });
    });

    res.json({ message: `Subscription status changed to '${new_status}'.` });
  } catch (err) {
    logger.error(`[saasAccounts] transitionSubscriptionStatus error: ${err.message}`);
    res.status(500).json({ message: 'Failed to transition status.' });
  }
};

// ── 6. Check downgrade viability ─────────────────────────────────────────────

const checkDowngradeViability = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { org_id, target_plan_id } = req.body;
    if (!org_id || !target_plan_id) {
      return res.status(400).json({ message: 'org_id and target_plan_id are required.' });
    }

    const targetPlan = await db('edx_plans').where('id', target_plan_id).first();
    if (!targetPlan) {
      return res.status(404).json({ message: 'Plan not found.' });
    }

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

    // 0 means unlimited
    const bookingBlocked = bookingLimit > 0 && bookingsUsed > bookingLimit;
    const hpBlocked      = hpLimit      > 0 && hpUsed      > hpLimit;

    if (bookingBlocked || hpBlocked) {
      const reasons = [];
      if (bookingBlocked) reasons.push(`${bookingsUsed} active bookings exceed the ${targetPlan.name} limit of ${bookingLimit}`);
      if (hpBlocked)      reasons.push(`${hpUsed} active HPs exceed the ${targetPlan.name} limit of ${hpLimit}`);

      return res.json({
        viable:           false,
        reason:           reasons.join('. '),
        current_bookings: bookingsUsed,
        current_hp:       hpUsed,
        new_limit_bookings: bookingLimit,
        new_limit_hp:       hpLimit,
      });
    }

    res.json({
      viable:             true,
      current_bookings:   bookingsUsed,
      current_hp:         hpUsed,
      new_limit_bookings: bookingLimit,
      new_limit_hp:       hpLimit,
    });
  } catch (err) {
    logger.error(`[saasAccounts] checkDowngradeViability error: ${err.message}`);
    res.status(500).json({ message: 'Viability check failed.' });
  }
};

// ── 7. Generate SaaS invoice ──────────────────────────────────────────────────

const generateSaasInvoice = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { org_id, period_month, period_year, amount, due_date } = req.body;
    if (!org_id || !period_month || !period_year) {
      return res.status(400).json({ message: 'org_id, period_month, period_year are required.' });
    }

    // Validate org exists and is not cancelled
    const org = await db('edx_organizations').where('id', org_id).first();
    if (!org) return res.status(404).json({ message: 'Organisation not found.' });

    // Check org subscription
    const sub = await db('edx_subscriptions')
      .join('edx_plans as p', 'edx_subscriptions.plan_id', 'p.id')
      .where('edx_subscriptions.org_id', org_id)
      .whereIn('edx_subscriptions.status', ['active', 'suspended', 'expired'])
      .orderBy('edx_subscriptions.id', 'desc')
      .select('edx_subscriptions.plan_id', 'p.price_per_month')
      .first();

    if (!sub) {
      return res.status(422).json({ message: 'Cannot invoice a cancelled or trial-only organisation.' });
    }

    // Duplicate period check
    const existing = await db('edx_saas_invoices')
      .where({ org_id, period_month, period_year })
      .first();

    if (existing) {
      return res.status(409).json({
        message: `Invoice already exists for this period.`,
        existing_id: existing.id,
        code: 'DUPLICATE_PERIOD',
      });
    }

    const invoiceAmount = amount || sub.price_per_month || 0;

    const [id] = await db('edx_saas_invoices').insert({
      org_id,
      plan_id:      sub.plan_id,
      period_month,
      period_year,
      amount:       invoiceAmount,
      status:       'Draft',
      due_date:     due_date || null,
      created_by:   req.login_data.id,
      created_on:   getCurrentDateTime(),
    });

    setImmediate(() => {
      logAudit({
        entityType: 'SAAS_INVOICE',
        entityId:   id,
        action:     'CREATE',
        changedBy:  req.login_data.id,
        newValues:  { org_id, period_month, period_year, amount: invoiceAmount },
      });
    });

    const invoice = await db('edx_saas_invoices').where('id', id).first();
    res.status(201).json({ message: 'Invoice generated.', data: invoice });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Invoice already exists for this period.', code: 'DUPLICATE_PERIOD' });
    }
    logger.error(`[saasAccounts] generateSaasInvoice error: ${err.message}`);
    res.status(500).json({ message: 'Failed to generate invoice.' });
  }
};

// ── 8. Get SaaS invoices ──────────────────────────────────────────────────────

const getSaasInvoices = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { org_id } = req.query;

    const query = db('edx_saas_invoices as i')
      .leftJoin('edx_organizations as o', 'i.org_id', 'o.id')
      .leftJoin('edx_plans as p', 'i.plan_id', 'p.id')
      .select(
        'i.id',
        'i.org_id',
        'o.name as org_name',
        'p.name as plan_name',
        'i.period_month',
        'i.period_year',
        'i.amount',
        'i.status',
        'i.due_date',
        'i.paid_at',
        'i.transaction_ref',
        'i.created_on',
      )
      .orderBy('i.id', 'desc');

    if (org_id) query.where('i.org_id', org_id);

    const invoices = await query;
    res.json(invoices);
  } catch (err) {
    logger.error(`[saasAccounts] getSaasInvoices error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch invoices.' });
  }
};

// ── 9. Mark SaaS invoice paid ─────────────────────────────────────────────────

const markSaasInvoicePaid = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { invoice_id, payment_date, transaction_ref } = req.body;
    if (!invoice_id) return res.status(400).json({ message: 'invoice_id required.' });

    const invoice = await db('edx_saas_invoices').where('id', invoice_id).first();
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (invoice.status === 'Paid') {
      return res.status(422).json({ message: 'Invoice is already marked as paid.' });
    }

    await db('edx_saas_invoices').where('id', invoice_id).update({
      status:          'Paid',
      paid_at:         payment_date || getCurrentDateTime(),
      transaction_ref: transaction_ref || null,
    });

    setImmediate(() => {
      logAudit({
        entityType: 'SAAS_INVOICE',
        entityId:   invoice_id,
        action:     'STATUS_CHANGE',
        changedBy:  req.login_data.id,
        oldValues:  { status: invoice.status },
        newValues:  { status: 'Paid', transaction_ref },
      });
    });

    res.json({ message: 'Invoice marked as paid.' });
  } catch (err) {
    logger.error(`[saasAccounts] markSaasInvoicePaid error: ${err.message}`);
    res.status(500).json({ message: 'Failed to update invoice.' });
  }
};

// ── 10. Get account health summary ────────────────────────────────────────────

const getAccountHealthSummary = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const orgs = await db('edx_organizations as o')
      .leftJoin(
        db('edx_subscriptions')
          .select('org_id')
          .max('id as sub_id')
          .groupBy('org_id')
          .as('latest_sub_ref'),
        'latest_sub_ref.org_id', 'o.id'
      )
      .leftJoin('edx_subscriptions as s', 's.id', 'latest_sub_ref.sub_id')
      .leftJoin('edx_plans as p', 's.plan_id', 'p.id')
      .select(
        'o.id',
        'o.name',
        'o.slug',
        'o.status',
        'p.name as plan_name',
        'p.booking_limit',
        'p.hp_limit',
        's.status as sub_status',
        's.expires_on',
      );

    // Fetch booking counts per org
    const bookingCounts = await db('edx_bookings')
      .whereNotIn('status', ['Cancelled'])
      .groupBy('org_id')
      .select('org_id', db.raw('COUNT(id) as cnt'));

    const bookingMap = {};
    for (const row of bookingCounts) {
      bookingMap[row.org_id] = parseInt(row.cnt || 0);
    }

    const now = new Date();

    const result = orgs.map((org) => {
      const bookingsUsed   = bookingMap[org.id] || 0;
      const bookingLimit   = org.booking_limit   || 0;
      const hpLimit        = org.hp_limit        || 0;
      const bookingPct     = bookingLimit > 0 ? Math.round((bookingsUsed / bookingLimit) * 100) : 0;

      let daysToExpiry = null;
      if (org.expires_on) {
        const expiry  = new Date(org.expires_on);
        daysToExpiry  = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      }

      const alerts = [];
      if (bookingPct >= 80) alerts.push(`Booking usage at ${bookingPct}%`);
      if (daysToExpiry !== null && daysToExpiry <= 30 && daysToExpiry >= 0) alerts.push(`Expires in ${daysToExpiry} days`);
      if (daysToExpiry !== null && daysToExpiry < 0)  alerts.push('Subscription expired');
      if (org.sub_status === 'suspended') alerts.push('Account suspended');

      const healthScore = 100 - (alerts.length * 25);

      return {
        org_id:        org.id,
        org_name:      org.name,
        plan_name:     org.plan_name   || 'None',
        sub_status:    org.sub_status  || 'none',
        org_status:    org.status,
        bookings_used: bookingsUsed,
        booking_limit: bookingLimit,
        booking_pct:   bookingPct,
        hp_limit:      hpLimit,
        days_to_expiry: daysToExpiry,
        alerts,
        health_score:  Math.max(0, healthScore),
      };
    });

    result.sort((a, b) => a.health_score - b.health_score);

    res.json(result);
  } catch (err) {
    logger.error(`[saasAccounts] getAccountHealthSummary error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch health summary.' });
  }
};

module.exports = {
  checkSlugAvailable,
  checkEmailAvailable,
  getOrgUsage,
  getSubscriptionHistory,
  transitionSubscriptionStatus,
  checkDowngradeViability,
  generateSaasInvoice,
  getSaasInvoices,
  markSaasInvoicePaid,
  getAccountHealthSummary,
};
