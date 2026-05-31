/**
 * reportsRoutes.js — Phase 4.3
 */

const express = require('express');
const router  = express.Router();
const auth      = require('../middlewares/auth');
const planGate  = require('../middlewares/planGate');
const reportsController = require('../controllers/web_app/reportsController');

// GET  /api/generateReport?type=bookings&from=&to=&branch_id=&format=json|csv
router.get('/generateReport', auth, planGate(['Growth', 'Enterprise']), reportsController.generateReport);

// POST /api/configureReportSchedule  { enabled, dayOfWeek, hour, emails }
router.post('/configureReportSchedule', auth, reportsController.configureReportSchedule);

// GET  /api/getScheduledReports
router.get('/getScheduledReports', auth, reportsController.getScheduledReports);

module.exports = router;
