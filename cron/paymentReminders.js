/**
 * paymentReminders.js — Daily payment reminder cron
 *
 * Runs every day at 09:00 AM.
 * Checks invoices with due_date in the past and sends reminders at:
 *   - Day 0  (due date)
 *   - Day 3  (3 days overdue)
 *   - Day 7  (7 days overdue)
 *   - Day 15 (15 days overdue)
 *
 * Logs to edx_payment_reminders to avoid duplicate sends.
 */

const cron    = require('node-cron');
const db      = require('../config/db');
const logger  = require('../logger');
const { sendEmail } = require('../utils/emailService');
const { sendSMS   } = require('../utils/smsService');
const { paymentReminder } = require('../utils/emailTemplates');
const { getCurrentDateTime } = require('../utils/dateTime');

const REMINDER_DAYS = [0, 3, 7, 15]; // Days relative to due date to send reminders

async function runPaymentReminders() {
  try {
    const today    = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // Fetch all unpaid / partially paid invoices with a due_date set
    const overdueInvoices = await db('edx_invoice as i')
      .leftJoin('edx_bookings as b',        'i.booking_id', 'b.id')
      .leftJoin('edx_web_app_users as u',   'b.user_id', 'u.id')
      .leftJoin(
        db('edx_receipts')
          .select('booking_id')
          .sum('total_amount as total_paid')
          .where('status', 'Approved')
          .groupBy('booking_id')
          .as('rec'),
        'rec.booking_id', 'b.id'
      )
      .whereNotNull('i.due_date')
      .whereRaw('COALESCE(i.inv_raised_amnt,0) > COALESCE(rec.total_paid,0)')
      .select(
        'i.id as invoice_id',
        'i.booking_id',
        'i.inv_raised_amnt as total_amount',
        'i.due_date',
        'b.org_id',
        db.raw('COALESCE(rec.total_paid,0) as paid_amount'),
        db.raw('COALESCE(i.inv_raised_amnt,0) - COALESCE(rec.total_paid,0) as balance_due'),
        'u.user_name   as client_name',
        'u.user_email  as client_email',
        'u.user_mobile as client_mobile',
      );

    let sent = 0;
    let skipped = 0;

    for (const inv of overdueInvoices) {
      const dueDate    = new Date(inv.due_date);
      const diffDays   = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));

      // Find which reminder day bucket this falls into
      const reminderDay = REMINDER_DAYS.find(d => diffDays === d);
      if (reminderDay === undefined) continue; // Not a reminder day

      // Check if already sent this reminder for this invoice
      const existing = await db('edx_payment_reminders')
        .where({ invoice_id: inv.invoice_id, reminder_day: reminderDay })
        .first();
      if (existing) {
        skipped++;
        continue;
      }

      // Send email reminder
      if (inv.client_email && inv.client_email !== 'NA') {
        try {
          const tpl = paymentReminder({
            clientName:   inv.client_name || 'Client',
            invoiceId:    `INV-${inv.invoice_id}`,
            bookingId:    inv.booking_id,
            amount:       Number(inv.balance_due),
            dueDate:      inv.due_date,
            daysPastDue:  diffDays,
            paymentModes: 'Cash, UPI, Bank Transfer',
          });
          await sendEmail({ to: inv.client_email, ...tpl });
        } catch (emailErr) {
          logger.warn(`[reminder] Email failed for invoice #${inv.invoice_id}: ${emailErr.message}`);
        }
      }

      // Send SMS reminder (brief message)
      if (inv.client_mobile && inv.client_mobile !== 'NA') {
        try {
          const smsText = `Dear ${inv.client_name || 'Client'}, invoice INV-${inv.invoice_id} for ₹${Number(inv.balance_due).toLocaleString('en-IN')} is ${diffDays > 0 ? `${diffDays} days overdue` : 'due today'}. Please arrange payment. -Eldivex`;
          await sendSMS(inv.client_mobile, smsText);
        } catch (smsErr) {
          logger.warn(`[reminder] SMS failed for invoice #${inv.invoice_id}: ${smsErr.message}`);
        }
      }

      // Log the reminder to prevent duplicates
      await db('edx_payment_reminders').insert({
        invoice_id:   inv.invoice_id,
        booking_id:   inv.booking_id,
        reminder_day: reminderDay,
        channel:      'both',
        sent_at:      getCurrentDateTime(),
        org_id:       inv.org_id,
      });

      sent++;
    }

    logger.info(`[paymentReminders] ${todayStr} — sent: ${sent}, skipped (already sent): ${skipped}, total overdue: ${overdueInvoices.length}`);
  } catch (err) {
    logger.error(`[paymentReminders] cron failed: ${err.message}`);
  }
}

// Schedule: every day at 09:00 AM
cron.schedule('0 9 * * *', () => {
  logger.info('[paymentReminders] Running daily payment reminder check...');
  runPaymentReminders();
});

// Export for manual triggering in tests
module.exports = { runPaymentReminders };
