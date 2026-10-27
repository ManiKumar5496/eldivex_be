/**
 * reportsRoutes.js — Phase 4.3
 */

const express = require('express');
const router  = express.Router();
const auth      = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');

// Staff-only, Settings module (Reports sits under the Settings gate).
const settings = [auth, requireStaff, requireModule('Settings')];
const planGate  = require('../middlewares/planGate');
const reportsController = require('../controllers/web_app/reportsController');

// GET  /api/generateReport?type=bookings&from=&to=&branch_id=&format=json|csv
router.get('/generateReport', settings, planGate(['Growth', 'Enterprise']), reportsController.generateReport);

// POST /api/configureReportSchedule  { enabled, dayOfWeek, hour, emails }
router.post('/configureReportSchedule', settings, reportsController.configureReportSchedule);

// GET  /api/getScheduledReports
router.get('/getScheduledReports', settings, reportsController.getScheduledReports);

module.exports = router;
