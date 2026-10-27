/**
 * clientAuthController.js — client (customer) self-service auth (phone + OTP).
 *
 *   POST /api/clientAuth/requestOtp  → { phone, org_id } sends a hashed OTP.
 *   POST /api/clientAuth/verifyOtp   → { phone, org_id, otp } returns a client JWT.
 *
 * Self-signup: an unknown phone still gets an OTP (stored with user_id NULL);
 * a successful verify creates the edx_client_app_users row (is_new_user:true).
 *
 * Org resolution reuses the public /org/bySlug & /org/byId endpoints.
 * Mirrors hpAuthController: crypto-random, hashed, single-use OTPs. dev_otp and
 * the static test OTP exist only when NODE_ENV=development AND
 * EXPOSE_DEV_OTP=true.
 */

const db = require('../../config/db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const logger = require('../../logger');
const { generateClientToken } = require('../../utils/jwt');
const { resolveOrgId } = require('../../utils/orgCode');
const { isOrgLoginBlocked, ORG_SUSPENDED_RESPONSE } = require('../../utils/orgStatus');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { sendOTP } = require('../../utils/smsService');

// Dev-only test aids (dev_otp in the response, CLIENT_STATIC_OTP). Both flags
// are required; envValidator refuses EXPOSE_DEV_OTP=true in production.
const devOtpEnabled = () =>
  process.env.NODE_ENV === 'development' && process.env.EXPOSE_DEV_OTP === 'true';

const normalisePhone = (raw) =>
  String(raw || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);

// Org kill-switch: only active/trial orgs may use the client portal.
// Shares the rule with every other login path (utils/orgStatus).
const isOrgBlocked = async (orgId) => {
  const org = await db('edx_organizations').where({ id: orgId }).first('status');
  return !org || isOrgLoginBlocked(org.status);
};

const PHONE_MATCH = "RIGHT(REPLACE(REPLACE(phone_number, '+', ''), ' ', ''), 10) = ?";

// Any client (active or not) with this phone in the org, by the last 10 digits.
const findAnyClientByPhone = (orgId, phone10) =>
  db('edx_client_app_users')
    .where('org_id', orgId)
    .whereRaw(PHONE_MATCH, [phone10])
    .orderBy('id', 'asc')
    .first('id', 'user_name', 'phone_number', 'status');

const isActive = (client) => client && String(client.status) !== '0';

// Returns { client, isNew } for an active client, creating one when the phone
// is unknown, or { inactive: true } when the number belongs to a deactivated
// client (never silently re-created).
async function findOrCreateClient(orgId, phone10) {
  const existing = await findAnyClientByPhone(orgId, phone10);
  if (existing) return isActive(existing) ? { client: existing, isNew: false } : { inactive: true };

  try {
    const [id] = await db('edx_client_app_users').insert({
      phone_number: phone10,
      org_id: orgId,
      status: 1,
      is_new_user_flag: 1,
      created_on: getCurrentDateTime(),
    });
    return { client: { id, user_name: null }, isNew: true };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    // Concurrent verify created it first.
    const again = await findAnyClientByPhone(orgId, phone10);
    if (!again) throw err;
    return isActive(again) ? { client: again, isNew: false } : { inactive: true };
  }
}

const loginResponse = (client, orgId, isNew) => ({
  message: 'Login successful',
  token: generateClientToken({ user_id: client.id, org_id: orgId }),
  user_id: client.id,
  org_id: orgId,
  user_name: client.user_name || 'Client',
  is_new_user: !!isNew,
});

const INACTIVE = { message: 'Your account is not active. Please contact support.' };

const requestOtp = async (req, res) => {
  const generic = { message: 'An OTP has been sent to your phone.' };
  try {
    // Numeric id (legacy orgs) or org code (new orgs).
    const orgId = await resolveOrgId(db, req.body.org_id);
    const phone10 = normalisePhone(req.body.phone);
    if (!orgId || phone10.length !== 10) {
      return res.status(400).json({ message: 'A valid phone number and org_id are required.' });
    }

    if (await isOrgBlocked(orgId)) return res.status(403).json(ORG_SUSPENDED_RESPONSE);

    // Unknown numbers get a signup OTP (user_id NULL). Deactivated clients get
    // the same response but no OTP, so the endpoint doesn't reveal them.
    const client = await findAnyClientByPhone(orgId, phone10);
    if (client && !isActive(client)) return res.status(200).json(generic);

    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await db('edx_client_login_otp').insert({
      org_id: orgId, user_id: client ? client.id : null, phone: phone10, otp_hash: otpHash,
      expires_at: expiresAt, attempts: 0, consumed: 0, created_on: getCurrentDateTime(),
    });

    try { await sendOTP(phone10, otp); }
    catch (smsErr) { logger.warn(`[clientAuth] OTP SMS failed for ${phone10}: ${smsErr.message}`); }

    return res.status(200).json(devOtpEnabled() ? { ...generic, dev_otp: otp } : generic);
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

    // ── Static OTP: dev only (NODE_ENV=development AND EXPOSE_DEV_OTP=true AND
    // CLIENT_STATIC_OTP set). Never active anywhere else. ────────────────────
    const STATIC_OTP = devOtpEnabled() ? process.env.CLIENT_STATIC_OTP : undefined;
    if (STATIC_OTP && otp === STATIC_OTP) {
      const found = await findOrCreateClient(orgId, phone10);
      if (found.inactive) return res.status(403).json(INACTIVE);
      return res.status(200).json(loginResponse(found.client, orgId, found.isNew));
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

    if (row.user_id) {
      const client = await db('edx_client_app_users')
        .where({ id: row.user_id, org_id: orgId }).whereNot('status', 0)
        .first('id', 'user_name');
      if (!client) return res.status(403).json(INACTIVE);
      return res.status(200).json(loginResponse(client, orgId, false));
    }

    // Signup OTP: the phone had no account when the OTP was requested.
    const found = await findOrCreateClient(orgId, phone10);
    if (found.inactive) return res.status(403).json(INACTIVE);
    return res.status(200).json(loginResponse(found.client, orgId, found.isNew));
  } catch (err) {
    logger.error(`Error client verifyOtp: ${err.message}`);
    return res.status(500).json({ message: 'Could not verify OTP. Please try again.' });
  }
};

module.exports = { requestOtp, verifyOtp };
