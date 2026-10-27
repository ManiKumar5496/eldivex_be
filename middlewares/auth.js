/**
 * auth.js — admin-web / owner-platform JWT guard.
 *
 * Accepts ONLY two token kinds:
 *   • staff — issued by /loginWeb: { id, role_id, branch_access, org_id }
 *   • owner — issued by /ownerLogin: { is_owner: true, ... }
 *
 * Caregiver (role:'caregiver'), client (role:'client') and legacy client
 * tokens (role_id null, from the retired /login) are rejected with 401 — they
 * have their own guards (hpAuth / clientAuth) and must never reach admin routes.
 *
 * Staff tokens are re-checked against edx_web_app_users (cached STAFF_TTL_MS):
 *   • user_status must still be '1' (terminated users lose access), and
 *   • the token must be issued at/after tokens_valid_after (set on terminate
 *     and password reset), so old sessions are revoked.
 * Call invalidateStaffCache(userId) after changing either so it applies now.
 */

const jwt    = require('jsonwebtoken');
const db     = require('../config/db');
const logger = require('../logger');
require('dotenv').config();
const JWT_TOKEN_KEY = process.env.JWT_TOKEN_KEY;

const STAFF_TTL_MS = 60 * 1000;
const staffCache = new Map(); // userId -> { row, ts }

// Flipped off once if migration 041 (tokens_valid_after) has not been run yet,
// so auth keeps working on a DB that lacks the column.
let hasTokensValidAfter = true;

const INVALID_KIND = { error: 'Invalid token for this endpoint' };
const SESSION_REVOKED = { error: 'Session is no longer valid. Please log in again.' };

function invalidateStaffCache(userId) {
  if (userId === undefined || userId === null) staffCache.clear();
  else staffCache.delete(Number(userId));
}

async function loadStaff(userId) {
  const cached = staffCache.get(userId);
  if (cached && Date.now() - cached.ts < STAFF_TTL_MS) return cached.row;

  const cols = ['id', 'user_status', 'user_role', 'org_id'];
  let row;
  try {
    row = await db('edx_web_app_users')
      .where('id', userId)
      .first(hasTokensValidAfter ? [...cols, 'tokens_valid_after'] : cols);
  } catch (err) {
    if (hasTokensValidAfter && err.code === 'ER_BAD_FIELD_ERROR') {
      hasTokensValidAfter = false;
      logger.warn('[auth] edx_web_app_users.tokens_valid_after missing — run migration 20261007_041');
      row = await db('edx_web_app_users').where('id', userId).first(cols);
    } else {
      throw err;
    }
  }
  row = row || null;
  staffCache.set(userId, { row, ts: Date.now() });
  return row;
}

const isStaffToken = (d) =>
  d && d.is_owner !== true && d.role === undefined &&
  d.role_id !== null && d.role_id !== undefined && !!d.id;

const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Access token missing' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_TOKEN_KEY);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (decoded.is_owner === true) {
    req.login_data = decoded;
    return next();
  }

  if (!isStaffToken(decoded) || !decoded.org_id) {
    return res.status(401).json(INVALID_KIND);
  }

  try {
    const staff = await loadStaff(Number(decoded.id));
    if (!staff || String(staff.user_status) !== '1' ||
        Number(staff.org_id) !== Number(decoded.org_id)) {
      return res.status(401).json(SESSION_REVOKED);
    }
    if (staff.tokens_valid_after) {
      const validAfter = new Date(staff.tokens_valid_after).getTime();
      if (!isNaN(validAfter) && (decoded.iat || 0) * 1000 < validAfter) {
        return res.status(401).json(SESSION_REVOKED);
      }
    }
    // Current role from the DB (role changes apply without a re-login);
    // read by requireModule. The token's role_id is left untouched.
    req.staff_role_id = staff.user_role;
  } catch (err) {
    logger.error(`[auth] staff lookup failed: ${err.message}`);
    return res.status(503).json({ error: 'Service temporarily unavailable. Please retry.' });
  }

  req.login_data = decoded;
  next();
};

module.exports = authenticate;
module.exports.invalidateStaffCache = invalidateStaffCache;
module.exports.isStaffToken = isStaffToken;
