/**
 * saasBilling.js — SaaS subscription billing automation
 *
 * Daily at 08:00 AM:
 *   1. Monthly invoice generation — on/after the 1st, every org whose latest
 *      subscription is 'active' gets an edx_saas_invoices row for the current
 *      period if one doesn't exist yet (the uq_saas_inv_period unique index is
 *      the hard guard, so re-runs are idempotent). Amount = plan price,
 *      due 15 days into the month, status 'Sent'.
 *   2. Auto-overdue — any 'Sent' invoice past its due_date flips to 'Overdue'.
 *
 * Both actions are audit-logged with changedBy: null (system).
 */

const cron   = require('node-cron');
const db     = require('../config/db');
const logger = require('../logger');
const { logAudit } = require('../utils/auditLogger');
const { getCurrentDateTime } = require('../utils/dateTime');
const { notifyOrgAdmins } = require('../utils/notify');

const DUE_DAY_OF_MONTH = 15;

async function generateMonthlyInvoices() {
  const now = new Date();
  const periodMonth = now.getMonth() + 1;
  const periodYear  = now.getFullYear();

  // Orgs whose LATEST subscription is active, with their plan price
  const billable = await db('edx_subscriptions as s')
    .join(
      db('edx_subscriptions')
        .select('org_id')
        .max('id as sub_id')
        .groupBy('org_id')
        .as('latest_sub_ref'),
      'latest_sub_ref.sub_id', 's.id'
    )
    .join('edx_plans as p', 's.plan_id', 'p.id')
    // Only bill orgs that still exist and aren't cancelled (guards against
    // orphan subscription rows).
    .join('edx_organizations as o', 's.org_id', 'o.id')
    .whereNot('o.status', 'cancelled')
    .where('s.status', 'active')
    .select('s.org_id', 's.plan_id', 'p.price_per_month');

  let created = 0;
  for (const sub of billable) {
    if (!parseFloat(sub.price_per_month)) continue; // free plans aren't invoiced

    const existing = await db('edx_saas_invoices')
      .where({ org_id: sub.org_id, period_month: periodMonth, period_year: periodYear })
      .first();
    if (existing) continue;

    const dueDate = new Date(periodYear, periodMonth - 1, DUE_DAY_OF_MONTH)
      .toISOString()
      .split('T')[0];

    try {
      const [id] = await db('edx_saas_invoices').insert({
        org_id:       sub.org_id,
        plan_id:      sub.plan_id,
        period_month: periodMonth,
        period_year:  periodYear,
        amount:       sub.price_per_month,
        status:       'Sent',
        due_date:     dueDate,
        created_by:   null,
        created_on:   getCurrentDateTime(),
      });
      created++;

      logAudit({
        entityType: 'SAAS_INVOICE',
        entityId:   id,
        action:     'CREATE',
        changedBy:  null,
        org_id:     sub.org_id,
        newValues:  {
          org_id: sub.org_id,
          period_month: periodMonth,
          period_year: periodYear,
          amount: sub.price_per_month,
          source: 'auto-billing-cron',
        },
      });

      await notifyOrgAdmins(sub.org_id, {
        type:  'subscription',
        title: `Subscription invoice generated — ₹${Number(sub.price_per_month).toLocaleString('en-IN')}`,
        body:  `Your monthly subscription invoice for ${periodMonth}/${periodYear} is ready (due ${dueDate}).`,
        data:  { saas_invoice_id: id, route: 'subscription' },
        dedupeKey: `saasinv:${sub.org_id}:${periodYear}-${periodMonth}`,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') continue; // raced with a manual invoice — fine
      logger.error(`[saasBilling] invoice insert failed for org ${sub.org_id}: ${err.message}`);
    }
  }

  return { billable: billable.length, created };
}

async function markOverdueInvoices() {
  const overdue = await db('edx_saas_invoices')
    .where('status', 'Sent')
    .whereNotNull('due_date')
    .whereRaw('due_date < CURDATE()')
    .select('id', 'org_id');

  if (overdue.length === 0) return 0;

  await db('edx_saas_invoices')
    .whereIn('id', overdue.map((i) => i.id))
    .update({ status: 'Overdue' });

  for (const inv of overdue) {
    logAudit({
      entityType: 'SAAS_INVOICE',
      entityId:   inv.id,
      action:     'STATUS_CHANGE',
      changedBy:  null,
      org_id:     inv.org_id,
      oldValues:  { status: 'Sent' },
      newValues:  { status: 'Overdue', source: 'auto-billing-cron' },
    });

    await notifyOrgAdmins(inv.org_id, {
      type:  'subscription',
      title: `Subscription invoice overdue — #${inv.id}`,
      body:  'Your subscription payment is overdue. Please pay to avoid suspension of access.',
      data:  { saas_invoice_id: inv.id, route: 'subscription' },
      dedupeKey: `saasoverdue:${inv.id}`,
    });
  }

  return overdue.length;
}

async function runSaasBilling() {
  try {
    const { billable, created } = await generateMonthlyInvoices();
    const overdue = await markOverdueInvoices();
    logger.info(`[saasBilling] billable orgs: ${billable}, invoices created: ${created}, marked overdue: ${overdue}`);
  } catch (err) {
    logger.error(`[saasBilling] cron failed: ${err.message}`);
  }
}

// Schedule: every day at 08:00 AM
cron.schedule('0 8 * * *', () => {
  logger.info('[saasBilling] Running daily SaaS billing check...');
  runSaasBilling();
});

// Export for manual triggering in tests
module.exports = { runSaasBilling, generateMonthlyInvoices, markOverdueInvoices };
