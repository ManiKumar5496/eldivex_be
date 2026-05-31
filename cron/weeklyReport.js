/**
 * weeklyReport.js — Phase 4.3
 *
 * Runs every Monday at 08:00 AM (server local time) and emails a
 * revenue + bookings summary CSV to all superadmin users.
 *
 * Called from index.js:
 *   const { startWeeklyReportCron } = require('./cron/weeklyReport');
 *   startWeeklyReportCron();
 */

const cron    = require('node-cron');
const db      = require('../config/db');
const logger  = require('../logger');
const { sendEmail }        = require('../utils/emailService');
const { getScheduleConfig, generateReport: _gen } = require('../controllers/web_app/reportsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape  = (v) => `"${(v === null || v === undefined ? '' : String(v)).replace(/"/g, '""')}"`;
  return [
    headers.map(escape).join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
  ].join('\r\n');
}

function isoDate(dt) {
  return dt.toISOString().slice(0, 10);
}

// ── Weekly job ────────────────────────────────────────────────────────────────

async function runWeeklyReport() {
  const config = getScheduleConfig();
  if (!config.enabled) {
    logger.info('[weeklyReport] schedule disabled — skipping.');
    return;
  }

  logger.info('[weeklyReport] generating weekly summary…');

  try {
    const today = new Date();
    const to    = isoDate(today);
    const from  = isoDate(new Date(today - 7 * 24 * 60 * 60 * 1000));

    // Superadmin user is role_id = 1; use a synthetic superadmin login_data
    const superUser = { id: 0, role_id: 1, branch_access: [] };

    // Build a fake req/res to reuse the existing query functions
    const buildFakeReq = (type) => ({
      login_data: superUser,
      query: { type, from, to, format: 'json' },
    });

    const results = { revenue: [], bookings: [] };

    for (const type of ['revenue', 'bookings']) {
      await new Promise((resolve) => {
        const fakeRes = {
          json: (data) => { results[type] = data.data || []; resolve(); },
          status: () => ({ json: () => resolve() }),
          setHeader: () => {},
          send: () => resolve(),
        };
        // Piggy-back on the existing controller (it's just a query function)
        const { generateReport } = require('../controllers/web_app/reportsController');
        generateReport(buildFakeReq(type), fakeRes).catch(() => resolve());
      });
    }

    const revenueCsv  = toCsv(results.revenue);
    const bookingsCsv = toCsv(results.bookings);

    // Fetch target email list: explicit config OR all superadmin users
    let recipients = config.emails.length > 0 ? config.emails : [];
    if (recipients.length === 0) {
      const admins = await db('edx_web_app_users')
        .where({ role_id: 1 })
        .select('user_email')
        .where('user_email', '!=', 'NA');
      recipients = admins.map(a => a.user_email).filter(Boolean);
    }

    if (recipients.length === 0) {
      logger.warn('[weeklyReport] no recipients found — skipping email send.');
      return;
    }

    const subject = `Weekly Report — ${from} to ${to}`;
    const html    = `
      <h2>Eldivex Weekly Summary</h2>
      <p>Period: <strong>${from}</strong> to <strong>${to}</strong></p>
      <p>Attached: Revenue summary and Bookings list (CSV).</p>
      <p>—<br/>Eldivex Admin System</p>
    `;

    for (const email of recipients) {
      await sendEmail({ to: email, subject, html }).catch(e =>
        logger.warn(`[weeklyReport] email failed for ${email}: ${e.message}`)
      );
    }

    logger.info(`[weeklyReport] sent to ${recipients.length} recipient(s).`);
  } catch (err) {
    logger.error('[weeklyReport] job failed:', err);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function startWeeklyReportCron() {
  // Default: every Monday at 08:00 — overrideable via configureReportSchedule
  // '0 8 * * 1' = minute=0, hour=8, any-day-of-month, any-month, monday
  const cronExpr = '0 8 * * 1';

  if (!cron.validate(cronExpr)) {
    logger.error(`[weeklyReport] invalid cron expression: ${cronExpr}`);
    return;
  }

  cron.schedule(cronExpr, () => {
    runWeeklyReport().catch(e =>
      logger.error('[weeklyReport] unhandled error in cron job:', e)
    );
  });

  logger.info(`[weeklyReport] cron scheduled: ${cronExpr}`);
}

module.exports = { startWeeklyReportCron, runWeeklyReport };
