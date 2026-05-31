/**
 * accountsRoutes.js — Phase 2.4 + Advanced Accounts
 * All routes require JWT auth (applied at registration in index.js).
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const ac      = require('../controllers/web_app/accountsController');

// ── Phase 2.4 — Core Accounts ─────────────────────────────────────────────────
router.get('/getActiveClients',       auth, ac.getActiveClients);
router.post('/createReceipt',         auth, ac.createProvisionalReceipt);
router.patch('/updateReceiptStatus',  auth, ac.updateReceiptStatus);
router.get('/getReceipts',            auth, ac.getReceipts);
router.get('/getClientStatements',    auth, ac.getClientStatements);
router.post('/createWriteOff',        auth, ac.createWriteOff);
router.patch('/updateWriteOffStatus', auth, ac.updateWriteOffStatus);
router.get('/getWriteOffs',           auth, ac.getWriteOffs);

// ── Phase A — Invoice List & Credit Notes ─────────────────────────────────────
router.get('/getInvoices',            auth, ac.getInvoices);
router.post('/createCreditNote',      auth, ac.createCreditNote);
router.get('/getCreditNotes',         auth, ac.getCreditNotes);
router.patch('/updateCreditNoteStatus', auth, ac.updateCreditNoteStatus);

// ── Phase A — Cancellation Billing Preview ────────────────────────────────────
router.get('/getCancellationBilling', auth, ac.getCancellationBilling);

// ── Phase B — Collections Engine ──────────────────────────────────────────────
router.get('/getAgingReport',         auth, ac.getAgingReport);
router.get('/getCollectionsKPIs',     auth, ac.getCollectionsKPIs);
router.post('/bulkGenerateInvoices',  auth, ac.bulkGenerateInvoices);

// ── Phase B — Payment Links & Razorpay Webhook ────────────────────────────────
router.post('/createPaymentLink',     auth, ac.createPaymentLink);
// Webhook does NOT use JWT auth — verified by Razorpay signature
router.post('/razorpay/webhook',      ac.razorpayWebhook);

// ── Phase C — Insurance / TPA Claims ─────────────────────────────────────────
router.post('/createInsuranceClaim',   auth, ac.createInsuranceClaim);
router.patch('/updateInsuranceClaim',  auth, ac.updateInsuranceClaim);
router.get('/getInsuranceClaims',      auth, ac.getInsuranceClaims);

// ── Phase C — Period Closing ──────────────────────────────────────────────────
router.post('/closePeriod',           auth, ac.closePeriod);
router.get('/getClosedPeriods',       auth, ac.getClosedPeriods);

// ── Phase C — Revenue Recognition ────────────────────────────────────────────
router.get('/getRevenueRecognition',  auth, ac.getRevenueRecognition);

// ── Phase C — Rate History ────────────────────────────────────────────────────
router.get('/getRateHistory',         auth, ac.getRateHistory);

module.exports = router;
