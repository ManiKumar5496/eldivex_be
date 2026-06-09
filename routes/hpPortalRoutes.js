/**
 * hpPortalRoutes.js — caregiver (Health Professional) self-service portal.
 *
 *   • Public + rate-limited auth endpoints (org resolve, OTP request/verify).
 *   • Everything else behind hpAuth, which scopes the caller to their own
 *     hp_id + org_id (set on req.hp).
 */

const express = require('express');
const router = express.Router();

const { authLimiter } = require('../middlewares/rateLimiter');
const hpAuth = require('../middlewares/hpAuth');
const hpAuthCtrl = require('../controllers/web_app/hpAuthController');
const hp = require('../controllers/web_app/hpPortalController');

// ── Auth (public, brute-force limited) ─────────────────────────────────────────
router.get('/org/bySlug/:slug',       hpAuthCtrl.getOrgBySlug);
router.post('/hpAuth/requestOtp',      authLimiter, hpAuthCtrl.requestOtp);
router.post('/hpAuth/verifyOtp',       authLimiter, hpAuthCtrl.verifyOtp);

// ── Profile ────────────────────────────────────────────────────────────────────
router.get('/hp/me',                   hpAuth, hp.getMe);
router.put('/hp/me',                   hpAuth, hp.updateMe);

// ── Bank details ────────────────────────────────────────────────────────────────
router.get('/hp/bank',                 hpAuth, hp.getBank);
router.put('/hp/bank',                 hpAuth, hp.upsertBank);

// ── Bookings ─────────────────────────────────────────────────────────────────
router.get('/hp/bookings',             hpAuth, hp.getBookings);
router.get('/hp/bookings/:id',         hpAuth, hp.getBookingById);

// ── Attendance ─────────────────────────────────────────────────────────────────
router.get('/hp/attendance',           hpAuth, hp.getAttendance);
router.post('/hp/attendance/checkin',  hpAuth, hp.checkIn);
router.post('/hp/attendance/checkout', hpAuth, hp.checkOut);

// ── Earnings ─────────────────────────────────────────────────────────────────
router.get('/hp/earnings/today',       hpAuth, hp.earningsToday);
router.get('/hp/earnings/summary',     hpAuth, hp.earningsSummary);

// ── Payouts / payslips ───────────────────────────────────────────────────────
router.get('/hp/payouts',              hpAuth, hp.getPayouts);
router.get('/hp/payouts/:id',          hpAuth, hp.getPayoutById);

// ── Support ────────────────────────────────────────────────────────────────────
router.get('/hp/support/categories',   hpAuth, hp.getSupportCategories);
router.post('/hp/support',             hpAuth, hp.createSupport);
router.get('/hp/support',              hpAuth, hp.getSupport);

// ── Leave ──────────────────────────────────────────────────────────────────────
router.post('/hp/leave',               hpAuth, hp.requestLeave);
router.get('/hp/leave',                hpAuth, hp.getLeave);

// ── Notifications ────────────────────────────────────────────────────────────
router.get('/hp/notifications',        hpAuth, hp.getNotifications);
router.patch('/hp/notifications/:id/read', hpAuth, hp.markNotificationRead);

module.exports = router;
