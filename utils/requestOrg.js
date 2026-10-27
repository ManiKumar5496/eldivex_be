/**
 * requestOrg.js — org-context helpers shared by tenant controllers.
 *
 * requireOrg(handler)       — wraps a staff handler so it answers 401 when the
 *                             caller has no org context (owner token, missing
 *                             claim). getOrgId never falls back to a default org.
 * guardOrgHandlers(obj, skip) — applies requireOrg to every handler in a
 *                             controller's export object except the names in skip.
 * resolveRequestOrgId(req)  — for PUBLIC endpoints: the org from a tenant token
 *                             (staff / caregiver / client) when present, else an
 *                             explicit ?org_id / ?org_code. Returns null when
 *                             neither is available — callers must refuse rather
 *                             than return every tenant's data.
 */

const jwt = require('jsonwebtoken');
const db  = require('../config/db');
const { getOrgId } = require('./orgScope');
const { resolveOrgId } = require('./orgCode');

const ORG_REQUIRED = { error: 'Organisation context is required.', message: 'Organisation context is required.' };

function requireOrg(handler) {
  return (req, res, next) => {
    if (getOrgId(req) == null) return res.status(401).json(ORG_REQUIRED);
    return handler(req, res, next);
  };
}

function guardOrgHandlers(handlers, skip = []) {
  const out = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = typeof fn === 'function' && !skip.includes(name) ? requireOrg(fn) : fn;
  }
  return out;
}

async function resolveRequestOrgId(req) {
  const authHeader = req.headers?.['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_TOKEN_KEY);
      // Owner tokens carry no tenant; legacy client tokens (role_id null, no role) are not trusted.
      const legacy = decoded.role_id === null && !decoded.role;
      if (decoded.is_owner !== true && !legacy && decoded.org_id != null) return Number(decoded.org_id);
    } catch (_) { /* fall through to the explicit org reference */ }
  }
  const ref = req.query?.org_id ?? req.query?.org_code;
  if (ref != null && ref !== '') return await resolveOrgId(db, ref);
  return null;
}

module.exports = { requireOrg, guardOrgHandlers, resolveRequestOrgId, ORG_REQUIRED };
