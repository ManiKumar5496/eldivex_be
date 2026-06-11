/**
 * subscriptionRoutes.js — Phase 5.2
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const subscriptionController = require('../controllers/web_app/subscriptionController');

const requireOwner = require('../middlewares/requireOwner');

router.get('/getPlans',               subscriptionController.getPlans);          // public
router.get('/getSubscriptionStatus',  auth, subscriptionController.getSubscriptionStatus);
router.put('/updateOrgPlan',          auth, subscriptionController.updateOrgPlan); // role_id=1 check inside

// ── Plans management (owner platform) ─────────────────────────────────────────
router.get(  '/saas/getPlansWithUsage',   auth, requireOwner, subscriptionController.getPlansWithUsage);
router.post( '/createPlan',               auth, requireOwner, subscriptionController.createPlan);
router.put(  '/updatePlan/:id',           auth, requireOwner, subscriptionController.updatePlan);
router.patch('/togglePlanActive/:id',     auth, requireOwner, subscriptionController.togglePlanActive);

module.exports = router;
