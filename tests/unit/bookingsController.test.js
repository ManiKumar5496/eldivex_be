'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../config/db');
jest.mock('../../utils/withTransaction');
jest.mock('../../utils/emailService',   () => ({ sendEmail: jest.fn() }));
jest.mock('../../utils/smsService',     () => ({ sendOTP: jest.fn() }));
jest.mock('../../utils/auditLogger',    () => ({ logAudit: jest.fn() }));
jest.mock('../../utils/orgScope',       () => ({
  withOrg:  jest.fn((req, data) => ({ ...data, org_id: 1 })),
  getOrgId: jest.fn(() => 1),
  orgQuery: jest.fn(),
}));
jest.mock('../../utils/dateTime',       () => ({
  getCurrentDateTime: jest.fn().mockReturnValue('2026-05-25 10:00:00'),
}));
jest.mock('../../logger', () => ({
  error: jest.fn(),
  warn:  jest.fn(),
  info:  jest.fn(),
}));
jest.mock('../../models/web_app/bookingsModel');
jest.mock('../../utils/emailTemplates', () => ({
  bookingConfirmed: jest.fn().mockReturnValue({ subject: 'Booking', html: '' }),
  otpDelivery:      jest.fn().mockReturnValue({ subject: 'OTP',     html: '' }),
  invoiceGenerated: jest.fn().mockReturnValue({ subject: 'Invoice', html: '' }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const db              = require('../../config/db');
const withTransaction = require('../../utils/withTransaction');
const { logAudit }    = require('../../utils/auditLogger');
const getBookings     = require('../../models/web_app/bookingsModel');

const {
  createBooking,
  updatePatient,
  updateBooking,
  updateHPBooking,
  holdBooking,
  assignHPToBooking,
  markAttendance,
  cancelUserService,
  extendBooking,
  finalBookingSave,
  getUserBookings,
  getHPByBooking,
  getBookingOTP,
  getMatchedHPs,
} = require('../../controllers/web_app/bookingsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockReq(body = {}, query = {}, loginData = { id: 99, org_id: 1, branch_access: '1' }) {
  return { body, query, login_data: loginData };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

/**
 * Returns a fluent Knex-like chain that resolves to `value` when awaited or
 * when .first() is called. All chainable methods return `this`.
 */
function chain(value) {
  const p = Promise.resolve(value);
  const q = {
    where:      jest.fn().mockReturnThis(),
    andWhere:   jest.fn().mockReturnThis(),
    whereIn:    jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    leftJoin:   jest.fn().mockReturnThis(),
    join:       jest.fn().mockReturnThis(),
    select:     jest.fn().mockReturnThis(),
    orderBy:    jest.fn().mockReturnThis(),
    limit:      jest.fn().mockReturnThis(),
    first:      jest.fn().mockResolvedValue(value),
    insert:     jest.fn().mockResolvedValue(Array.isArray(value) ? value : [1]),
    update:     jest.fn().mockResolvedValue(1),
    then:       p.then.bind(p),
    catch:      p.catch.bind(p),
    finally:    p.finally.bind(p),
  };
  return q;
}

function setupDbStatics() {
  db.fn        = { now: jest.fn().mockReturnValue('NOW()') };
  db.raw       = jest.fn().mockReturnValue('RAW_EXPR');
  db.transaction = jest.fn();
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-apply orgScope implementations cleared by resetAllMocks
  const { withOrg, getOrgId } = require('../../utils/orgScope');
  withOrg.mockImplementation((req, data) => ({ ...data, org_id: 1 }));
  getOrgId.mockReturnValue(1);
  setupDbStatics();
});

// ─────────────────────────────────────────────────────────────────────────────
// createBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('createBooking', () => {
  function setupTrx(patientId = 10, bookingId = 99) {
    const insertMock = jest.fn()
      .mockResolvedValueOnce([patientId])
      .mockResolvedValueOnce([bookingId]);
    const trx = jest.fn().mockReturnValue({
      insert: insertMock,
      where:  jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    });
    withTransaction.mockImplementation(async (fn) => { await fn(trx); });
    return { trx, insertMock };
  }

  const validBody = {
    user_id: 1, branch_id: 2, service_type_id: 3,
    service_start_date: '2026-06-01', service_end_date: '2026-06-30',
    base_rate: 500, patient_name: 'Radha Devi',
  };

  test('responds 201 with booking_id on success', async () => {
    setupTrx(10, 99);
    const res = mockRes();
    await createBooking(mockReq(validBody), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ booking_id: 99 }));
  });

  test('calls logAudit with CREATE action', async () => {
    setupTrx();
    const res = mockRes();
    await createBooking(mockReq(validBody), res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CREATE',
      entityType: 'BOOKING',
    }));
  });

  test('inserts into edx_patient then edx_bookings in transaction', async () => {
    const { trx } = setupTrx();
    const res = mockRes();
    await createBooking(mockReq(validBody), res);
    expect(trx).toHaveBeenCalledWith('edx_patient');
    expect(trx).toHaveBeenCalledWith('edx_bookings');
  });

  test('responds 500 when transaction throws', async () => {
    withTransaction.mockRejectedValue(new Error('DB failure'));
    const res = mockRes();
    await createBooking(mockReq(validBody), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePatient
// ─────────────────────────────────────────────────────────────────────────────

describe('updatePatient', () => {
  test('responds 201 on success', async () => {
    db.mockReturnValueOnce(chain(1));
    const res = mockRes();
    await updatePatient(mockReq({ patient_id: 5, patient_name: 'New Name', age: 70 }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Patient updated successfully.' })
    );
  });

  test('responds 500 on DB error', async () => {
    const badChain = chain(null);
    badChain.update = jest.fn().mockRejectedValue(new Error('DB error'));
    db.mockReturnValueOnce(badChain);
    const res = mockRes();
    await updatePatient(mockReq({ patient_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('updateBooking', () => {
  test('responds 400 when booking_id is missing', async () => {
    const res = mockRes();
    await updateBooking(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 404 when booking not found', async () => {
    db.mockReturnValueOnce(chain(null));
    const res = mockRes();
    await updateBooking(mockReq({ booking_id: 99 }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('responds 200 and updates only provided fields', async () => {
    db.mockReturnValueOnce(chain({ id: 5, status: '1' })); // existingBooking
    db.mockReturnValueOnce(chain(1));                       // update
    const res = mockRes();
    await updateBooking(mockReq({ booking_id: 5, base_rate: 600 }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Booking updated successfully' })
    );
  });

  test('updated_fields contains only provided keys', async () => {
    db.mockReturnValueOnce(chain({ id: 5, status: '1' }));
    db.mockReturnValueOnce(chain(1));
    const res = mockRes();
    await updateBooking(mockReq({ booking_id: 5, base_rate: 600, status: '2' }), res);
    const { updated_fields } = res.json.mock.calls[0][0];
    expect(updated_fields).toContain('base_rate');
    expect(updated_fields).toContain('status');
    expect(updated_fields).not.toContain('branch_id'); // not provided
  });

  test('responds 500 on DB error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB down'));
    db.mockReturnValue(errChain);
    const res = mockRes();
    await updateBooking(mockReq({ booking_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateHPBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('updateHPBooking', () => {
  const existingHp = { id: 1, bkng_id: 10, hp_unique_id: 7, status: 1 };

  // Helper: mock the HP-registration update as a separate chain with a spy
  function withHpRegUpdate(hp_reg_status_expected) {
    const updateMock = jest.fn().mockResolvedValue(1);
    db
      .mockReturnValueOnce(chain(existingHp))
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), update: updateMock })
      .mockReturnValueOnce(chain(1));
    return updateMock;
  }

  test('responds 400 when booking_id is missing', async () => {
    const res = mockRes();
    await updateHPBooking(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 404 when HP booking not found', async () => {
    db.mockReturnValueOnce(chain(null));
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 1 }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('status=3: generates OTP and includes it in the update payload', async () => {
    // status=3: only 2 sync DB calls — first() to fetch, update() to save OTP
    // (email/SMS delivery is non-blocking via setImmediate, not awaited)
    db.mockReturnValueOnce(chain(existingHp)); // first() → existing
    db.mockReturnValueOnce(chain(1));           // final booking_hp update
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 3 }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const { updated_fields } = res.json.mock.calls[0][0];
    expect(updated_fields).toContain('otp');
    expect(updated_fields).toContain('status');
  });

  test('status=1: sets hp_reg_status to 6', async () => {
    const updateMock = withHpRegUpdate(6);
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 1 }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ hp_reg_status: 6 }));
  });

  test('status=2: sets hp_reg_status to 6', async () => {
    const updateMock = withHpRegUpdate(6);
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 2 }), res);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ hp_reg_status: 6 }));
  });

  test('status=4: sets hp_reg_status to 5', async () => {
    const updateMock = withHpRegUpdate(5);
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 4 }), res);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ hp_reg_status: 5 }));
  });

  test('status=5: sets hp_reg_status to 1', async () => {
    const updateMock = withHpRegUpdate(1);
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 5 }), res);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ hp_reg_status: 1 }));
  });

  test('responds 500 on DB error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);
    const res = mockRes();
    await updateHPBooking(mockReq({ booking_id: 10, hp_unique_id: 7, status: 1 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// holdBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('holdBooking', () => {
  function setupHoldTrx() {
    const trx = jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue([1]),
      where:  jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    });
    withTransaction.mockImplementation(async (fn) => { await fn(trx); });
    return trx;
  }

  test('responds 201 on success', async () => {
    setupHoldTrx();
    const res = mockRes();
    await holdBooking(
      mockReq({ booking_id: 5, from_date: '2026-07-01', to_date: '2026-07-10', reason: 'Vacation' }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hold Booking created successfully.' })
    );
  });

  test('inserts into edx_hold_booking and updates edx_bookings status to 5', async () => {
    const trx = setupHoldTrx();
    const res = mockRes();
    await holdBooking(mockReq({ booking_id: 5, from_date: '2026-07-01', to_date: '2026-07-10' }), res);
    expect(trx).toHaveBeenCalledWith('edx_hold_booking');
    expect(trx).toHaveBeenCalledWith('edx_bookings');
    const bookingCall = trx.mock.results[trx.mock.calls.findIndex(([t]) => t === 'edx_bookings')];
    expect(bookingCall.value.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: '5' })
    );
  });

  test('responds 500 when transaction throws', async () => {
    withTransaction.mockRejectedValue(new Error('Trx fail'));
    const res = mockRes();
    await holdBooking(mockReq({ booking_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assignHPToBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('assignHPToBooking', () => {
  function setupAssignTrx() {
    const trx = jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue([1]),
      where:  jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    });
    withTransaction.mockImplementation(async (fn) => { await fn(trx); });
    return trx;
  }

  test('responds 400 when booking_id is missing', async () => {
    const res = mockRes();
    await assignHPToBooking(mockReq({ hp_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 400 when hp_id is missing', async () => {
    const res = mockRes();
    await assignHPToBooking(mockReq({ booking_id: 10 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 201 on success', async () => {
    setupAssignTrx();
    const res = mockRes();
    await assignHPToBooking(mockReq({ booking_id: 10, hp_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('inserts into edx_booking_hp and updates booking status to 2', async () => {
    const trx = setupAssignTrx();
    const res = mockRes();
    await assignHPToBooking(mockReq({ booking_id: 10, hp_id: 7 }), res);
    expect(trx).toHaveBeenCalledWith('edx_booking_hp');
    expect(trx).toHaveBeenCalledWith('edx_bookings');
    const bookingsIdx = trx.mock.calls.findIndex(([t]) => t === 'edx_bookings');
    expect(trx.mock.results[bookingsIdx].value.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: '2' })
    );
  });

  test('responds 500 on transaction error', async () => {
    withTransaction.mockRejectedValue(new Error('Trx fail'));
    const res = mockRes();
    await assignHPToBooking(mockReq({ booking_id: 10, hp_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markAttendance
// ─────────────────────────────────────────────────────────────────────────────

describe('markAttendance', () => {
  test('responds 201 on success', async () => {
    db.mockReturnValueOnce(chain(1));
    const res = mockRes();
    await markAttendance(
      mockReq({ booking_id: 5, from_date: '2026-06-01', att_details: 'Present', hp_id: 7 }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Attendance marked successfully.' })
    );
  });

  test('responds 500 on DB error', async () => {
    const badChain = chain(null);
    badChain.insert = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(badChain);
    const res = mockRes();
    await markAttendance(mockReq({ booking_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelUserService
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelUserService', () => {
  function setupCancelTrx() {
    const trx = jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue([1]),
      where:  jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    });
    withTransaction.mockImplementation(async (fn) => { await fn(trx); });
    return trx;
  }

  test('responds 201 on success', async () => {
    setupCancelTrx();
    const res = mockRes();
    await cancelUserService(
      mockReq({ booking_id: 5, term_date: '2026-06-15', term_reason: 'No longer needed' }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Service cancelled successfully.' })
    );
  });

  test('inserts into edx_service_closed and sets booking status to 6', async () => {
    const trx = setupCancelTrx();
    const res = mockRes();
    await cancelUserService(mockReq({ booking_id: 5 }), res);
    expect(trx).toHaveBeenCalledWith('edx_service_closed');
    expect(trx).toHaveBeenCalledWith('edx_bookings');
    const bookingsIdx = trx.mock.calls.findIndex(([t]) => t === 'edx_bookings');
    expect(trx.mock.results[bookingsIdx].value.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: '6' })
    );
  });

  test('responds 500 on transaction error', async () => {
    withTransaction.mockRejectedValue(new Error('Trx fail'));
    const res = mockRes();
    await cancelUserService(mockReq({ booking_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extendBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('extendBooking', () => {
  const bookingRow = { id: 5, final_rate: '100' };

  function setupExtendTrx() {
    const trx = jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue([77]),
      where:  jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    });
    withTransaction.mockImplementation(async (fn) => { await fn(trx); });
    return trx;
  }

  test('responds 400 when from_date or to_date missing', async () => {
    const res = mockRes();
    await extendBooking(mockReq({ booking_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 404 when booking not found', async () => {
    db.mockReturnValueOnce(chain(null));
    const res = mockRes();
    await extendBooking(
      mockReq({ booking_id: 99, from_date: '2026-07-01', to_date: '2026-07-05' }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('calculates 5 days × rate=100 → inv_raised_amnt=500', async () => {
    db.mockReturnValueOnce(chain(bookingRow));
    setupExtendTrx();
    const res = mockRes();
    await extendBooking(
      mockReq({ booking_id: 5, from_date: '2026-07-01', to_date: '2026-07-05' }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ total_days: 5, inv_raised_amnt: 500 })
    );
  });

  test('calculates 10 days correctly', async () => {
    db.mockReturnValueOnce(chain({ id: 5, final_rate: '200' }));
    setupExtendTrx();
    const res = mockRes();
    await extendBooking(
      mockReq({ booking_id: 5, from_date: '2026-06-01', to_date: '2026-06-10' }),
      res
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ total_days: 10, inv_raised_amnt: 2000 })
    );
  });

  test('does NOT update edx_booking_hp when hp_unique_id is absent', async () => {
    db.mockReturnValueOnce(chain(bookingRow));
    const trx = setupExtendTrx();
    const res = mockRes();
    await extendBooking(
      mockReq({ booking_id: 5, from_date: '2026-07-01', to_date: '2026-07-05' }),
      res
    );
    const hpCall = trx.mock.calls.find(([t]) => t === 'edx_booking_hp');
    expect(hpCall).toBeUndefined();
  });

  test('updates edx_booking_hp when hp_unique_id is provided', async () => {
    db.mockReturnValueOnce(chain(bookingRow));
    const trx = setupExtendTrx();
    const res = mockRes();
    await extendBooking(
      mockReq({ booking_id: 5, from_date: '2026-07-01', to_date: '2026-07-05', hp_unique_id: 7 }),
      res
    );
    const hpCall = trx.mock.calls.find(([t]) => t === 'edx_booking_hp');
    expect(hpCall).toBeDefined();
  });

  test('responds 500 on transaction error', async () => {
    db.mockReturnValueOnce(chain(bookingRow));
    withTransaction.mockRejectedValue(new Error('Trx fail'));
    const res = mockRes();
    await extendBooking(
      mockReq({ booking_id: 5, from_date: '2026-07-01', to_date: '2026-07-05' }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finalBookingSave
// ─────────────────────────────────────────────────────────────────────────────

describe('finalBookingSave', () => {
  const validHpBooking = { bkng_id: 1, hp_unique_id: 7, otp: '482910', otp_verified: 0 };
  const validBooking   = {
    id: 1, user_id: 3,
    service_start_date: '2026-06-01',
    service_end_date:   '2026-06-10',
    final_rate: 200,
  };

  function buildTrxMock(hpBookingRow, bookingRow) {
    const firstMock = jest.fn()
      .mockResolvedValueOnce(hpBookingRow)
      .mockResolvedValueOnce(bookingRow);

    const trxFn = jest.fn().mockReturnValue({
      where:  jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
      insert: jest.fn().mockResolvedValue([55]),
      first:  firstMock,
    });
    trxFn.commit   = jest.fn().mockResolvedValue(undefined);
    trxFn.rollback = jest.fn().mockResolvedValue(undefined);
    db.transaction = jest.fn().mockResolvedValue(trxFn);
    return trxFn;
  }

  test('responds 400 when OTP is invalid', async () => {
    buildTrxMock(null, null);
    const res = mockRes();
    await finalBookingSave(mockReq({ booking_id: 1, otp: '000000', hp_unique_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid OTP' }));
  });

  test('responds 400 when OTP already verified', async () => {
    buildTrxMock({ ...validHpBooking, otp_verified: 1 }, null);
    const res = mockRes();
    await finalBookingSave(mockReq({ booking_id: 1, otp: '482910', hp_unique_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'OTP already verified' }));
  });

  test('responds 200 with invoice_id=55, total_days=10, invoice_amount=2000', async () => {
    buildTrxMock(validHpBooking, validBooking);
    const res = mockRes();
    await finalBookingSave(mockReq({ booking_id: 1, otp: '482910', hp_unique_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id:     55,
      total_days:     10,
      invoice_amount: 2000,
    }));
  });

  test('commits transaction on success', async () => {
    const trxFn = buildTrxMock(validHpBooking, validBooking);
    const res = mockRes();
    await finalBookingSave(mockReq({ booking_id: 1, otp: '482910', hp_unique_id: 7 }), res);
    expect(trxFn.commit).toHaveBeenCalled();
    expect(trxFn.rollback).not.toHaveBeenCalled();
  });

  test('responds 500 and rolls back on DB error', async () => {
    const trxFn = jest.fn().mockImplementation(() => { throw new Error('Query error'); });
    trxFn.commit   = jest.fn();
    trxFn.rollback = jest.fn().mockResolvedValue(undefined);
    db.transaction = jest.fn().mockResolvedValue(trxFn);
    const res = mockRes();
    await finalBookingSave(mockReq({ booking_id: 1, otp: '482910', hp_unique_id: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(trxFn.rollback).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getUserBookings
// ─────────────────────────────────────────────────────────────────────────────

describe('getUserBookings', () => {
  const rows = [{ id: 1 }, { id: 2 }];

  test('calls model with query filters and returns result', async () => {
    getBookings.getUserBookingsModel = jest.fn().mockResolvedValue(rows);
    const req = mockReq({}, { user_id: '3' });
    const res = mockRes();
    await getUserBookings(req, res);
    expect(getBookings.getUserBookingsModel).toHaveBeenCalledWith({ user_id: '3' }, req.login_data);
    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('responds 500 on model error', async () => {
    getBookings.getUserBookingsModel = jest.fn().mockRejectedValue(new Error('Model fail'));
    const res = mockRes();
    await getUserBookings(mockReq({}, {}), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHPByBooking
// ─────────────────────────────────────────────────────────────────────────────

describe('getHPByBooking', () => {
  test('calls model with query filters and returns result', async () => {
    const hpData = [{ id: 1, hp_unique_id: 7 }];
    getBookings.getHPByBookingModel = jest.fn().mockResolvedValue(hpData);
    const req = mockReq({}, { bkng_id: '5' });
    const res = mockRes();
    await getHPByBooking(req, res);
    expect(getBookings.getHPByBookingModel).toHaveBeenCalledWith({ bkng_id: '5' }, req.login_data);
    expect(res.json).toHaveBeenCalledWith(hpData);
  });

  test('responds 500 on model error', async () => {
    getBookings.getHPByBookingModel = jest.fn().mockRejectedValue(new Error('fail'));
    const res = mockRes();
    await getHPByBooking(mockReq({}, {}), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getBookingOTP
// ─────────────────────────────────────────────────────────────────────────────

describe('getBookingOTP', () => {
  test('responds 400 when bkng_id is missing', async () => {
    const res = mockRes();
    await getBookingOTP(mockReq({}, { hp_unique_id: '7' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 400 when hp_unique_id is missing', async () => {
    const res = mockRes();
    await getBookingOTP(mockReq({}, { bkng_id: '5' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 404 when no OTP record found', async () => {
    getBookings.getOTP = jest.fn().mockResolvedValue(null);
    const res = mockRes();
    await getBookingOTP(mockReq({}, { bkng_id: '5', hp_unique_id: '7' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('responds 200 with OTP data when found', async () => {
    const otpRow = { otp: '482910', bkng_id: 5, hp_unique_id: 7 };
    getBookings.getOTP = jest.fn().mockResolvedValue(otpRow);
    const res = mockRes();
    await getBookingOTP(mockReq({}, { bkng_id: '5', hp_unique_id: '7' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: otpRow }));
  });

  test('responds 500 on model error', async () => {
    getBookings.getOTP = jest.fn().mockRejectedValue(new Error('fail'));
    const res = mockRes();
    await getBookingOTP(mockReq({}, { bkng_id: '5', hp_unique_id: '7' }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMatchedHPs — scoring algorithm
// ─────────────────────────────────────────────────────────────────────────────

describe('getMatchedHPs', () => {
  const booking = {
    id: 1, branch_id: 10, user_id: 3,
    service_start_date: '2026-06-01', service_end_date: '2026-06-30',
    req_languages: 'Hindi,English',
    req_gender: 'female',
  };

  // Sets up the 4 sequential DB calls getMatchedHPs makes
  function mockDbForScoring(hps, historyHpIds = []) {
    db
      .mockReturnValueOnce(chain(booking))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain(hps))
      .mockReturnValueOnce(chain(historyHpIds.map(id => ({ hp_unique_id: id }))));
  }

  function hp(overrides = {}) {
    return {
      hp_reg_id: 1,
      name: 'Test HP',
      hp_reg_branch_id: 99,
      hp_reg_languages: 'Tamil',
      hp_reg_gender: 'male',
      hp_reg_experience: 1,
      hp_reg_city: 'Pune',
      ...overrides,
    };
  }

  test('responds 400 when booking_id is missing', async () => {
    const res = mockRes();
    await getMatchedHPs(mockReq({}, {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('responds 404 when booking not found', async () => {
    db.mockReturnValueOnce(chain(null));
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '99' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('city/branch match scores +25', async () => {
    mockDbForScoring([hp({ hp_reg_branch_id: 10 })]);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches[0].score).toBe(25);
  });

  test('language overlap scores +30', async () => {
    mockDbForScoring([hp({ hp_reg_languages: 'Hindi,Tamil' })]);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches[0].score).toBe(30);
  });

  test('experience >= 2 years scores +20', async () => {
    mockDbForScoring([hp({ hp_reg_experience: 3 })]);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches[0].score).toBe(20);
  });

  test('gender match scores +15', async () => {
    mockDbForScoring([hp({ hp_reg_gender: 'female' })]);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches[0].score).toBe(15);
  });

  test('client history scores +10', async () => {
    mockDbForScoring([hp({ hp_reg_id: 1 })], [1]);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches[0].score).toBe(10);
  });

  test('all five factors combined score 100', async () => {
    mockDbForScoring([hp({
      hp_reg_id: 1,
      hp_reg_branch_id: 10,
      hp_reg_languages: 'Hindi,English',
      hp_reg_gender: 'female',
      hp_reg_experience: 5,
    })], [1]);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches[0].score).toBe(100);
  });

  test('returns at most 10 matches', async () => {
    const hps = Array.from({ length: 15 }, (_, i) =>
      hp({ hp_reg_id: i + 1, name: `HP ${i + 1}` })
    );
    mockDbForScoring(hps);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].matches.length).toBeLessThanOrEqual(10);
  });

  test('results are sorted by score descending', async () => {
    const hps = [
      hp({ hp_reg_id: 1, hp_reg_branch_id: 10 }),           // score 25
      hp({ hp_reg_id: 2, hp_reg_branch_id: 10, hp_reg_experience: 3 }), // score 45
      hp({ hp_reg_id: 3 }),                                  // score 0
    ];
    mockDbForScoring(hps);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    const scores = res.json.mock.calls[0][0].matches.map(m => m.score);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });

  test('total_available reflects HP pool size', async () => {
    const hps = [hp({ hp_reg_id: 1 }), hp({ hp_reg_id: 2 }), hp({ hp_reg_id: 3 })];
    mockDbForScoring(hps);
    const res = mockRes();
    await getMatchedHPs(mockReq({}, { booking_id: '1' }), res);
    expect(res.json.mock.calls[0][0].total_available).toBe(3);
  });
});
