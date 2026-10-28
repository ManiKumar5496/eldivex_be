/**
 * requireSuperAdmin — the caller's role in their organisation is named
 * "Super Admin": org 1's role 1, or the Super Admin role createOrganisation
 * gives every new org. Used for org-level decisions such as the plan.
 *
 * Reads the role from the DB as loaded by auth (req.staff_role_id), falling
 * back to the token's role_id. Must be placed after auth + requireStaff.
 */
const db = require('../config/db');
const logger = require('../logger');
const { getOrgId } = require('../utils/orgScope');

const FORBIDDEN = { error: 'Only your Super Admin can do this.', code: 'SUPER_ADMIN_ONLY' };

async function isSuperAdmin(req) {
  const roleId = req.staff_role_id ?? req.login_data?.role_id;
  const orgId = getOrgId(req);
  if (roleId == null || orgId == null) return false;
  const role = await db('edx_web_emp_roles').where({ id: roleId, org_id: orgId }).first('role_name');
  return String(role?.role_name || '').trim().toLowerCase() === 'super admin';
}

async function requireSuperAdmin(req, res, next) {
  try {
    if (await isSuperAdmin(req)) return next();
    return res.status(403).json(FORBIDDEN);
  } catch (err) {
    logger.error(`[requireSuperAdmin] ${err.message}`);
    return res.status(500).json({ error: 'Could not verify your role.' });
  }
}

module.exports = requireSuperAdmin;
module.exports.isSuperAdmin = isSuperAdmin;
