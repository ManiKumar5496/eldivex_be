/**
 * bookingStatus.js — edx_bookings.status codes.
 *
 * status is a numeric VARCHAR ('1'..'7'), never a word. Every comparison must
 * use these codes; legacy strings like 'Active' / 'Cancelled' match nothing.
 *
 *   1 Booking Submitted   — createBooking
 *   2 HP Assigned         — assignHPToBooking
 *   3 Booking Cancelled   — cancelled before service started
 *   4 Service Started     — finalBookingSave (OTP verified, invoice raised)
 *   5 On Hold             — holdBooking
 *   6 Service Cancelled   — cancelUserService
 *   7 Suspended
 */

const BOOKING_STATUS = Object.freeze({
  SUBMITTED:         '1',
  HP_ASSIGNED:       '2',
  BOOKING_CANCELLED: '3',
  SERVICE_STARTED:   '4',
  ON_HOLD:           '5',
  SERVICE_CANCELLED: '6',
  SUSPENDED:         '7',
});

// Bookings that occupy a caregiver (used for availability / conflict checks).
const ENGAGED_BOOKING_STATUSES = [BOOKING_STATUS.HP_ASSIGNED, BOOKING_STATUS.SERVICE_STARTED, BOOKING_STATUS.ON_HOLD];

// Bookings that no longer count towards usage.
const CANCELLED_BOOKING_STATUSES = [BOOKING_STATUS.BOOKING_CANCELLED, BOOKING_STATUS.SERVICE_CANCELLED];

module.exports = { BOOKING_STATUS, ENGAGED_BOOKING_STATUSES, CANCELLED_BOOKING_STATUSES };
