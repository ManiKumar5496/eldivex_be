/**
 * subscriptionRoutes.js — Phase 5.2
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff = require('../middlewares/requireStaff');
const subscriptionController = require('../controllers/web_app/subscriptionController');

const requireOwner = require('../middlewares/requireOwner');

router.get('/getPlans',               subscriptionController.getPlans);          // public
router.get('/getSubscriptionStatus',  auth, requireStaff, subscriptionController.getSubscriptionStatus);
router.put('/updateOrgPlan',          auth, requireOwner, subscriptionController.updateOrgPlan);

// ── Plans management (owner platform) ─────────────────────────────────────────
router.get(  '/saas/getPlansWithUsage',   auth, requireOwner, subscriptionController.getPlansWithUsage);
router.post( '/createPlan',               auth, requireOwner, subscriptionController.createPlan);
router.put(  '/updatePlan/:id',           auth, requireOwner, subscriptionController.updatePlan);
router.patch('/togglePlanActive/:id',     auth, requireOwner, subscriptionController.togglePlanActive);

module.exports = router;
