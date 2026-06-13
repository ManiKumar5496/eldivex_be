/**
 * clientAuthController.js — client (customer) self-service auth (phone + OTP).
 *
 *   POST /api/clientAuth/requestOtp  → { phone, org_id } sends a hashed OTP.
 *   POST /api/clientAuth/verifyOtp   → { phone, org_id, otp } returns a client JWT.
 *
 * Org resolution reuses the public /org/bySlug & /org/byId endpoints.
 * Mirrors hpAuthController: hashed/single-use OTPs, generic responses, and a
 * TEMPORARY static OTP for testing.
 */

const db = require('../../config/db');
const bcrypt = require('bcrypt');
const logger = require('../../logger');
const { generateClientToken } = require('../../utils/jwt');
const { resolveOrgId } = require('../../utils/orgCode');
const { isOrgLoginBlocked, ORG_SUSPENDED_RESPONSE } = require('../../utils/orgStatus');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { sendOTP } = require('../../utils/smsService');

const isDev = process.env.NODE_ENV !== 'production';

const normalisePhone = (raw) =>
  String(raw || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);

// Org kill-switch: only active/trial orgs may use the client portal.
// Shares the rule with every other login path (utils/orgStatus).
const isOrgBlocked = async (orgId) => {
  const org = await db('edx_organizations').where({ id: orgId }).first('status');
  return !org || isOrgLoginBlocked(org.status);
};

// Match an active client by the last 10 digits of their phone, scoped to one org.
const findClientByPhone = (orgId, phone10) =>
  db('edx_client_app_users')
    .where('org_id', orgId)
    .whereNot('status', 0)
    .whereRaw("RIGHT(REPLACE(REPLACE(phone_number, '+', ''), ' ', ''), 10) = ?", [phone10])
    .first('id', 'user_name', 'phone_number');

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

    const client = await findClientByPhone(orgId, phone10);
    if (!client) return res.status(200).json(generic);

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await db('edx_client_login_otp').insert({
      org_id: orgId, user_id: client.id, phone: phone10, otp_hash: otpHash,
      expires_at: expiresAt, attempts: 0, consumed: 0, created_on: getCurrentDateTime(),
    });

    try { await sendOTP(phone10, otp); }
    catch (smsErr) { logger.warn(`[clientAuth] OTP SMS failed for ${phone10}: ${smsErr.message}`); }

    return res.status(200).json(isDev ? { ...generic, dev_otp: otp } : generic);
  } catch (err) {
    logger.error(`Error client requestOtp: ${err.message}`);
    return res.status(500).json({ message: 'Could not send OTP. Please try again.' });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const orgId = await resolveOrgId(db, req.body.org_id);
    const phone10 = normalisePhone(req.body.phone);
    const otp = String(req.body.otp || '').trim();
    if (!orgId || phone10.length !== 10 || !otp) {
      return res.status(400).json({ message: 'phone, org_id and otp are required.' });
    }

    if (await isOrgBlocked(orgId)) return res.status(403).json(ORG_SUSPENDED_RESPONSE);

    // ── TEMPORARY (testing): accept a static OTP. Remove / set CLIENT_STATIC_OTP=''
    // in env to enforce real OTPs. ─────────────────────────────────────────────
    const STATIC_OTP = process.env.CLIENT_STATIC_OTP ?? '123456';
    if (STATIC_OTP && otp === STATIC_OTP) {
      const client = await findClientByPhone(orgId, phone10);
      if (!client) return res.status(403).json({ message: 'No account found for this number.' });
      const token = generateClientToken({ user_id: client.id, org_id: orgId });
      return res.status(200).json({
        message: 'Login successful', token,
        user_id: client.id, org_id: orgId, user_name: client.user_name || 'Client',
      });
    }

    const candidates = await db('edx_client_login_otp')
      .where({ org_id: orgId, phone: phone10, consumed: 0 })
      .whereRaw('expires_at > NOW()')
      .orderBy('id', 'desc').limit(5);

    if (candidates.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired OTP. Please request a new one.' });
    }
    if (candidates[0].attempts >= 5) {
      await db('edx_client_login_otp').where({ id: candidates[0].id }).update({ consumed: 1 });
      return res.status(429).json({ message: 'Too many attempts. Please request a new OTP.' });
    }

    let row = null;
    for (const c of candidates) {
      if (await bcrypt.compare(otp, c.otp_hash)) { row = c; break; }
    }
    if (!row) {
      await db('edx_client_login_otp').where({ id: candidates[0].id }).increment('attempts', 1);
      return res.status(400).json({ message: 'Incorrect OTP.' });
    }

    await db('edx_client_login_otp').where({ id: row.id }).update({ consumed: 1 });
    const client = await db('edx_client_app_users')
      .where({ id: row.user_id, org_id: orgId }).whereNot('status', 0)
      .first('id', 'user_name');
    if (!client) return res.status(403).json({ message: 'Your account is not active.' });

    const token = generateClientToken({ user_id: client.id, org_id: orgId });
    return res.status(200).json({
      message: 'Login successful', token,
      user_id: client.id, org_id: orgId, user_name: client.user_name || 'Client',
    });
  } catch (err) {
    logger.error(`Error client verifyOtp: ${err.message}`);
    return res.status(500).json({ message: 'Could not verify OTP. Please try again.' });
  }
};

module.exports = { requestOtp, verifyOtp };
