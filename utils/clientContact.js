/**
 * clientContact.js — contact details of a CLIENT (edx_client_app_users).
 *
 * edx_bookings.user_id and support-ticket user_id are client ids. They must be
 * resolved against edx_client_app_users within the same org — never
 * edx_web_app_users, whose ids belong to staff (that sent customer mail to an
 * unrelated staff member).
 *
 * Returns { user_name, user_email, user_mobile } or null. 'NA' placeholders are
 * normalised to null.
 */

const db = require('../config/db');
const logger = require('../logger');

const clean = (v) => (v === undefined || v === null || v === '' || v === 'NA' ? null : v);

// Never throws: callers are fire-and-forget notifications.
async function getClientContact(clientId, orgId, conn = db) {
  if (clientId == null || clientId === 'NA' || orgId == null) return null;
  let row;
  try {
    row = await conn('edx_client_app_users')
      .where({ id: clientId, org_id: orgId })
      .select('user_name', 'user_email', 'phone_number')
      .first();
  } catch (err) {
    logger.warn(`[clientContact] lookup failed for client ${clientId}: ${err.message}`);
    return null;
  }
  if (!row) return null;
  return {
    user_name:   clean(row.user_name),
    user_email:  clean(row.user_email),
    user_mobile: clean(row.phone_number),
  };
}

module.exports = { getClientContact };
