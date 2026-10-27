/**
 * requireModule(...names) — server-side module RBAC for tenant routes.
 *
 * Usage:  router.get('/x', auth, requireStaff, requireModule('Billing'), handler)
 *
 * The caller's role (edx_web_emp_roles.access_list, CSV of edx_web_module ids)
 * is mapped to module names; the request passes if ANY of `names` is granted.
 * Names match the side-menu gates in the web app: Home, Billing, Users,
 * Bookings, HP Modules, Support Ticket, Settings.
 *
 * Uses the role from the DB as loaded by auth (req.staff_role_id), falling
 * back to the token's role_id. Results are cached per org+role for CACHE_TTL_MS.
 * Must be placed after auth + requireStaff.
 */

const db     = require('../config/db');
const logger = require('../logger');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // `${orgId}:${roleId}` -> { names:Set, ts }

const FORBIDDEN = { error: 'You do not have access to this feature', code: 'MODULE_FORBIDDEN' };

const norm = (s) => String(s || '').trim().toLowerCase();

function invalidateModuleCache() {
  cache.clear();
}

async function loadModuleNames(orgId, roleId) {
  const key = `${orgId}:${roleId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.names;

  const names = new Set();
  const role = await db('edx_web_emp_roles')
    .where({ id: roleId, org_id: orgId })
    .first('access_list', 'status');

  if (role && String(role.status ?? '1') === '1') {
    const ids = String(role.access_list || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n));
    if (ids.length) {
      const mods = await db('edx_web_module').whereIn('id', ids).select('module_name');
      mods.forEach((m) => names.add(norm(m.module_name)));
    }
  }

  cache.set(key, { names, ts: Date.now() });
  return names;
}

function requireModule(...allowed) {
  const wanted = allowed.map(norm);
  return async (req, res, next) => {
    const d = req.login_data;
    if (!d || d.is_owner === true || !d.org_id) {
      return res.status(403).json({ error: 'Staff access required' });
    }
    const roleId = parseInt(req.staff_role_id ?? d.role_id, 10);
    if (!Number.isInteger(roleId)) return res.status(403).json(FORBIDDEN);

    try {
      const names = await loadModuleNames(Number(d.org_id), roleId);
      if (wanted.some((w) => names.has(w))) return next();
      return res.status(403).json(FORBIDDEN);
    } catch (err) {
      logger.error(`[requireModule] error: ${err.message}`);
      return res.status(503).json({ error: 'Service temporarily unavailable. Please retry.' });
    }
  };
}

module.exports = requireModule;
module.exports.invalidateModuleCache = invalidateModuleCache;
