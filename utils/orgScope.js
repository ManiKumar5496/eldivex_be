/**
 * orgScope.js — Phase 5
 *
 * Tiny helpers used by every controller to enforce org-level data isolation.
 *
 * withOrg(req, data)        — Merges org_id into an INSERT payload.
 * orgQuery(req, tableName)  — Returns a Knex query builder pre-scoped to the
 *                             authenticated user's org.
 */

const db = require('../config/db');

// Staff org from the verified JWT. Returns null for owner tokens and when the
// claim is missing — never a default org. Callers treat null as 401.
function getOrgId(req) {
  const d = req.login_data;
  if (!d || d.is_owner === true) return null;
  return d.org_id ?? null;
}

function withOrg(req, data) {
  return { ...data, org_id: getOrgId(req) };
}

function orgQuery(req, tableName) {
  return db(tableName).where('org_id', getOrgId(req));
}

module.exports = { withOrg, orgQuery, getOrgId };
