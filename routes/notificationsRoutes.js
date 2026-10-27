const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff = require('../middlewares/requireStaff');
const notificationsController = require('../controllers/web_app/notificationsController');

router.get('/notifications', auth, requireStaff, notificationsController.getNotifications);
router.patch('/notifications/readAll', auth, requireStaff, notificationsController.markAllNotificationsRead);
router.patch('/notifications/:id/read', auth, requireStaff, notificationsController.markNotificationRead);
// clearAll must be registered before /:id so it isn't captured as an id.
router.delete('/notifications/clearAll', auth, requireStaff, notificationsController.clearAllNotifications);
router.delete('/notifications/:id', auth, requireStaff, notificationsController.deleteNotification);

module.exports = router;
