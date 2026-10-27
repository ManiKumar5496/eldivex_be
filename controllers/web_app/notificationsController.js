/**
 * notificationsController — admin in-app notification feed.
 *
 * The admin feed is org-wide: every row with recipient_type 'admin' and
 * recipient_id NULL (or matching the caller) for the caller's org. Read
 * state is shared across the org's admins, matching how small ops teams
 * work a single queue.
 *
 * clearAll / deleteNotification are HARD deletes — the UI warns the user
 * that cleared notifications are permanently removed for the organisation.
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const { getOrgId } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');

// Base scope for every query: the caller's org, admin feed, org-wide rows
// plus rows targeted at this specific user.
function adminScope(req) {
  const userId = req.login_data?.id || 0;
  return db('edx_notifications')
    .where('org_id', getOrgId(req))
    .where('recipient_type', 'admin')
    .where((q) => q.whereNull('recipient_id').orWhere('recipient_id', userId));
}

const getNotifications = async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const [rows, unreadRow] = await Promise.all([
      adminScope(req)
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .select('id', 'type', 'title', 'body', 'data', 'read_flag', 'created_on'),
      adminScope(req).where('read_flag', false).count('id as cnt').first(),
    ]);

    res.json({
      unread_count: Number(unreadRow?.cnt) || 0,
      data: rows,
    });
  } catch (err) {
    logger.error(`Error getNotifications: ${err.message}`);
    res.status(500).json({ message: 'Error fetching notifications.' });
  }
};

const markNotificationRead = async (req, res) => {
  try {
    await adminScope(req).where('id', req.params.id).update({ read_flag: true });
    res.json({ message: 'Notification marked as read.' });
  } catch (err) {
    logger.error(`Error markNotificationRead: ${err.message}`);
    res.status(500).json({ message: 'Error updating notification.' });
  }
};

const markAllNotificationsRead = async (req, res) => {
  try {
    await adminScope(req).where('read_flag', false).update({ read_flag: true });
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    logger.error(`Error markAllNotificationsRead: ${err.message}`);
    res.status(500).json({ message: 'Error updating notifications.' });
  }
};

const deleteNotification = async (req, res) => {
  try {
    await adminScope(req).where('id', req.params.id).del();
    res.json({ message: 'Notification deleted.' });
  } catch (err) {
    logger.error(`Error deleteNotification: ${err.message}`);
    res.status(500).json({ message: 'Error deleting notification.' });
  }
};

const clearAllNotifications = async (req, res) => {
  try {
    const deleted = await adminScope(req).del();
    res.json({ message: 'All notifications cleared.', deleted });
  } catch (err) {
    logger.error(`Error clearAllNotifications: ${err.message}`);
    res.status(500).json({ message: 'Error clearing notifications.' });
  }
};

module.exports = guardOrgHandlers({
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
});
