const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const { getDashboardStats } = require('../controllers/web_app/dashboardController');

// GET /api/getDashboardStats?from=YYYY-MM-DD&to=YYYY-MM-DD&branch_id=N
router.get('/getDashboardStats', auth, getDashboardStats);

module.exports = router;
