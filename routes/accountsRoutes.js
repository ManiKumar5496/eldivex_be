/**
 * accountsRoutes.js — Phase 2.4 + Advanced Accounts
 * Staff-only, gated to the Billing module. The Razorpay webhook is public
 * (verified by signature in the handler).
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const ac      = require('../controllers/web_app/accountsController');

const billing = [auth, requireStaff, requireModule('Billing')];

// ── Phase 2.4 — Core Accounts ─────────────────────────────────────────────────
router.get('/getActiveClients',       billing, ac.getActiveClients);
router.post('/createReceipt',         billing, ac.createProvisionalReceipt);
router.patch('/updateReceiptStatus',  billing, ac.updateReceiptStatus);
router.get('/getReceipts',            billing, ac.getReceipts);
router.get('/getClientStatements',    billing, ac.getClientStatements);
router.post('/createWriteOff',        billing, ac.createWriteOff);
router.patch('/updateWriteOffStatus', billing, ac.updateWriteOffStatus);
router.get('/getWriteOffs',           billing, ac.getWriteOffs);

// ── Phase A — Invoice List & Credit Notes ─────────────────────────────────────
router.get('/getInvoices',            billing, ac.getInvoices);
router.post('/createCreditNote',      billing, ac.createCreditNote);
router.get('/getCreditNotes',         billing, ac.getCreditNotes);
router.patch('/updateCreditNoteStatus', billing, ac.updateCreditNoteStatus);

// ── Phase A — Cancellation Billing Preview ────────────────────────────────────
router.get('/getCancellationBilling', billing, ac.getCancellationBilling);

// ── Phase B — Collections Engine ──────────────────────────────────────────────
router.get('/getAgingReport',         billing, ac.getAgingReport);
router.get('/getCollectionsKPIs',     billing, ac.getCollectionsKPIs);
router.post('/bulkGenerateInvoices',  billing, ac.bulkGenerateInvoices);

// ── Phase B — Payment Links & Razorpay Webhook ────────────────────────────────
router.post('/createPaymentLink',     billing, ac.createPaymentLink);
// Webhook does NOT use JWT auth — verified by Razorpay signature
router.post('/razorpay/webhook',      ac.razorpayWebhook);

// ── Phase C — Insurance / TPA Claims ─────────────────────────────────────────
router.post('/createInsuranceClaim',   billing, ac.createInsuranceClaim);
router.patch('/updateInsuranceClaim',  billing, ac.updateInsuranceClaim);
router.get('/getInsuranceClaims',      billing, ac.getInsuranceClaims);

// ── Phase C — Period Closing ──────────────────────────────────────────────────
router.post('/closePeriod',           billing, ac.closePeriod);
router.get('/getClosedPeriods',       billing, ac.getClosedPeriods);

// ── Phase C — Revenue Recognition ────────────────────────────────────────────
router.get('/getRevenueRecognition',  billing, ac.getRevenueRecognition);

// ── Phase C — Rate History ────────────────────────────────────────────────────
// Rate history is also shown from the Bookings detail screen.
router.get('/getRateHistory',         [auth, requireStaff, requireModule('Billing', 'Bookings')], ac.getRateHistory);

// ── Phase 2.4 Extension — Transaction Ledger, Write-Off V2, Refund,
//    Credit Note Application, Internal Transfer  (Added 2026-06-06) ──────────
router.get('/transactionLedger',                billing, ac.getTransactionLedger);
router.get('/clientOutstanding/:clientId',      billing, ac.getClientOutstanding);
router.get('/bookingOutstanding/:bookingId',    billing, ac.getBookingOutstanding);
router.post('/createWriteOffV2',               billing, ac.createWriteOffV2);
router.patch('/approveWriteOff',               billing, ac.approveWriteOff);
router.post('/createRefund',                   billing, ac.createRefund);
router.get('/getRefunds',                      billing, ac.getRefunds);
router.get('/getRefundById/:id',               billing, ac.getRefundById);
router.patch('/approveRefund',                 billing, ac.approveRefund);
router.get('/getCreditNoteApplications',       billing, ac.getCreditNoteApplications);
router.post('/createInternalTransfer',         billing, ac.createInternalTransfer);
router.get('/getInternalTransfers',            billing, ac.getInternalTransfers);
router.patch('/approveInternalTransfer',       billing, ac.approveInternalTransfer);

module.exports = router;
