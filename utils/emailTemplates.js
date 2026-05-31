/**
 * emailTemplates.js — Inline HTML email generators
 *
 * All functions return an object: { subject, html }
 * No external template engine needed — plain ES6 template literals.
 */

const APP_NAME = 'Eldivex';
const BRAND_COLOR = '#1E3A5F';
const ACCENT_COLOR = '#2E86AB';

// ── Shared layout wrapper ─────────────────────────────────────────────────────

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:8px;overflow:hidden;
                      box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:${BRAND_COLOR};padding:24px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">
                ${APP_NAME}
              </h1>
              <p style="margin:4px 0 0;color:#a8c0d6;font-size:12px;">
                Elderly Care Management Platform
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8f8f8;padding:16px 32px;border-top:1px solid #e8e8e8;">
              <p style="margin:0;color:#999;font-size:11px;text-align:center;">
                This is an automated message from ${APP_NAME}. Please do not reply to this email.<br/>
                © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function infoRow(label, value) {
  return `<tr>
    <td style="padding:6px 0;color:#666;font-size:14px;width:160px;">${label}</td>
    <td style="padding:6px 0;color:#222;font-size:14px;font-weight:600;">${value || '—'}</td>
  </tr>`;
}

// ── 1. Booking Confirmed ──────────────────────────────────────────────────────

/**
 * @param {{ clientName, patientName, serviceType, startDate, endDate, bookingId }} data
 */
function bookingConfirmed({ clientName, patientName, serviceType, startDate, endDate, bookingId }) {
  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Booking Confirmed</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      Dear ${clientName}, your booking has been received and confirmed.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${infoRow('Booking ID',     '#' + bookingId)}
      ${infoRow('Patient Name',   patientName)}
      ${infoRow('Service',        serviceType)}
      ${infoRow('Start Date',     startDate)}
      ${infoRow('End Date',       endDate || 'Open-ended')}
    </table>
    <p style="margin:0;color:#555;font-size:14px;">
      Our team will contact you shortly to assign a caregiver.
      If you have any questions, please reach out to your branch coordinator.
    </p>`;

  return {
    subject: `Booking Confirmed — ${APP_NAME} (#${bookingId})`,
    html:    layout('Booking Confirmed', body),
  };
}

// ── 2. OTP Delivery to HP ─────────────────────────────────────────────────────

/**
 * @param {{ hpName, otp, patientName, bookingId }} data
 */
function otpDelivery({ hpName, otp, patientName, bookingId }) {
  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Assignment OTP</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      Dear ${hpName}, you have been assigned to a new patient.
      Please share the OTP below with the family/coordinator to confirm your assignment.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <div style="display:inline-block;background:${ACCENT_COLOR};color:#fff;
                  font-size:36px;font-weight:700;letter-spacing:12px;
                  padding:16px 32px;border-radius:8px;">
        ${otp}
      </div>
    </div>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${infoRow('Booking ID',   '#' + bookingId)}
      ${infoRow('Patient Name', patientName)}
    </table>
    <p style="margin:0;color:#e74c3c;font-size:13px;">
      ⚠️ Do not share this OTP with anyone other than the Eldivex coordinator.
      This OTP is valid for this assignment only.
    </p>`;

  return {
    subject: `Your Assignment OTP — ${APP_NAME} (#${bookingId})`,
    html:    layout('Assignment OTP', body),
  };
}

// ── 3. Invoice Generated ──────────────────────────────────────────────────────

/**
 * @param {{ clientName, bookingId, amount, periodFrom, periodTo, invoiceId }} data
 */
function invoiceGenerated({ clientName, bookingId, amount, periodFrom, periodTo, invoiceId }) {
  const formatted = typeof amount === 'number'
    ? `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : `₹${amount}`;

  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Invoice Generated</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      Dear ${clientName}, your invoice has been generated for the service period below.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${infoRow('Invoice ID',  '#' + invoiceId)}
      ${infoRow('Booking ID',  '#' + bookingId)}
      ${infoRow('Period From', periodFrom)}
      ${infoRow('Period To',   periodTo)}
      ${infoRow('Amount Due',  formatted)}
    </table>
    <p style="margin:0;color:#555;font-size:14px;">
      Please arrange payment at the earliest.
      Contact your branch coordinator for payment options and UPI/bank details.
    </p>`;

  return {
    subject: `Invoice #${invoiceId} — ${APP_NAME} (Booking #${bookingId})`,
    html:    layout('Invoice Generated', body),
  };
}

// ── 4. Support Ticket Created ─────────────────────────────────────────────────

/**
 * @param {{ clientName, ticketId, title }} data
 */
function supportTicketCreated({ clientName, ticketId, title }) {
  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Support Ticket Received</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      Dear ${clientName}, we have received your support request and our team will get back to you shortly.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${infoRow('Ticket ID', '#' + ticketId)}
      ${infoRow('Subject',   title)}
      ${infoRow('Status',    'Open')}
    </table>
    <p style="margin:0;color:#555;font-size:14px;">
      Our support team typically responds within 24 hours on business days.
      You will receive another notification when your ticket status is updated.
    </p>`;

  return {
    subject: `Support Ticket #${ticketId} — ${APP_NAME}`,
    html:    layout('Support Ticket Received', body),
  };
}

// ── 5. Password Reset Link ────────────────────────────────────────────────────

/**
 * @param {{ resetUrl }} data
 */
function passwordResetLink({ resetUrl }) {
  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Password Reset Request</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      We received a request to reset your ${APP_NAME} admin password.
      Click the button below to set a new password. This link expires in <strong>15 minutes</strong>.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${resetUrl}"
         style="display:inline-block;background:${ACCENT_COLOR};color:#fff;
                text-decoration:none;font-size:16px;font-weight:600;
                padding:14px 32px;border-radius:6px;">
        Reset Password
      </a>
    </div>
    <p style="margin:0 0 8px;color:#999;font-size:12px;">
      If the button does not work, copy and paste this URL into your browser:
    </p>
    <p style="margin:0;color:#666;font-size:12px;word-break:break-all;">
      ${resetUrl}
    </p>
    <hr style="border:none;border-top:1px solid #e8e8e8;margin:24px 0;"/>
    <p style="margin:0;color:#999;font-size:12px;">
      If you did not request a password reset, please ignore this email.
      Your password will remain unchanged.
    </p>`;

  return {
    subject: `Password Reset — ${APP_NAME}`,
    html:    layout('Password Reset', body),
  };
}

// ── 6. Payment Reminder ───────────────────────────────────────────────────────

/**
 * @param {{ clientName, invoiceId, bookingId, amount, dueDate, daysPastDue, paymentModes }} data
 */
function paymentReminder({ clientName, invoiceId, bookingId, amount, dueDate, daysPastDue, paymentModes }) {
  const formatted = typeof amount === 'number'
    ? `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : `₹${amount}`;

  const urgency = daysPastDue >= 15
    ? `<p style="margin:0 0 16px;color:#c0392b;font-weight:bold;font-size:14px;">⚠️ Your payment is ${daysPastDue} days overdue. Please settle immediately to avoid service interruption.</p>`
    : daysPastDue >= 7
    ? `<p style="margin:0 0 16px;color:#e67e22;font-size:14px;">📌 Your payment is ${daysPastDue} days past due. Please arrange payment at the earliest.</p>`
    : `<p style="margin:0 0 16px;color:#555;font-size:14px;">This is a friendly reminder that your invoice payment is due.</p>`;

  const modesHtml = paymentModes
    ? `<p style="margin:16px 0 0;color:#555;font-size:13px;">Accepted payment modes: <strong>${paymentModes}</strong></p>`
    : '';

  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Payment Reminder</h2>
    <p style="margin:0 0 16px;color:#555;font-size:14px;">Dear ${clientName},</p>
    ${urgency}
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${infoRow('Invoice ID',  '#' + invoiceId)}
      ${infoRow('Booking ID',  '#' + bookingId)}
      ${infoRow('Amount Due',  formatted)}
      ${infoRow('Due Date',    dueDate)}
    </table>
    <p style="margin:0;color:#555;font-size:14px;">
      Please contact your branch coordinator to arrange payment or use the payment link provided.
    </p>
    ${modesHtml}`;

  return {
    subject: `Payment Reminder — Invoice #${invoiceId} (${APP_NAME})`,
    html:    layout('Payment Reminder', body),
  };
}

// ── 7. Credit Note Generated ──────────────────────────────────────────────────

/**
 * @param {{ clientName, creditType, amount, bookingId, noteId, reason }} data
 */
function creditNoteGenerated({ clientName, creditType, amount, bookingId, noteId, reason }) {
  const formatted = typeof amount === 'number'
    ? `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : `₹${amount}`;

  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Credit Note Issued</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      Dear ${clientName}, a credit note has been issued on your account.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${noteId ? infoRow('Credit Note ID', '#' + noteId) : ''}
      ${infoRow('Booking ID',   '#' + bookingId)}
      ${infoRow('Type',         creditType)}
      ${infoRow('Credit Amount', formatted)}
      ${infoRow('Reason',       reason || '—')}
    </table>
    <p style="margin:0;color:#555;font-size:14px;">
      This credit will be adjusted against your outstanding balance.
      Please contact your branch coordinator for any queries.
    </p>`;

  return {
    subject: `Credit Note Issued — ${APP_NAME} (Booking #${bookingId})`,
    html:    layout('Credit Note', body),
  };
}

// ── 8. Cancellation Billing Summary ──────────────────────────────────────────

/**
 * @param {{ clientName, bookingId, cancelDate, reason, daysUsed, dailyRate,
 *            amountDue, totalPaid, owing, refundable }} data
 */
function cancellationBillingSummary({ clientName, bookingId, cancelDate, reason, daysUsed, dailyRate, amountDue, totalPaid, owing, refundable }) {
  const fmt = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const actionHtml = owing > 0
    ? `<p style="margin:16px 0 0;color:#e74c3c;font-weight:bold;font-size:14px;">⚠️ An invoice of ${fmt(owing)} has been raised for the remaining balance. Please arrange payment.</p>`
    : refundable > 0
    ? `<p style="margin:16px 0 0;color:#27ae60;font-weight:bold;font-size:14px;">✅ A refund of ${fmt(refundable)} will be processed to your account within 5-7 business days.</p>`
    : `<p style="margin:16px 0 0;color:#27ae60;font-size:14px;">✅ Your account is fully settled. No further action required.</p>`;

  const body = `
    <h2 style="margin:0 0 8px;color:${BRAND_COLOR};font-size:20px;">Service Cancellation — Billing Summary</h2>
    <p style="margin:0 0 24px;color:#555;font-size:14px;">
      Dear ${clientName}, your service has been cancelled as requested. Here is your billing summary.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${infoRow('Booking ID',     '#' + bookingId)}
      ${infoRow('Cancellation Date', cancelDate)}
      ${infoRow('Reason',         reason)}
      ${infoRow('Days of Service', daysUsed + ' days')}
      ${infoRow('Daily Rate',     fmt(dailyRate))}
      ${infoRow('Amount Due',     fmt(amountDue))}
      ${infoRow('Amount Paid',    fmt(totalPaid))}
    </table>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#f8f8f8;padding:12px;border-radius:6px;">
      ${owing     > 0 ? infoRow('Balance Owing', fmt(owing))     : ''}
      ${refundable > 0 ? infoRow('Refund Amount', fmt(refundable)) : ''}
      ${owing === 0 && refundable === 0 ? infoRow('Status', 'Fully Settled') : ''}
    </table>
    ${actionHtml}`;

  return {
    subject: `Service Cancellation Billing — ${APP_NAME} (Booking #${bookingId})`,
    html:    layout('Cancellation Billing', body),
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  bookingConfirmed,
  otpDelivery,
  invoiceGenerated,
  supportTicketCreated,
  passwordResetLink,
  paymentReminder,
  creditNoteGenerated,
  cancellationBillingSummary,
};
