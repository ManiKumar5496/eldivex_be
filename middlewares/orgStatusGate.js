/**
 * orgStatusGate.js — organisation kill-switch.
 *
 * Blocks every request belonging to a suspended/cancelled organisation with
 * 403 { code: 'ORG_SUSPENDED' } so disabling an org from the owner platform
 * locks out its users immediately — including sessions whose JWT is still valid.
 *
 * Mounted globally on /api BEFORE the route files, so it decodes the token
 * itself (all three session types — admin, caregiver, client — share
 * JWT_TOKEN_KEY and carry org_id). It never rejects on auth problems:
 * missing/invalid tokens fall through to each route's own auth middleware.
 *
 * Bypasses:
 *  - no/invalid token (public routes; route auth handles the rest)
 *  - platform owner (is_owner JWT claim from /ownerLogin — NOT role_id;
 *    "Super Admin" role 1 is just the eldivex_web tenant's admin role)
 *  - login/public paths (their controllers do their own org-status checks,
 *    and a stale token in the header must not block a fresh login)
 *
 * Org status is cached in-process for CACHE_TTL_MS; status writes must call
 * invalidateOrgStatusCache(orgId) so suspension takes effect immediately.
 * Fails open on DB errors so a transient outage never locks tenants out.
 */

const jwt    = require('jsonwebtoken');
const db     = require('../config/db');
const logger = require('../logger');
require('dotenv').config();

const JWT_TOKEN_KEY = process.env.JWT_TOKEN_KEY;
const CACHE_TTL_MS  = 60 * 1000;

const BLOCKED_STATUSES = ['suspended', 'cancelled'];

// Public / login path prefixes the gate must never block.
const SKIP_PREFIXES = [
  '/loginWeb',
  '/ownerLogin',
  '/login',
  '/forgotPassword',
  '/resetPassword',
  '/hpAuth/',
  '/clientAuth/',
  '/leads/',
  '/org/bySlug/',
  '/org/byId/',
  '/getPlans',
];

const statusCache = new Map(); // orgId -> { status, ts }

function invalidateOrgStatusCache(orgId) {
  if (orgId === undefined || orgId === null) {
    statusCache.clear();
  } else {
    statusCache.delete(Number(orgId));
  }
}

async function getOrgStatus(orgId) {
  const cached = statusCache.get(orgId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.status;

  const org = await db('edx_organizations').where('id', orgId).select('status').first();
  const status = org ? org.status : null; // unknown org -> no block (fail open)
  statusCache.set(orgId, { status, ts: Date.now() });
  return status;
}

const orgStatusGate = async (req, res, next) => {
  try {
    const skip = SKIP_PREFIXES.some((p) =>
      p.endsWith('/') ? req.path.startsWith(p) : req.path === p
    );
    if (skip) return next();

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return next();

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_TOKEN_KEY);
    } catch {
      return next(); // invalid/expired — route auth produces the proper error
    }

    // Platform owner is never gated (is_owner claim only — tenant roles,
    // including role 1 "Super Admin" of eldivex_web, are all gated)
    if (decoded.is_owner === true) return next();

    const orgId = Number(decoded.org_id ?? 1);
    const status = await getOrgStatus(orgId);

    if (status && BLOCKED_STATUSES.includes(status)) {
      return res.status(403).json({
        code: 'ORG_SUSPENDED',
        message: 'Your organisation account has been suspended. Please contact support.',
      });
    }

    next();
  } catch (err) {
    // Fail open: a gate failure must never lock out tenants
    logger.error(`[orgStatusGate] error: ${err.message}`);
    next();
  }
};

module.exports = orgStatusGate;
module.exports.invalidateOrgStatusCache = invalidateOrgStatusCache;
