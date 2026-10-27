/**
 * weeklyReport.js — Phase 4.3 (per-org schedules)
 *
 * Runs at the top of every hour and, for each org whose edx_report_schedules
 * row is enabled for the current weekday + hour, emails that org's last-7-days
 * revenue + bookings summary (CSV attachments).
 *
 * Recipients: the schedule's explicit e-mail list, else the org's active staff
 * whose role grants the Settings module (the org admins). Every query is scoped
 * to the schedule's org — no org ever receives another org's data.
 * last_sent_on stops a second send on the same day (restart / overlap).
 *
 * Called from index.js:
 *   const { startWeeklyReportCron } = require('./cron/weeklyReport');
 *   startWeeklyReportCron();
 */

const cron    = require('node-cron');
const db      = require('../config/db');
const logger  = require('../logger');
const { sendEmail } = require('../utils/emailService');
const { getCurrentDateTime } = require('../utils/dateTime');
const {
  parseRecipients, queryBookings, queryRevenue, toCsv,
} = require('../controllers/web_app/reportsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Cron runs with no user: the report covers every branch of the org.
const ORG_WIDE_USER = { branch_access: 'all' };

/** Active staff of the org whose role includes the Settings module. */
async function orgAdminEmails(orgId) {
  const settingsModules = await db('edx_web_module')
    .whereRaw('LOWER(module_name) = ?', ['settings'])
    .select('id');
  const settingsIds = new Set(settingsModules.map((m) => String(m.id)));

  const users = await db('edx_web_app_users as u')
    .join('edx_web_emp_roles as r', 'r.id', 'u.user_role')
    .where('u.org_id', orgId)
    .where('r.org_id', orgId)
    .where('u.user_status', 1)
    .whereNotNull('u.user_email')
    .whereNot('u.user_email', 'NA')
    .select('u.user_email', 'r.access_list', 'r.role_name');

  return [...new Set(users
    .filter((u) => {
      const ids = String(u.access_list || '').match(/\d+/g) || [];
      return ids.some((id) => settingsIds.has(id)) || /super\s*admin/i.test(u.role_name || '');
    })
    .map((u) => u.user_email))];
}

async function sendOrgReport(schedule, now) {
  const orgId = schedule.org_id;
  const to    = isoDate(now);
  const from  = isoDate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));

  let recipients = parseRecipients(schedule.recipients);
  if (recipients.length === 0) recipients = await orgAdminEmails(orgId);
  if (recipients.length === 0) {
    logger.warn(`[weeklyReport] org ${orgId}: no recipients — skipping.`);
    return false;
  }

  const [revenue, bookings, org] = await Promise.all([
    queryRevenue(ORG_WIDE_USER, orgId, { from, to }),
    queryBookings(ORG_WIDE_USER, orgId, { from, to }),
    db('edx_organizations').where({ id: orgId }).first('name'),
  ]);

  const orgName = org?.name || 'Eldivex';
  const subject = `${orgName} — Weekly Report (${from} to ${to})`;
  const html = `
    <h2>${String(orgName).replace(/[<>&]/g, '')} Weekly Summary</h2>
    <p>Period: <strong>${from}</strong> to <strong>${to}</strong></p>
    <p>Attached: revenue summary (${revenue.length} rows) and bookings list (${bookings.length} rows) as CSV.</p>
    <p>—<br/>Eldivex Admin System</p>
  `;
  const attachments = [
    { filename: `revenue_${from}_${to}.csv`,  content: toCsv(revenue)  || 'No data' },
    { filename: `bookings_${from}_${to}.csv`, content: toCsv(bookings) || 'No data' },
  ];

  for (const email of recipients) {
    await sendEmail({ to: email, subject, html, fromName: orgName, attachments }).catch((e) =>
      logger.warn(`[weeklyReport] org ${orgId}: email failed for ${email}: ${e.message}`)
    );
  }
  logger.info(`[weeklyReport] org ${orgId}: sent to ${recipients.length} recipient(s).`);
  return true;
}

// ── Hourly job ────────────────────────────────────────────────────────────────

async function runWeeklyReport(now = new Date()) {
  const today = isoDate(now);
  let due;
  try {
    due = await db('edx_report_schedules')
      .where({ enabled: 1, day_of_week: now.getDay(), hour: now.getHours() })
      .where(function () {
        this.whereNull('last_sent_on').orWhereNot('last_sent_on', today);
      });
  } catch (err) {
    logger.error(`[weeklyReport] could not load schedules: ${err.message}`);
    return;
  }

  for (const schedule of due) {
    try {
      const sent = await sendOrgReport(schedule, now);
      if (sent) {
        await db('edx_report_schedules')
          .where({ id: schedule.id })
          .update({ last_sent_on: today, updated_on: getCurrentDateTime() });
      }
    } catch (err) {
      logger.error(`[weeklyReport] org ${schedule.org_id} failed: ${err.message}`);
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function startWeeklyReportCron() {
  // Hourly; each org's own day/hour decides whether it is sent this run.
  const cronExpr = '0 * * * *';

  if (!cron.validate(cronExpr)) {
    logger.error(`[weeklyReport] invalid cron expression: ${cronExpr}`);
    return;
  }

  cron.schedule(cronExpr, () => {
    runWeeklyReport().catch((e) =>
      logger.error(`[weeklyReport] unhandled error in cron job: ${e.message}`)
    );
  });

  logger.info(`[weeklyReport] cron scheduled: ${cronExpr}`);
}

module.exports = { startWeeklyReportCron, runWeeklyReport };
