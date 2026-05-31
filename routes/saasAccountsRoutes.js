const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const ctrl    = require('../controllers/web_app/saasAccountsController');

// All SaaS account routes require authentication.
// Superadmin check is done inside each controller handler.

router.get(   '/saas/checkSlugAvailable',          auth, ctrl.checkSlugAvailable);
router.get(   '/saas/checkEmailAvailable',         auth, ctrl.checkEmailAvailable);
router.get(   '/saas/getOrgUsage',                 auth, ctrl.getOrgUsage);
router.get(   '/saas/getSubscriptionHistory',      auth, ctrl.getSubscriptionHistory);
router.patch( '/saas/transitionSubscriptionStatus',auth, ctrl.transitionSubscriptionStatus);
router.post(  '/saas/checkDowngradeViability',     auth, ctrl.checkDowngradeViability);
router.post(  '/saas/generateSaasInvoice',         auth, ctrl.generateSaasInvoice);
router.get(   '/saas/getSaasInvoices',             auth, ctrl.getSaasInvoices);
router.patch( '/saas/markSaasInvoicePaid',         auth, ctrl.markSaasInvoicePaid);
router.get(   '/saas/getAccountHealthSummary',     auth, ctrl.getAccountHealthSummary);

module.exports = router;
