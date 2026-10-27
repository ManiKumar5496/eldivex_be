/**
 * clientPortalRoutes.js — client (customer) self-service portal.
 *   • Public + rate-limited auth (OTP request/verify). Org resolution reuses
 *     the /org/bySlug & /org/byId endpoints in hpPortalRoutes.
 *   • Everything else behind clientAuth (scopes to req.client = {user_id, org_id}).
 */

const express = require('express');
const router = express.Router();

const { authLimiter } = require('../middlewares/rateLimiter');
const clientAuth = require('../middlewares/clientAuth');
const upload = require('../middlewares/upload');
const clientAuthCtrl = require('../controllers/web_app/clientAuthController');
const c = require('../controllers/web_app/clientPortalController');

// ── Auth (public, brute-force limited) ─────────────────────────────────────────
router.post('/clientAuth/requestOtp', authLimiter, clientAuthCtrl.requestOtp);
router.post('/clientAuth/verifyOtp',  authLimiter, clientAuthCtrl.verifyOtp);

// ── Profile ────────────────────────────────────────────────────────────────────
router.get('/client/me',                 clientAuth, c.getMe);
// JSON body, or multipart with an optional `user_image` file.
router.put('/client/me',                 clientAuth, upload.fields([{ name: 'user_image', maxCount: 1 }]), c.updateMe);

// ── Addresses ──────────────────────────────────────────────────────────────────
router.get('/client/addresses',          clientAuth, c.getAddresses);
router.post('/client/addresses',         clientAuth, c.createAddress);

// ── Bookings ─────────────────────────────────────────────────────────────────
router.get('/client/bookings',           clientAuth, c.getBookings);
router.post('/client/bookings',          clientAuth, c.createBooking);
router.get('/client/bookings/:id',       clientAuth, c.getBookingById);
router.get('/client/bookings/:id/hp',    clientAuth, c.getAssignedHp);
router.get('/client/bookings/:id/attendance', clientAuth, c.getBookingAttendance);

// ── Patients ─────────────────────────────────────────────────────────────────
router.get('/client/patients',           clientAuth, c.getPatients);
router.put('/client/patients/:id',       clientAuth, c.updatePatient);

// ── Support ────────────────────────────────────────────────────────────────────
router.get('/client/support/categories', clientAuth, c.getSupportCategories);
router.post('/client/support',           clientAuth, c.createSupport);
router.get('/client/support',            clientAuth, c.getSupport);

// ── Accounts (read-only) ──────────────────────────────────────────────────────
router.get('/client/invoices',           clientAuth, c.getInvoices);
router.get('/client/receipts',           clientAuth, c.getReceipts);
router.get('/client/outstanding',        clientAuth, c.getOutstanding);

module.exports = router;
