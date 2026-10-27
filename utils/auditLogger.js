/**
 * auditLogger.js — Phase 4.2
 *
 * Fire-and-forget audit log writer.
 * Call logAudit() anywhere after the HTTP response is sent;
 * it schedules the DB insert via setImmediate so it never blocks
 * the response or propagates errors to the caller.
 *
 * Usage:
 *   const { logAudit } = require('../../utils/auditLogger');
 *
 *   logAudit({
 *     entityType: 'BOOKING',          // 'BOOKING' | 'HP' | 'SUPPORT_TICKET' | 'SERVICE' | 'BRANCH'
 *     entityId:   booking_id,          // PK of the changed record
 *     action:     'CREATE',            // 'CREATE' | 'UPDATE' | 'STATUS_CHANGE' | 'DELETE'
 *     changedBy:  req.login_data?.id,  // web_app_users.id (may be null)
 *     org_id:     getOrgId(req),       // required — the row is skipped when unknown
 *     oldValues:  null,                // object snapshot before (omit / null for CREATE)
 *     newValues:  { status: 'HOLD' },  // object snapshot after
 *   });
 */

const db     = require('../config/db');
const logger = require('../logger');

/**
 * @param {Object}      entry
 * @param {string}      entry.entityType
 * @param {number|null} entry.entityId
 * @param {string}      entry.action
 * @param {number|null} entry.changedBy
 * @param {Object|null} entry.oldValues
 * @param {Object|null} entry.newValues
 */
function logAudit({ entityType, entityId, action, changedBy, org_id, oldValues, newValues }) {
  // Never attribute a row to a default org. Tenant callers pass the JWT org,
  // owner actions pass the target org (or 0 for platform-level entities such
  // as plans). Unknown org → skip rather than pollute org 1's trail.
  if (org_id === undefined || org_id === null || org_id === '') {
    logger.warn(`[audit] skipped — no org for ${entityType}:${entityId} (${action})`);
    return;
  }
  setImmediate(async () => {
    try {
      // Resolve display name from DB (non-blocking, best-effort)
      let changedByName = null;
      if (changedBy) {
        const user = await db('edx_web_app_users')
          .where({ id: changedBy })
          .select('user_name')
          .first();
        changedByName = user?.user_name || null;
      }

      await db('edx_audit_log').insert({
        entity_type:     entityType,
        entity_id:       entityId       ?? null,
        action,
        changed_by:      changedBy      ?? null,
        changed_by_name: changedByName,
        old_values:      oldValues  ? JSON.stringify(oldValues)  : null,
        new_values:      newValues  ? JSON.stringify(newValues)  : null,
        org_id:          org_id,
        created_on:      db.fn.now(),
      });
    } catch (e) {
      logger.warn(`[audit] write failed (entity=${entityType}:${entityId}, action=${action}): ${e.message}`);
    }
  });
}

module.exports = { logAudit };
