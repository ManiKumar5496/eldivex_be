/**
 * hpAuthController.js — caregiver self-service authentication (phone + OTP).
 *
 * Flow:
 *   1. GET  /api/org/bySlug/:slug   → resolve the org from the shared link.
 *   2. POST /api/hpAuth/requestOtp  → { phone, org_id } sends a hashed OTP.
 *   3. POST /api/hpAuth/verifyOtp   → { phone, org_id, otp } returns a caregiver JWT.
 *
 * Security notes:
 *   • OTP is bcrypt-hashed at rest, single-use, 5-min expiry, attempt-capped.
 *   • requestOtp ALWAYS returns a generic 200 — never reveals whether a number
 *     is registered (mirrors forgotPassword).
 *   • The whole group sits behind authLimiter (see hpPortalRoutes.js).
 */

const db = require('../../config/db');
const bcrypt = require('bcrypt');
const logger = require('../../logger');
const { generateHpToken } = require('../../utils/jwt');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { sendOTP } = require('../../utils/smsService');

const isDev = process.env.NODE_ENV !== 'production';

// Statuses that may log in: 2=Approved, 5=ActiveBooking, 6=OTPBooking.
const LOGIN_ALLOWED_STATUSES = [2, 5, 6];

// Strip +91 / spaces / non-digits → last 10 digits.
const normalisePhone = (raw) =>
  String(raw || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);

// Match an HP by the last 10 digits of their stored phone, scoped to one org.
const findHpByPhone = (orgId, phone10) =>
  db('edx_hp_registration')
    .where('org_id', orgId)
    .whereIn('hp_reg_status', LOGIN_ALLOWED_STATUSES)
    .whereRaw(
      "RIGHT(REPLACE(REPLACE(hp_reg_phone_number, '+', ''), ' ', ''), 10) = ?",
      [phone10]
    )
    .first('hp_reg_id', 'hp_reg_first_name', 'hp_reg_last_name', 'hp_reg_phone_number');

/**
 * GET /api/org/bySlug/:slug — public.
 * Resolves the org encoded in the shared caregiver link (/hp?org=<slug>).
 */
const getOrgBySlug = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) return res.status(400).json({ message: 'Org slug is required.' });

    const org = await db('edx_organizations')
      .where({ slug })
      .first('id', 'name', 'slug', 'status');

    if (!org || org.status !== 'active') {
      return res.status(404).json({ message: 'Organisation not found.' });
    }

    res.json({ org_id: org.id, org_name: org.name, slug: org.slug });
  } catch (err) {
    logger.error(`Error getOrgBySlug: ${err.message}`);
    res.status(500).json({ message: 'Error resolving organisation.' });
  }
};

/**
 * POST /api/hpAuth/requestOtp — { phone, org_id }
 */
const requestOtp = async (req, res) => {
  const generic = { message: 'If that number is registered, an OTP has been sent.' };
  try {
    const orgId = parseInt(req.body.org_id, 10);
    const phone10 = normalisePhone(req.body.phone);

    if (!orgId || phone10.length !== 10) {
      return res.status(400).json({ message: 'A valid phone number and org_id are required.' });
    }

    const hp = await findHpByPhone(orgId, phone10);
    if (!hp) return res.status(200).json(generic); // don't reveal existence

    // 6-digit OTP. crypto-random is unavailable to non-prod debugging only.
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await db('edx_hp_login_otp').insert({
      org_id:     orgId,
      hp_id:      hp.hp_reg_id,
      phone:      phone10,
      otp_hash:   otpHash,
      expires_at: expiresAt,
      attempts:   0,
      consumed:   0,
      created_on: getCurrentDateTime(),
    });

    // SMS must never fail the request.
    try { await sendOTP(phone10, otp); }
    catch (smsErr) { logger.warn(`[hpAuth] OTP SMS failed for ${phone10}: ${smsErr.message}`); }

    // In non-prod, surface the OTP so the portal can be tested without SMS.
    return res.status(200).json(isDev ? { ...generic, dev_otp: otp } : generic);
  } catch (err) {
    logger.error(`Error requestOtp: ${err.message}`);
    return res.status(500).json({ message: 'Could not send OTP. Please try again.' });
  }
};

/**
 * POST /api/hpAuth/verifyOtp — { phone, org_id, otp }
 */
const verifyOtp = async (req, res) => {
  try {
    const orgId = parseInt(req.body.org_id, 10);
    const phone10 = normalisePhone(req.body.phone);
    const otp = String(req.body.otp || '').trim();

    if (!orgId || phone10.length !== 10 || !otp) {
      return res.status(400).json({ message: 'phone, org_id and otp are required.' });
    }

    const row = await db('edx_hp_login_otp')
      .where({ org_id: orgId, phone: phone10, consumed: 0 })
      .whereRaw('expires_at > NOW()')
      .orderBy('id', 'desc')
      .first();

    if (!row) {
      return res.status(400).json({ message: 'Invalid or expired OTP. Please request a new one.' });
    }

    if (row.attempts >= 5) {
      await db('edx_hp_login_otp').where({ id: row.id }).update({ consumed: 1 });
      return res.status(429).json({ message: 'Too many attempts. Please request a new OTP.' });
    }

    const match = await bcrypt.compare(otp, row.otp_hash);
    if (!match) {
      await db('edx_hp_login_otp').where({ id: row.id }).increment('attempts', 1);
      return res.status(400).json({ message: 'Incorrect OTP.' });
    }

    // Consume the OTP (single-use) and confirm the HP still exists / is active.
    await db('edx_hp_login_otp').where({ id: row.id }).update({ consumed: 1 });

    const hp = await db('edx_hp_registration')
      .where({ hp_reg_id: row.hp_id, org_id: orgId })
      .whereIn('hp_reg_status', LOGIN_ALLOWED_STATUSES)
      .first('hp_reg_id', 'hp_reg_first_name', 'hp_reg_last_name');

    if (!hp) return res.status(403).json({ message: 'Your account is not active. Please contact support.' });

    const token = generateHpToken({ hp_id: hp.hp_reg_id, org_id: orgId });

    return res.status(200).json({
      message: 'Login successful',
      token,
      hp_id: hp.hp_reg_id,
      org_id: orgId,
      hp_name: `${hp.hp_reg_first_name || ''} ${hp.hp_reg_last_name || ''}`.trim(),
    });
  } catch (err) {
    logger.error(`Error verifyOtp: ${err.message}`);
    return res.status(500).json({ message: 'Could not verify OTP. Please try again.' });
  }
};

module.exports = { getOrgBySlug, requestOtp, verifyOtp };
