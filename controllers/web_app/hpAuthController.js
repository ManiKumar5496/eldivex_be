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
const crypto = require('crypto');
const logger = require('../../logger');
const { generateHpToken } = require('../../utils/jwt');
const { resolveOrgId } = require('../../utils/orgCode');
const { isOrgLoginBlocked, ORG_SUSPENDED_RESPONSE } = require('../../utils/orgStatus');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { sendOTP } = require('../../utils/smsService');

// Dev-only test aids (dev_otp in the response, HP_STATIC_OTP). Both flags
// are required; envValidator refuses EXPOSE_DEV_OTP=true in production.
const devOtpEnabled = () =>
  process.env.NODE_ENV === 'development' && process.env.EXPOSE_DEV_OTP === 'true';

// Statuses that may log in: 2=Approved, 5=ActiveBooking, 6=OTPBooking.
const LOGIN_ALLOWED_STATUSES = [2, 5, 6];

// Strip +91 / spaces / non-digits → last 10 digits.
const normalisePhone = (raw) =>
  String(raw || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);

// Org kill-switch: only active/trial orgs may use the caregiver portal.
// Shares the rule with every other login path (utils/orgStatus).
const isOrgBlocked = async (orgId) => {
  const org = await db('edx_organizations').where({ id: orgId }).first('status');
  return !org || isOrgLoginBlocked(org.status);
};

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
      .first('id', 'org_code', 'name', 'slug', 'status');

    // 404 (not 403) on a blocked org: the public resolver must not reveal that
    // a suspended org exists.
    if (!org || isOrgLoginBlocked(org.status)) {
      return res.status(404).json({ message: 'Organisation not found.' });
    }

    res.json({ org_id: org.id, org_code: org.org_code, org_name: org.name, slug: org.slug });
  } catch (err) {
    logger.error(`Error getOrgBySlug: ${err.message}`);
    res.status(500).json({ message: 'Error resolving organisation.' });
  }
};

/**
 * GET /api/org/byId/:id — public.
 * Lets a caregiver link that carries org_id (instead of a slug) still show the
 * organisation name on the login screen. Accepts a numeric id (legacy orgs)
 * or an org code like SUN-482913 (orgs created after the code rollout).
 */
const getOrgById = async (req, res) => {
  try {
    const id = await resolveOrgId(db, req.params.id);
    if (!id) return res.status(400).json({ message: 'A valid org id is required.' });
    const org = await db('edx_organizations').where({ id }).first('id', 'org_code', 'name', 'slug', 'status');
    if (!org || isOrgLoginBlocked(org.status)) return res.status(404).json({ message: 'Organisation not found.' });
    res.json({ org_id: org.id, org_code: org.org_code, org_name: org.name, slug: org.slug });
  } catch (err) {
    logger.error(`Error getOrgById: ${err.message}`);
    res.status(500).json({ message: 'Error resolving organisation.' });
  }
};

/**
 * POST /api/hpAuth/requestOtp — { phone, org_id }
 */
const requestOtp = async (req, res) => {
  const generic = { message: 'If that number is registered, an OTP has been sent.' };
  try {
    // Numeric id (legacy orgs) or org code (new orgs).
    const orgId = await resolveOrgId(db, req.body.org_id);
    const phone10 = normalisePhone(req.body.phone);

    if (!orgId || phone10.length !== 10) {
      return res.status(400).json({ message: 'A valid phone number and org_id are required.' });
    }

    if (await isOrgBlocked(orgId)) return res.status(403).json(ORG_SUSPENDED_RESPONSE);

    const hp = await findHpByPhone(orgId, phone10);
    if (!hp) return res.status(200).json(generic); // don't reveal existence

    // 6-digit, crypto-random OTP.
    const otp = String(crypto.randomInt(100000, 1000000));
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

    // Dev only: surface the OTP so the portal can be tested without SMS.
    return res.status(200).json(devOtpEnabled() ? { ...generic, dev_otp: otp } : generic);
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
    const orgId = await resolveOrgId(db, req.body.org_id);
    const phone10 = normalisePhone(req.body.phone);
    const otp = String(req.body.otp || '').trim();

    if (!orgId || phone10.length !== 10 || !otp) {
      return res.status(400).json({ message: 'phone, org_id and otp are required.' });
    }

    if (await isOrgBlocked(orgId)) return res.status(403).json(ORG_SUSPENDED_RESPONSE);

    // ── Static OTP: dev only (NODE_ENV=development AND EXPOSE_DEV_OTP=true AND
    // HP_STATIC_OTP set). Never active anywhere else. ─────────────────────────
    const STATIC_OTP = devOtpEnabled() ? process.env.HP_STATIC_OTP : undefined;
    if (STATIC_OTP && otp === STATIC_OTP) {
      const hp = await findHpByPhone(orgId, phone10);
      if (!hp) return res.status(403).json({ message: 'Your account is not active. Please contact support.' });
      const token = generateHpToken({ hp_id: hp.hp_reg_id, org_id: orgId });
      return res.status(200).json({
        message: 'Login successful',
        token,
        hp_id: hp.hp_reg_id,
        org_id: orgId,
        hp_name: `${hp.hp_reg_first_name || ''} ${hp.hp_reg_last_name || ''}`.trim(),
      });
    }

    // Consider all live OTPs for this number (a caregiver may legitimately have
    // requested more than once); match against any so an earlier valid code
    // still works. Newest first, capped to keep bcrypt comparisons bounded.
    const candidates = await db('edx_hp_login_otp')
      .where({ org_id: orgId, phone: phone10, consumed: 0 })
      .whereRaw('expires_at > NOW()')
      .orderBy('id', 'desc')
      .limit(5);

    if (candidates.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired OTP. Please request a new one.' });
    }

    if (candidates[0].attempts >= 5) {
      await db('edx_hp_login_otp').where({ id: candidates[0].id }).update({ consumed: 1 });
      return res.status(429).json({ message: 'Too many attempts. Please request a new OTP.' });
    }

    let row = null;
    for (const c of candidates) {
      if (await bcrypt.compare(otp, c.otp_hash)) { row = c; break; }
    }
    if (!row) {
      await db('edx_hp_login_otp').where({ id: candidates[0].id }).increment('attempts', 1);
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

module.exports = { getOrgBySlug, getOrgById, requestOtp, verifyOtp };
