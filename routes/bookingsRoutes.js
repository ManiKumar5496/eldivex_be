const express = require('express');
const router  = express.Router();
const bookingsController = require('../controllers/web_app/bookingsController');
const validate = require('../middlewares/validateRequest');
const {
  createBookingSchema,
  extendBookingSchema,
  finalBookingSaveSchema,
} = require('../validators/bookingValidator');

// All booking routes are protected by auth applied at index.js level

router.post('/createBooking',     validate(createBookingSchema),     bookingsController.createBooking);
router.post('/extendBooking',     validate(extendBookingSchema),     bookingsController.extendBooking);
router.post('/finalBookingSave',  validate(finalBookingSaveSchema),  bookingsController.finalBookingSave);

router.put('/updateBooking',       bookingsController.updateBooking);
router.put('/updatePatient',       bookingsController.updatePatient);
router.put('/updateHPBooking',     bookingsController.updateHPBooking);
router.post('/holdBooking',        bookingsController.holdBooking);
router.post('/markAttendance',     bookingsController.markAttendance);
router.post('/cancelUserService',  bookingsController.cancelUserService);
router.post('/assignHPToBooking',  bookingsController.assignHPToBooking);
router.get('/getUserBookings',     bookingsController.getUserBookings);
router.get('/getBookingOTP',       bookingsController.getBookingOTP);
router.get('/getHPByBooking',      bookingsController.getHPByBooking);
router.get('/matchHP',             bookingsController.getMatchedHPs);   // Phase 4.4
router.get('/getAttendanceList',   bookingsController.getAttendanceList);

module.exports = router;
