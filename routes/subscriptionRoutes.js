/**
 * subscriptionRoutes.js — Phase 5.2
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const subscriptionController = require('../controllers/web_app/subscriptionController');

router.get('/getPlans',               subscriptionController.getPlans);          // public
router.get('/getSubscriptionStatus',  auth, subscriptionController.getSubscriptionStatus);
router.put('/updateOrgPlan',          auth, subscriptionController.updateOrgPlan); // role_id=1 check inside

module.exports = router;
