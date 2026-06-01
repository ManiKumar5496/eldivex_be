/**
 * leadsRoutes.js
 * Public lead capture — no auth required.
 */

const express     = require('express');
const rateLimit   = require('express-rate-limit');
const router      = express.Router();
const { captureLead } = require('../controllers/web_app/leadsController');

const leadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many lead submissions. Please try again shortly.' },
});

router.post('/leads/capture', leadLimiter, captureLead);

module.exports = router;
