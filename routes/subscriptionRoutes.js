/**
 * subscriptionRoutes.js — Phase 5.2
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff = require('../middlewares/requireStaff');
const subscriptionController = require('../controllers/web_app/subscriptionController');
const planRequests = require('../controllers/web_app/planRequestController');

const requireOwner = require('../middlewares/requireOwner');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin');

// The org's own plan: its Super Admin views it and asks to extend / change it.
const superAdmin = [auth, requireStaff, requireSuperAdmin];

router.get('/getPlans',               subscriptionController.getPlans);          // public
router.get('/getSubscriptionStatus',  auth, requireStaff, subscriptionController.getSubscriptionStatus);
router.put('/updateOrgPlan',          auth, requireOwner, subscriptionController.updateOrgPlan);

// ── Plans management (owner platform) ─────────────────────────────────────────
router.get(  '/saas/getPlansWithUsage',   auth, requireOwner, subscriptionController.getPlansWithUsage);
router.post( '/createPlan',               auth, requireOwner, subscriptionController.createPlan);
router.put(  '/updatePlan/:id',           auth, requireOwner, subscriptionController.updatePlan);
router.patch('/togglePlanActive/:id',     auth, requireOwner, subscriptionController.togglePlanActive);

// ── Plan extension requests ──────────────────────────────────────────────────
router.get(  '/getPlanOverview',          superAdmin, planRequests.getPlanOverview);
router.post( '/requestPlanExtension',     superAdmin, planRequests.requestPlanExtension);
router.patch('/cancelPlanRequest/:id',    superAdmin, planRequests.cancelPlanRequest);
router.get(  '/saas/getPlanRequests',     auth, requireOwner, planRequests.getPlanRequests);
router.patch('/saas/resolvePlanRequest/:id', auth, requireOwner, planRequests.resolvePlanRequest);

module.exports = router;
