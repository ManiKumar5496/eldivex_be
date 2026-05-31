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

function getOrgId(req) {
  return req.login_data?.org_id ?? 1;
}

function withOrg(req, data) {
  return { ...data, org_id: getOrgId(req) };
}

function orgQuery(req, tableName) {
  return db(tableName).where('org_id', getOrgId(req));
}

module.exports = { withOrg, orgQuery, getOrgId };
