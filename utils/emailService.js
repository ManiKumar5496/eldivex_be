/**
 * emailService.js — Nodemailer wrapper
 *
 * Usage:
 *   const { sendEmail } = require('./emailService');
 *   await sendEmail({ to: 'user@example.com', subject: 'Hello', html: '<p>Hi</p>' });
 *
 * If EMAIL_USER is not set in .env the call is a no-op (logs a warning).
 * All callers MUST wrap in try/catch — a failed email must never fail an API request.
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    host:    process.env.EMAIL_HOST || undefined,   // set for non-Gmail SMTP
    port:    process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : undefined,
    secure:  process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  return _transporter;
}

/**
 * @param {{ to: string, subject: string, html: string, fromName?: string }} options
 *   fromName — display name for the sender (e.g. the organisation's name for
 *   tenant-branded invoices/receipts). Defaults to the platform name.
 *   attachments — optional nodemailer attachments ([{ filename, content }]).
 */
async function sendEmail({ to, subject, html, fromName, attachments }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[emailService] EMAIL_USER / EMAIL_PASS not set — skipping email to:', to);
    return;
  }

  const displayName = String(fromName || 'Eldivex').replace(/["\r\n]/g, '').trim() || 'Eldivex';
  const transporter = getTransporter();
  await transporter.sendMail({
    from:    `"${displayName}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
  });
}

module.exports = { sendEmail };
