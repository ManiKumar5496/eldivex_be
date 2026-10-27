/**
 * termsRoutes.js — Terms & Conditions (web admin app).
 * All routes require a valid web session (auth); identity comes from the JWT.
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff = require('../middlewares/requireStaff');
const termsController = require('../controllers/web_app/termsController');

router.get('/getCurrentTerms', auth, requireStaff, termsController.getCurrentTerms);
router.post('/acceptTerms',    auth, requireStaff, termsController.acceptTerms);

module.exports = router;
