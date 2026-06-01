const express       = require('express');
const router        = express.Router();
const auth          = require('../middlewares/auth');
const requireOwner  = require('../middlewares/requireOwner');
const ctrl          = require('../controllers/web_app/saasAccountsController');

router.get(   '/saas/checkSlugAvailable',           auth, requireOwner, ctrl.checkSlugAvailable);
router.get(   '/saas/checkEmailAvailable',          auth, requireOwner, ctrl.checkEmailAvailable);
router.get(   '/saas/getOrgUsage',                  auth, requireOwner, ctrl.getOrgUsage);
router.get(   '/saas/getSubscriptionHistory',       auth, requireOwner, ctrl.getSubscriptionHistory);
router.patch( '/saas/transitionSubscriptionStatus', auth, requireOwner, ctrl.transitionSubscriptionStatus);
router.post(  '/saas/checkDowngradeViability',      auth, requireOwner, ctrl.checkDowngradeViability);
router.post(  '/saas/generateSaasInvoice',          auth, requireOwner, ctrl.generateSaasInvoice);
router.get(   '/saas/getSaasInvoices',              auth, requireOwner, ctrl.getSaasInvoices);
router.patch( '/saas/markSaasInvoicePaid',          auth, requireOwner, ctrl.markSaasInvoicePaid);
router.get(   '/saas/getAccountHealthSummary',      auth, requireOwner, ctrl.getAccountHealthSummary);

module.exports = router;
