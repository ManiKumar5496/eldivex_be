/**
 * notify.js — in-app notification producer.
 *
 * createNotification() inserts one row into edx_notifications. It never
 * throws: producers are fire-and-forget side effects of business actions and
 * must not fail the request that triggered them.
 *
 * dedupeKey lets cron producers run idempotently — the unique index on
 * dedupe_key swallows re-inserts (ER_DUP_ENTRY is treated as "already sent").
 *
 * notifyOrgAdmins() is the common case: an org-wide row every admin of the
 * org sees (recipient_id NULL).
 */

const db     = require('../config/db');
const logger = require('../logger');
const { getCurrentDateTime } = require('./dateTime');

async function createNotification({
  orgId,
  recipientType = 'admin',
  recipientId   = null,
  type          = 'system',
  title,
  body      = '',
  data      = null,
  dedupeKey = null,
}) {
  try {
    if (!title) return null;
    if (!orgId) {
      // Never default to an org: an org-less notification would land in org 1's feed.
      logger.warn(`[notify] skipped — no org for ${type} "${String(title).slice(0, 60)}"`);
      return null;
    }
    const [id] = await db('edx_notifications').insert({
      org_id:         orgId,
      recipient_type: recipientType,
      recipient_id:   recipientId,
      type,
      title:      String(title).slice(0, 200),
      body:       body ? String(body).slice(0, 500) : null,
      data:       data ? JSON.stringify(data) : null,
      dedupe_key: dedupeKey,
      read_flag:  false,
      created_on: getCurrentDateTime(),
    });
    return id;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null; // dedupe hit — already notified
    logger.warn(`[notify] insert failed (${type} / org ${orgId}): ${err.message}`);
    return null;
  }
}

function notifyOrgAdmins(orgId, fields) {
  return createNotification({ orgId, recipientType: 'admin', ...fields });
}

module.exports = { createNotification, notifyOrgAdmins };
