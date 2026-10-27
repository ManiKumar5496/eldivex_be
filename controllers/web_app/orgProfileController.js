/**
 * orgProfileController.js — Settings → Organisation Profile
 *
 * Lets an org admin manage their own organisation's identity: the details
 * that render on every outbound client email (invoices, payment receipts).
 * Everything is scoped to the caller's org via JWT — org_id is never taken
 * from the client. Owner-level org management (plans, status) stays in
 * orgController.js; this controller only touches branding/billing fields.
 */

const db = require('../../config/db');
const logger = require('../../logger');
const { getOrgId } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');
const { getOrgBrand, clearOrgBrandCache } = require('../../utils/orgBrand');
const { logAudit } = require('../../utils/auditLogger');
const { invoiceEmail, paymentReceiptEmail } = require('../../utils/emailTemplates');

const PROFILE_FIELDS = [
  'id', 'org_code', 'name', 'slug', 'email', 'phone', 'address',
  'tagline', 'website', 'logo_url', 'brand_color', 'gstin',
  'payment_terms_days', 'invoice_notes', 'status',
];

// Fields an org admin may edit. slug/org_code/status/plan are owner-managed.
const EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'address',
  'tagline', 'website', 'logo_url', 'brand_color', 'gstin',
  'payment_terms_days', 'invoice_notes',
];

const MAX_LEN = {
  name: 100, email: 100, phone: 20, address: 255,
  tagline: 120, website: 150, logo_url: 255, brand_color: 7,
  gstin: 20, invoice_notes: 1000,
};

/** Validate a payload of editable fields; returns { clean, error }. */
function sanitizeProfilePayload(body, { partial = false } = {}) {
  const clean = {};

  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    let value = body[field];

    if (field === 'payment_terms_days') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 90) {
        return { error: 'Payment terms must be between 1 and 90 days.' };
      }
      clean[field] = n;
      continue;
    }

    value = value === null || value === undefined ? null : String(value).trim();
    if (value === '') value = null;

    if (field === 'name' && !value) {
      return { error: 'Organisation name cannot be empty.' };
    }
    if (value && MAX_LEN[field] && value.length > MAX_LEN[field]) {
      return { error: `${field} must be at most ${MAX_LEN[field]} characters.` };
    }
    if (field === 'brand_color' && value && !/^#[0-9a-fA-F]{6}$/.test(value)) {
      return { error: 'Brand colour must be a hex value like #1E3A5F.' };
    }
    if (field === 'email' && value && !/^\S+@\S+\.\S+$/.test(value)) {
      return { error: 'Billing email is not a valid email address.' };
    }
    if ((field === 'website' || field === 'logo_url') && value && !/^https?:\/\//i.test(value)) {
      return { error: `${field === 'website' ? 'Website' : 'Logo URL'} must start with http:// or https://.` };
    }

    clean[field] = value;
  }

  if (!partial && !('name' in clean)) {
    return { error: 'Organisation name is required.' };
  }
  return { clean };
}

// ── GET /api/orgProfile ───────────────────────────────────────────────────────

const getOrgProfile = async (req, res) => {
  try {
    const org = await db('edx_organizations')
      .where({ id: getOrgId(req) })
      .first(PROFILE_FIELDS);
    if (!org) return res.status(404).json({ message: 'Organisation not found.' });
    res.json(org);
  } catch (err) {
    logger.error(`Error getOrgProfile: ${err.message}`);
    res.status(500).json({ message: 'Error fetching organisation profile.' });
  }
};

// ── PUT /api/orgProfile ───────────────────────────────────────────────────────

const updateOrgProfile = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { clean, error } = sanitizeProfilePayload(req.body || {});
    if (error) return res.status(400).json({ message: error });
    if (Object.keys(clean).length === 0) {
      return res.status(400).json({ message: 'No editable fields supplied.' });
    }

    const before = await db('edx_organizations').where({ id: orgId }).first(PROFILE_FIELDS);
    if (!before) return res.status(404).json({ message: 'Organisation not found.' });

    await db('edx_organizations').where({ id: orgId }).update(clean);
    clearOrgBrandCache(orgId); // emails must pick up the new identity immediately

    const after = await db('edx_organizations').where({ id: orgId }).first(PROFILE_FIELDS);

    logAudit({
      entityType: 'org_profile',
      entityId:   orgId,
      action:     'UPDATE',
      changedBy:  req.login_data?.id,
      org_id:     orgId,
      oldValues:  before,
      newValues:  after,
    });

    res.json({ message: 'Organisation profile updated.', data: after });
  } catch (err) {
    logger.error(`Error updateOrgProfile: ${err.message}`);
    res.status(500).json({ message: 'Error updating organisation profile.' });
  }
};

// ── POST /api/orgProfile/emailPreview ─────────────────────────────────────────
//
// Renders the invoice + receipt templates with SAMPLE transaction data and the
// org's branding. Draft (unsaved) form values may be passed in the body so the
// preview updates live while the admin types — they are validated but never
// persisted.

const SAMPLE = {
  clientName:  'Ramesh Iyer',
  patientName: 'Lakshmi Iyer',
  bookingId:   318,
  serviceName: '24x7 Home Nursing',
  periodFrom:  '01 Jul 2026',
  periodTo:    '31 Jul 2026',
  amount:      45000,
  taxAmount:   2250,
};

const previewEmails = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const saved = await getOrgBrand(db, orgId);
    if (!saved) return res.status(404).json({ message: 'Organisation not found.' });

    // Overlay draft values (partial — only fields present in the body).
    const { clean, error } = sanitizeProfilePayload(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ message: error });
    const org = { ...saved, ...clean };

    const terms   = Number(org.payment_terms_days) || 15;
    const dueDate = new Date(Date.now() + terms * 86400000)
      .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const today = new Date()
      .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    const invoice = invoiceEmail({
      org,
      ...SAMPLE,
      invoiceId:   'INV-1042',
      invoiceDate: today,
      dueDate,
    });

    const receipt = paymentReceiptEmail({
      org,
      ...SAMPLE,
      receiptNumber: `RCP-${orgId}-000217`,
      receiptDate:   today,
      totalAmount:   SAMPLE.amount + SAMPLE.taxAmount,
      paymentMode:   'UPI',
      transactionId: 'UPI9834712650',
    });

    res.json({
      invoice: { subject: invoice.subject, html: invoice.html },
      receipt: { subject: receipt.subject, html: receipt.html },
      sender:  `"${org.name || 'Eldivex'}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@eldivex.in'}>`,
    });
  } catch (err) {
    logger.error(`Error previewEmails: ${err.message}`);
    res.status(500).json({ message: 'Error rendering email preview.' });
  }
};

module.exports = guardOrgHandlers({ getOrgProfile, updateOrgProfile, previewEmails });
