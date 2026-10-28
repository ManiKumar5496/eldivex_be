const express = require('express');
const router  = express.Router();
const bookingsController = require('../controllers/web_app/bookingsController');
const validate = require('../middlewares/validateRequest');
const auth          = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const {
  createBookingSchema,
  extendBookingSchema,
  finalBookingSaveSchema,
} = require('../validators/bookingValidator');

// Staff-only. Bookings module; HP Management screens (attendance, assign/match
// HP) also call the HP-facing routes, and Settings → OTP reads booking OTPs.
const bookings   = [auth, requireStaff, requireModule('Bookings')];
const bookingsHp = [auth, requireStaff, requireModule('Bookings', 'HP Modules')];
const bookingOtp = [auth, requireStaff, requireModule('Bookings', 'Settings')];

router.post('/createBooking',     bookings, validate(createBookingSchema),     bookingsController.createBooking);
router.post('/extendBooking',     bookings, validate(extendBookingSchema),     bookingsController.extendBooking);
router.post('/finalBookingSave',  bookings, validate(finalBookingSaveSchema),  bookingsController.finalBookingSave);

router.put('/updateBooking',       bookings, bookingsController.updateBooking);
router.put('/updatePatient',       bookings, bookingsController.updatePatient);
router.put('/updateHPBooking',     bookings, bookingsController.updateHPBooking);
router.post('/holdBooking',        bookings, bookingsController.holdBooking);
router.post('/markAttendance',      bookingsHp, bookingsController.markAttendance);
router.post('/markAttendanceBatch', bookingsHp, bookingsController.markAttendanceBatch);
router.post('/cancelUserService',  bookings, bookingsController.cancelUserService);
router.post('/assignHPToBooking',  bookings, bookingsController.assignHPToBooking);
router.get('/getUserBookings',     bookings, bookingsController.getUserBookings);
router.get('/getBookingOTP',       bookingOtp, bookingsController.getBookingOTP);
router.get('/getHPByBooking',      bookingsHp, bookingsController.getHPByBooking);
router.get('/matchHP',             bookingsHp, bookingsController.getMatchedHPs);   // Phase 4.4
router.get('/getAttendanceList',   bookingsHp, bookingsController.getAttendanceList);
router.get('/getBookingOpenTickets', bookings, bookingsController.getBookingOpenTickets);

module.exports = router;
