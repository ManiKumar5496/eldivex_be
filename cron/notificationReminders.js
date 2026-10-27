/**
 * notificationReminders.js — Daily in-app reminder cron
 *
 * Runs every day at 07:45 AM (before paymentReminders/saasBilling so the
 * morning feed is complete when admins log in). Produces org-admin
 * notifications for date-driven events:
 *
 *   1. Extension due — bookings whose service_end_date is today / tomorrow /
 *      day-after (the same CURDATE()+0/1/2 windows the bookings list uses for
 *      extension_status), excluding cancelled bookings (status '3' / '6').
 *   2. Subscription expiry — each org's latest trial/active subscription at
 *      7 / 3 / 1 / 0 days before expires_on.
 *   3. Follow-up due — bookings whose followup_date is today.
 *
 * Every insert carries a dedupe_key, so re-runs (or a manual trigger) are
 * idempotent — the unique index makes the second insert a no-op.
 */

const cron   = require('node-cron');
const db     = require('../config/db');
const logger = require('../logger');
const { notifyOrgAdmins } = require('../utils/notify');
const { CANCELLED_BOOKING_STATUSES } = require('../utils/bookingStatus');

const DAY_LABEL = { 0: 'today', 1: 'tomorrow', 2: 'in 2 days' };

async function extensionDueReminders() {
  const rows = await db('edx_bookings as b')
    .leftJoin('edx_patient as p', 'b.patient_id', 'p.id')
    .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
    .whereRaw("DATE(b.service_end_date) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 2 DAY)")
    .whereNotIn('b.status', CANCELLED_BOOKING_STATUSES)
    .select(
      'b.id', 'b.org_id', 'b.service_end_date',
      db.raw('DATEDIFF(DATE(b.service_end_date), CURDATE()) as days_left'),
      'p.patient_name', 'ms.name as service_name',
    );

  let created = 0;
  for (const b of rows) {
    const daysLeft = Number(b.days_left);
    const when     = DAY_LABEL[daysLeft] ?? `in ${daysLeft} days`;
    const endDate  = String(b.service_end_date).split('T')[0];
    const id = await notifyOrgAdmins(b.org_id, {
      type:  'extension_due',
      title: `Service ends ${when} — Booking #${b.id}`,
      body:  `${b.patient_name || 'Patient'}'s ${b.service_name || 'service'} ends on ${endDate}. Extend or close the booking.`,
      data:  { booking_id: b.id, days_left: daysLeft, route: 'bookings' },
      dedupeKey: `ext:${b.id}:${endDate}:${daysLeft}`,
    });
    if (id) created++;
  }
  return { candidates: rows.length, created };
}

async function subscriptionExpiryReminders() {
  const rows = await db('edx_subscriptions as s')
    .join(
      db('edx_subscriptions').select('org_id').max('id as sub_id').groupBy('org_id').as('latest'),
      'latest.sub_id', 's.id'
    )
    .join('edx_organizations as o', 's.org_id', 'o.id')
    .whereNot('o.status', 'cancelled')
    .whereIn('s.status', ['trial', 'active'])
    .whereNotNull('s.expires_on')
    .whereRaw('DATEDIFF(DATE(s.expires_on), CURDATE()) IN (7, 3, 1, 0)')
    .select(
      's.id as sub_id', 's.org_id', 's.status', 's.expires_on',
      db.raw('DATEDIFF(DATE(s.expires_on), CURDATE()) as days_left'),
    );

  let created = 0;
  for (const s of rows) {
    const daysLeft = Number(s.days_left);
    const label    = s.status === 'trial' ? 'Trial' : 'Subscription';
    const when     = daysLeft === 0 ? 'expires today' : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    const expDate  = String(s.expires_on).split('T')[0];
    const id = await notifyOrgAdmins(s.org_id, {
      type:  'subscription',
      title: `${label} ${when}`,
      body:  `Your ${label.toLowerCase()} ends on ${expDate}. Renew to avoid interruption of access.`,
      data:  { subscription_id: s.sub_id, days_left: daysLeft, route: 'subscription' },
      dedupeKey: `sub:${s.sub_id}:${expDate}:${daysLeft}`,
    });
    if (id) created++;
  }
  return { candidates: rows.length, created };
}

async function followupDueReminders() {
  const rows = await db('edx_bookings as b')
    .leftJoin('edx_patient as p', 'b.patient_id', 'p.id')
    .whereRaw('DATE(b.followup_date) = CURDATE()')
    .whereNotIn('b.status', CANCELLED_BOOKING_STATUSES)
    .select('b.id', 'b.org_id', 'b.followup_date', 'p.patient_name');

  let created = 0;
  for (const b of rows) {
    const fupDate = String(b.followup_date).split('T')[0];
    const id = await notifyOrgAdmins(b.org_id, {
      type:  'booking',
      title: `Follow-up due today — Booking #${b.id}`,
      body:  `Follow-up scheduled today for ${b.patient_name || 'patient'}.`,
      data:  { booking_id: b.id, route: 'bookings' },
      dedupeKey: `fup:${b.id}:${fupDate}`,
    });
    if (id) created++;
  }
  return { candidates: rows.length, created };
}

async function runNotificationReminders() {
  try {
    const ext = await extensionDueReminders();
    const sub = await subscriptionExpiryReminders();
    const fup = await followupDueReminders();
    logger.info(
      `[notificationReminders] extension: ${ext.created}/${ext.candidates}, ` +
      `subscription: ${sub.created}/${sub.candidates}, follow-up: ${fup.created}/${fup.candidates}`
    );
  } catch (err) {
    logger.error(`[notificationReminders] cron failed: ${err.message}`);
  }
}

// Schedule: every day at 07:45 AM
cron.schedule('45 7 * * *', () => {
  logger.info('[notificationReminders] Running daily reminder check...');
  runNotificationReminders();
});

// Export for manual triggering in tests
module.exports = { runNotificationReminders };
