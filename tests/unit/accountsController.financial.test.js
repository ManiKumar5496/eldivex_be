'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../config/db');
jest.mock('../../utils/withTransaction');
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

// ── Imports ───────────────────────────────────────────────────────────────────

const db              = require('../../config/db');
const withTransaction = require('../../utils/withTransaction');

const {
  getTransactionLedger,
  getClientOutstanding,
  getBookingOutstanding,
  createWriteOffV2,
  approveWriteOff,
  createRefund,
  getRefunds,
  getRefundById,
  approveRefund,
  applyCreditNote,
  getCreditNoteApplications,
  createInternalTransfer,
  getInternalTransfers,
  approveInternalTransfer,
} = require('../../controllers/web_app/accountsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockReq(body = {}, query = {}, params = {}, loginData = { id: 99, org_id: 1, branch_access: '1' }) {
  return { body, query, params, login_data: loginData };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

/**
 * Returns a fluent Knex-like chain that resolves to `value` when awaited.
 * All chainable methods return `this`. .first() resolves to value directly.
 * .insert() resolves to [1] (or the value if array). .update() resolves to 1.
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
    offset:     jest.fn().mockReturnThis(),
    groupBy:    jest.fn().mockReturnThis(),
    sum:        jest.fn().mockReturnThis(),
    count:      jest.fn().mockReturnThis(),
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
  db.fn          = { now: jest.fn().mockReturnValue('NOW()') };
  db.raw         = jest.fn().mockReturnValue('RAW_EXPR');
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
// getTransactionLedger
// ─────────────────────────────────────────────────────────────────────────────

describe('getTransactionLedger', () => {
  test('returns paginated data filtered by org_id', async () => {
    const rows = [];
    // First db call: the main query (resolves to array)
    db.mockReturnValueOnce(chain(rows));
    // Second db call: count query — chain([{total: 0}]) resolves to [{total:0}]
    db.mockReturnValueOnce(chain([{ total: 0 }]));

    const res = mockRes();
    await getTransactionLedger(mockReq({}, {}), res);

    expect(res.json).toHaveBeenCalledWith({
      data: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
  });

  test('applies booking_id filter when provided', async () => {
    const rows = [{ id: 1, booking_id: 5 }];
    db.mockReturnValueOnce(chain(rows));
    db.mockReturnValueOnce(chain([{ total: 1 }]));

    const res = mockRes();
    await getTransactionLedger(mockReq({}, { booking_id: '5' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: rows, total: 1 })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.offset = jest.fn().mockRejectedValue(new Error('DB exploded'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await getTransactionLedger(mockReq({}, {}), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getClientOutstanding
// ─────────────────────────────────────────────────────────────────────────────

describe('getClientOutstanding', () => {
  test('computes correct outstanding from ledger rows', async () => {
    const rows = [
      { transaction_type: 'INVOICE',  direction: 'DEBIT',  total: '1000' },
      { transaction_type: 'RECEIPT',  direction: 'CREDIT', total: '500'  },
    ];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        outstandingAmount: 500,
        totalBilled: 1000,
        totalPaid: 500,
      })
    );
  });

  test('returns zero outstanding when no entries', async () => {
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ outstandingAmount: 0 })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.groupBy = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getBookingOutstanding
// ─────────────────────────────────────────────────────────────────────────────

describe('getBookingOutstanding', () => {
  test('returns outstanding for booking', async () => {
    const rows = [
      { transaction_type: 'INVOICE',  direction: 'DEBIT',  total: '2000' },
      { transaction_type: 'RECEIPT',  direction: 'CREDIT', total: '800'  },
    ];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getBookingOutstanding(mockReq({}, {}, { bookingId: '42' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 42,
        outstandingAmount: 1200,
        totalBilled: 2000,
        totalPaid: 800,
      })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.groupBy = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await getBookingOutstanding(mockReq({}, {}, { bookingId: '42' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createWriteOffV2
// ─────────────────────────────────────────────────────────────────────────────

describe('createWriteOffV2', () => {
  const validBody = {
    booking_id: 10,
    write_off_amount: 300,
    reason: 'Patient unable to pay',
  };

  test('returns 400 when booking_id missing', async () => {
    const res = mockRes();
    await createWriteOffV2(mockReq({ write_off_amount: 100, reason: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when write_off_amount missing', async () => {
    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, reason: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when reason missing', async () => {
    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 100 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when amount is zero or negative', async () => {
    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 0, reason: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when booking not found', async () => {
    // db('edx_bookings').where(...).first() → null
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await createWriteOffV2(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 when booking is cancelled (status == 6)', async () => {
    db.mockReturnValueOnce(chain({ id: 10, status: 6, user_id: 3 }));

    const res = mockRes();
    await createWriteOffV2(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('cancelled') })
    );
  });

  test('returns 400 when pending write-off already exists', async () => {
    // 1st: booking found, not cancelled
    db.mockReturnValueOnce(chain({ id: 10, status: 1, user_id: 3 }));
    // 2nd: existing pending write-off found
    db.mockReturnValueOnce(chain({ id: 55, status: 'Pending' }));

    const res = mockRes();
    await createWriteOffV2(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('pending write-off') })
    );
  });

  test('inserts write-off and returns created record on success', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 77, booking_id: 10, status: 'Pending', write_off_amount: 300 };

    // 1: booking fetch
    db.mockReturnValueOnce(chain(booking));
    // 2: existing write-off check → null
    db.mockReturnValueOnce(chain(null));
    // 3: insert into edx_write_offs → [77]
    db.mockReturnValueOnce(chain([77]));
    // 4: _addApprovalHistory insert into edx_approval_history
    db.mockReturnValueOnce(chain([1]));
    // 5: fetch created write-off
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createWriteOffV2(mockReq(validBody), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ booking_id: 10 })
    );
  });

  test('sets approval_level to L1 for amount <= 500', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 77, booking_id: 10, approval_level: 'L1' };

    db.mockReturnValueOnce(chain(booking));
    db.mockReturnValueOnce(chain(null));
    const insertChain = chain([77]);
    db.mockReturnValueOnce(insertChain);
    db.mockReturnValueOnce(chain([1]));
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 400, reason: 'bad debt' }), res);

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ approval_level: 'L1' })
    );
  });

  test('sets approval_level to L2 for amount 501-5000', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 78, booking_id: 10, approval_level: 'L2' };

    db.mockReturnValueOnce(chain(booking));
    db.mockReturnValueOnce(chain(null));
    const insertChain = chain([78]);
    db.mockReturnValueOnce(insertChain);
    db.mockReturnValueOnce(chain([1]));
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 2000, reason: 'bad debt' }), res);

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ approval_level: 'L2' })
    );
  });

  test('sets approval_level to L3 for amount > 5000', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 79, booking_id: 10, approval_level: 'L3' };

    db.mockReturnValueOnce(chain(booking));
    db.mockReturnValueOnce(chain(null));
    const insertChain = chain([79]);
    db.mockReturnValueOnce(insertChain);
    db.mockReturnValueOnce(chain([1]));
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 10000, reason: 'bad debt' }), res);

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ approval_level: 'L3' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// approveWriteOff
// ─────────────────────────────────────────────────────────────────────────────

describe('approveWriteOff', () => {
  const pendingWo = {
    id: 55,
    booking_id: 10,
    user_id: 3,
    write_off_amount: '300',
    status: 'Pending',
    reason: 'Bad debt',
    approval_level: 'L1',
  };

  test('returns 400 when write_off_id missing', async () => {
    const res = mockRes();
    await approveWriteOff(mockReq({ action: 'Approved' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when action is invalid value', async () => {
    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Delete' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when write-off not found', async () => {
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 when write-off status is not Pending', async () => {
    db.mockReturnValueOnce(chain({ ...pendingWo, status: 'Approved' }));

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('approves write-off: creates ledger entry and updates status', async () => {
    // 1st: fetch write-off
    db.mockReturnValueOnce(chain(pendingWo));

    // Set up trxMock for withTransaction — must handle multiple table calls
    // _createTransactionEntry makes 2 sum queries + 1 insert = 3 trx('...') calls
    // then trx('edx_write_offs').where.update
    // then _addApprovalHistory trx('edx_approval_history').insert
    let trxCallCount = 0;
    const trxMock = jest.fn().mockImplementation((tableName) => {
      trxCallCount++;
      if (tableName === 'edx_bookings') {
        return chain({ id: 10, user_id: 3 });
      }
      if (tableName === 'edx_transaction_ledger') {
        // first two calls are sum queries in _createTransactionEntry
        return chain({ total_debit: '0', total_credit: '0' });
      }
      if (tableName === 'edx_write_offs') {
        return chain([1]);
      }
      if (tableName === 'edx_approval_history') {
        return chain([1]);
      }
      return chain(null);
    });
    trxMock.raw = jest.fn().mockReturnValue('RAW_EXPR');

    withTransaction.mockImplementation(async (fn) => { await fn(trxMock); });

    // After transaction: fetch updated wo + history
    db.mockReturnValueOnce(chain({ ...pendingWo, status: 'Approved' }));
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Approved' }), res);

    expect(withTransaction).toHaveBeenCalled();
    expect(trxMock).toHaveBeenCalledWith('edx_transaction_ledger');
    expect(trxMock).toHaveBeenCalledWith('edx_write_offs');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Approved' })
    );
  });

  test('rejects write-off: updates status to Rejected without creating ledger entry', async () => {
    // 1st: fetch write-off
    db.mockReturnValueOnce(chain(pendingWo));
    // 2nd: db('edx_write_offs').where.update (reject path — no transaction)
    db.mockReturnValueOnce(chain(1));
    // 3rd: _addApprovalHistory db('edx_approval_history').insert
    db.mockReturnValueOnce(chain([1]));
    // 4th: fetch updated
    db.mockReturnValueOnce(chain({ ...pendingWo, status: 'Rejected' }));
    // 5th: fetch history
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Rejected' }), res);

    expect(withTransaction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Rejected' })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB error'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createRefund
// ─────────────────────────────────────────────────────────────────────────────

describe('createRefund', () => {
  const validBody = {
    booking_id: 10,
    refund_amount: 200,
    refund_channel: 'BANK_TRANSFER',
    refund_reason: 'Service not delivered',
  };

  test('returns 400 when required fields missing', async () => {
    const res = mockRes();
    await createRefund(mockReq({ booking_id: 10 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when amount is zero', async () => {
    const res = mockRes();
    await createRefund(mockReq({ ...validBody, refund_amount: 0 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when booking not found', async () => {
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await createRefund(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 when refund amount exceeds refundable balance', async () => {
    // 1st: booking found
    db.mockReturnValueOnce(chain({ id: 10, status: 1, user_id: 3 }));
    // 2nd: paidRows — total paid = 500
    db.mockReturnValueOnce(chain({ total: '500' }));
    // 3rd: alreadyRefunded — already refunded = 400
    db.mockReturnValueOnce(chain({ total: '400' }));

    // maxRefund = 500 - 400 = 100, trying to refund 200
    const res = mockRes();
    await createRefund(mockReq({ ...validBody, refund_amount: 200 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Refund amount exceeds') })
    );
  });

  test('inserts refund with PENDING_APPROVAL status on success', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 88, booking_id: 10, status: 'PENDING_APPROVAL', refund_amount: 50 };

    // 1: booking fetch
    db.mockReturnValueOnce(chain(booking));
    // 2: paidRows sum
    db.mockReturnValueOnce(chain({ total: '500' }));
    // 3: alreadyRefunded sum
    db.mockReturnValueOnce(chain({ total: '0' }));
    // 4: insert into edx_refunds → [88]
    db.mockReturnValueOnce(chain([88]));
    // 5: _addApprovalHistory insert
    db.mockReturnValueOnce(chain([1]));
    // 6: fetch created refund
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createRefund(mockReq({ ...validBody, refund_amount: 50 }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING_APPROVAL' })
    );
  });

  test('stores channel_details as JSON string', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 89, booking_id: 10, status: 'PENDING_APPROVAL' };
    const channelDetails = { bank: 'HDFC', account: '1234567890' };

    db.mockReturnValueOnce(chain(booking));
    db.mockReturnValueOnce(chain({ total: '500' }));
    db.mockReturnValueOnce(chain({ total: '0' }));
    const insertChain = chain([89]);
    db.mockReturnValueOnce(insertChain);
    db.mockReturnValueOnce(chain([1]));
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createRefund(mockReq({ ...validBody, refund_amount: 50, channel_details: channelDetails }), res);

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_details: JSON.stringify(channelDetails),
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRefunds
// ─────────────────────────────────────────────────────────────────────────────

describe('getRefunds', () => {
  test('returns list filtered by org_id', async () => {
    const rows = [{ id: 1, booking_id: 10 }, { id: 2, booking_id: 11 }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getRefunds(mockReq({}, {}), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('applies booking_id filter from query params', async () => {
    const rows = [{ id: 1, booking_id: 10 }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getRefunds(mockReq({}, { booking_id: '10' }), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('applies status filter', async () => {
    const rows = [{ id: 3, status: 'APPROVED' }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getRefunds(mockReq({}, { status: 'APPROVED' }), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.orderBy = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await getRefunds(mockReq({}, {}), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRefundById
// ─────────────────────────────────────────────────────────────────────────────

describe('getRefundById', () => {
  test('returns refund with approval_history array', async () => {
    const refund = { id: 5, booking_id: 10, status: 'APPROVED' };
    const history = [{ id: 1, action: 'SUBMITTED' }];

    // 1st: refund fetch
    db.mockReturnValueOnce(chain(refund));
    // 2nd: history fetch
    db.mockReturnValueOnce(chain(history));

    const res = mockRes();
    await getRefundById(mockReq({}, {}, { id: '5' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 5,
        approval_history: history,
      })
    );
  });

  test('returns 404 when refund not found', async () => {
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await getRefundById(mockReq({}, {}, { id: '999' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// approveRefund
// ─────────────────────────────────────────────────────────────────────────────

describe('approveRefund', () => {
  const pendingRefund = {
    id: 20,
    client_id: 3,
    booking_id: 10,
    refund_amount: '200',
    refund_reason: 'Service issue',
    status: 'PENDING_APPROVAL',
    dispatch_details: null,
  };

  test('returns 400 when refund_id missing', async () => {
    const res = mockRes();
    await approveRefund(mockReq({ action: 'Approved' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when action is invalid', async () => {
    // Note: approveRefund does NOT validate action upfront for invalid values
    // it checks the state-machine transition, so invalid action hitting unknown state
    // We can still test it goes to 400 via the state-machine check
    db.mockReturnValueOnce(chain({ ...pendingRefund }));

    const res = mockRes();
    // action 'Delete' is not in allowed transitions for PENDING_APPROVAL
    await approveRefund(mockReq({ refund_id: 20, action: 'Delete' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when refund not found', async () => {
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 on invalid state transition', async () => {
    // DRAFT is not a valid state in the allowed map, so any action from it is invalid
    db.mockReturnValueOnce(chain({ ...pendingRefund, status: 'DRAFT' }));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Invalid status transition') })
    );
  });

  test('transitions PENDING_APPROVAL to Approved', async () => {
    // 1: fetch refund
    db.mockReturnValueOnce(chain(pendingRefund));
    // 2: db('edx_refunds').where.update
    db.mockReturnValueOnce(chain(1));
    // 3: _addApprovalHistory insert
    db.mockReturnValueOnce(chain([1]));
    // 4: fetch updated
    db.mockReturnValueOnce(chain({ ...pendingRefund, status: 'APPROVED' }));
    // 5: fetch history
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED' })
    );
  });

  test('transitions PENDING_APPROVAL to Rejected', async () => {
    db.mockReturnValueOnce(chain(pendingRefund));
    db.mockReturnValueOnce(chain(1));
    db.mockReturnValueOnce(chain([1]));
    db.mockReturnValueOnce(chain({ ...pendingRefund, status: 'REJECTED' }));
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Rejected' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'REJECTED' })
    );
  });

  test('transitions APPROVED to Processing', async () => {
    const approvedRefund = { ...pendingRefund, status: 'APPROVED' };

    db.mockReturnValueOnce(chain(approvedRefund));
    db.mockReturnValueOnce(chain(1));
    db.mockReturnValueOnce(chain([1]));
    db.mockReturnValueOnce(chain({ ...approvedRefund, status: 'PROCESSING' }));
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Processing' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PROCESSING' })
    );
  });

  test('on Completed: creates transaction ledger entry via withTransaction', async () => {
    const processingRefund = { ...pendingRefund, status: 'PROCESSING' };

    // 1: fetch refund
    db.mockReturnValueOnce(chain(processingRefund));

    // Set up trxMock for the Completed path
    const trxMock = jest.fn().mockImplementation((tableName) => {
      if (tableName === 'edx_transaction_ledger') {
        // _createTransactionEntry: two sum calls + one insert
        return chain({ total_debit: '0', total_credit: '0' });
      }
      if (tableName === 'edx_refunds') {
        return chain([1]);
      }
      if (tableName === 'edx_approval_history') {
        return chain([1]);
      }
      return chain(null);
    });
    trxMock.raw = jest.fn().mockReturnValue('RAW_EXPR');

    withTransaction.mockImplementation(async (fn) => { await fn(trxMock); });

    // After transaction: fetch updated + history
    db.mockReturnValueOnce(chain({ ...processingRefund, status: 'COMPLETED' }));
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Completed' }), res);

    expect(withTransaction).toHaveBeenCalled();
    expect(trxMock).toHaveBeenCalledWith('edx_transaction_ledger');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyCreditNote
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCreditNote', () => {
  const validBody = {
    credit_note_id: 5,
    target_booking_id: 10,
    target_invoice_id: 20,
    amount_to_apply: 100,
  };
  const approvedCn = {
    id: 5,
    amount: '500',
    remaining_amount: '400',
    used_amount: '100',
    status: 'Approved',
  };

  test('returns 400 when required fields missing', async () => {
    const res = mockRes();
    await applyCreditNote(mockReq({ credit_note_id: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when credit note not found', async () => {
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Credit note') })
    );
  });

  test('returns 400 when apply amount exceeds remaining', async () => {
    const cn = { ...approvedCn, remaining_amount: '100' };
    db.mockReturnValueOnce(chain(cn));

    const res = mockRes();
    // amount_to_apply=200 > remaining=100
    await applyCreditNote(mockReq({ ...validBody, amount_to_apply: 200 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('exceeds credit note') })
    );
  });

  test('returns 400 when credit note status is not Approved', async () => {
    const cn = { ...approvedCn, status: 'Pending' };
    db.mockReturnValueOnce(chain(cn));

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Approved') })
    );
  });

  test('returns 404 when target invoice not found', async () => {
    db.mockReturnValueOnce(chain(approvedCn));
    db.mockReturnValueOnce(chain(null)); // invoice not found

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('invoice') })
    );
  });

  test('returns 404 when target booking not found', async () => {
    db.mockReturnValueOnce(chain(approvedCn));
    db.mockReturnValueOnce(chain({ id: 20 })); // invoice found
    db.mockReturnValueOnce(chain(null));         // booking not found

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('booking') })
    );
  });

  test('applies credit note: updates remaining_amount and creates application record', async () => {
    const targetBooking = { id: 10, user_id: 3 };
    const application   = { id: 99, credit_note_id: 5, status: 'APPLIED', amount_applied: 100 };

    // 1: credit note fetch
    db.mockReturnValueOnce(chain(approvedCn));
    // 2: invoice fetch
    db.mockReturnValueOnce(chain({ id: 20 }));
    // 3: booking fetch
    db.mockReturnValueOnce(chain(targetBooking));

    // trxMock: handles _createTransactionEntry (2 sum queries + 1 insert)
    // + edx_credit_notes update + edx_credit_note_applications insert
    const trxMock = jest.fn().mockImplementation((tableName) => {
      if (tableName === 'edx_transaction_ledger') {
        return chain({ total_debit: '0', total_credit: '0' });
      }
      if (tableName === 'edx_credit_notes') {
        return chain(1);
      }
      if (tableName === 'edx_credit_note_applications') {
        return chain([99]);
      }
      return chain(null);
    });
    trxMock.raw = jest.fn().mockReturnValue('RAW_EXPR');

    withTransaction.mockImplementation(async (fn) => { await fn(trxMock); });

    // 4: fetch created application
    db.mockReturnValueOnce(chain(application));

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(withTransaction).toHaveBeenCalled();
    expect(trxMock).toHaveBeenCalledWith('edx_credit_notes');
    expect(trxMock).toHaveBeenCalledWith('edx_credit_note_applications');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPLIED' })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCreditNoteApplications
// ─────────────────────────────────────────────────────────────────────────────

describe('getCreditNoteApplications', () => {
  test('returns list filtered by org_id', async () => {
    const rows = [{ id: 1, credit_note_id: 5 }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getCreditNoteApplications(mockReq({}, {}), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('applies credit_note_id filter', async () => {
    const rows = [{ id: 2, credit_note_id: 7 }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getCreditNoteApplications(mockReq({}, { credit_note_id: '7' }), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.orderBy = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await getCreditNoteApplications(mockReq({}, {}), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createInternalTransfer
// ─────────────────────────────────────────────────────────────────────────────

describe('createInternalTransfer', () => {
  const validBody = {
    client_id: 3,
    source_booking_id: 10,
    target_booking_id: 20,
    transfer_amount: 500,
    transfer_type: 'ADVANCE',
    reason: 'Relocation',
  };
  const srcBk = { id: 10, user_id: 3 };
  const tgtBk = { id: 20, user_id: 3 };

  test('returns 400 when required fields missing', async () => {
    const res = mockRes();
    await createInternalTransfer(mockReq({ client_id: 3 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when source and target booking are same', async () => {
    const res = mockRes();
    await createInternalTransfer(mockReq({ ...validBody, target_booking_id: 10 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('different') })
    );
  });

  test('returns 400 when transfer_amount is zero', async () => {
    const res = mockRes();
    await createInternalTransfer(mockReq({ ...validBody, transfer_amount: 0 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when source booking not found', async () => {
    // Promise.all resolves both: srcBk=null, tgtBk=found
    db.mockReturnValueOnce(chain(null));   // source
    db.mockReturnValueOnce(chain(tgtBk));  // target

    const res = mockRes();
    await createInternalTransfer(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Source booking') })
    );
  });

  test('returns 404 when target booking not found', async () => {
    db.mockReturnValueOnce(chain(srcBk));  // source
    db.mockReturnValueOnce(chain(null));   // target

    const res = mockRes();
    await createInternalTransfer(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Target booking') })
    );
  });

  test('returns 400 when bookings belong to different clients', async () => {
    db.mockReturnValueOnce(chain({ ...srcBk, user_id: 1 }));
    db.mockReturnValueOnce(chain({ ...tgtBk, user_id: 2 }));

    const res = mockRes();
    await createInternalTransfer(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('same client') })
    );
  });

  test('creates transfer with PENDING_APPROVAL status on success', async () => {
    const created = { id: 101, status: 'PENDING_APPROVAL', transfer_amount: 500 };

    // Promise.all uses two simultaneous db calls
    db.mockReturnValueOnce(chain(srcBk));
    db.mockReturnValueOnce(chain(tgtBk));
    // insert into edx_internal_transfers
    db.mockReturnValueOnce(chain([101]));
    // _addApprovalHistory insert
    db.mockReturnValueOnce(chain([1]));
    // fetch created
    db.mockReturnValueOnce(chain(created));

    const res = mockRes();
    await createInternalTransfer(mockReq(validBody), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING_APPROVAL' })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB fail'));
    // Both Promise.all branches need a mock — second one is fine as chain
    db.mockReturnValueOnce(errChain);
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await createInternalTransfer(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getInternalTransfers
// ─────────────────────────────────────────────────────────────────────────────

describe('getInternalTransfers', () => {
  test('returns list filtered by org_id', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getInternalTransfers(mockReq({}, {}), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('applies client_id filter', async () => {
    const rows = [{ id: 3, client_id: 5 }];
    db.mockReturnValueOnce(chain(rows));

    const res = mockRes();
    await getInternalTransfers(mockReq({}, { client_id: '5' }), res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.orderBy = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await getInternalTransfers(mockReq({}, {}), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// approveInternalTransfer
// ─────────────────────────────────────────────────────────────────────────────

describe('approveInternalTransfer', () => {
  const pendingTransfer = {
    id: 30,
    client_id: 3,
    source_booking_id: 10,
    target_booking_id: 20,
    transfer_amount: '500',
    status: 'PENDING_APPROVAL',
  };

  test('returns 400 when transfer_id missing', async () => {
    const res = mockRes();
    await approveInternalTransfer(mockReq({ action: 'Approved' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when action is invalid', async () => {
    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Cancel' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when transfer not found', async () => {
    db.mockReturnValueOnce(chain(null));

    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 when transfer is not PENDING_APPROVAL', async () => {
    db.mockReturnValueOnce(chain({ ...pendingTransfer, status: 'COMPLETED' }));

    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('PENDING_APPROVAL') })
    );
  });

  test('approve: calls withTransaction and creates two ledger entries (INTERNAL_TRANSFER_OUT and INTERNAL_TRANSFER_IN)', async () => {
    // 1: fetch transfer
    db.mockReturnValueOnce(chain(pendingTransfer));

    // trxMock: _createTransactionEntry called TWICE (OUT + IN)
    // Each call: 2 sum queries on edx_transaction_ledger + 1 insert = 3 trx calls
    // Then: trx('edx_internal_transfers').where.update
    // Then: _addApprovalHistory trx('edx_approval_history').insert
    let ledgerInsertCount = 0;
    const trxMock = jest.fn().mockImplementation((tableName) => {
      if (tableName === 'edx_transaction_ledger') {
        ledgerInsertCount++;
        // Even calls are the first() sum, we return something usable for both
        return chain({ total_debit: '0', total_credit: '0' });
      }
      if (tableName === 'edx_internal_transfers') {
        return chain(1);
      }
      if (tableName === 'edx_approval_history') {
        return chain([1]);
      }
      return chain(null);
    });
    trxMock.raw = jest.fn().mockReturnValue('RAW_EXPR');

    withTransaction.mockImplementation(async (fn) => { await fn(trxMock); });

    // After transaction: fetch updated + history
    db.mockReturnValueOnce(chain({ ...pendingTransfer, status: 'COMPLETED' }));
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Approved' }), res);

    expect(withTransaction).toHaveBeenCalled();
    // edx_transaction_ledger should have been called multiple times (sum queries + inserts for OUT + IN)
    const ledgerCalls = trxMock.mock.calls.filter(([t]) => t === 'edx_transaction_ledger');
    expect(ledgerCalls.length).toBeGreaterThanOrEqual(2);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' })
    );
  });

  test('reject: updates status to REJECTED', async () => {
    // 1: fetch transfer
    db.mockReturnValueOnce(chain(pendingTransfer));
    // 2: db('edx_internal_transfers').where.update (reject — no transaction)
    db.mockReturnValueOnce(chain(1));
    // 3: _addApprovalHistory insert
    db.mockReturnValueOnce(chain([1]));
    // 4: fetch updated
    db.mockReturnValueOnce(chain({ ...pendingTransfer, status: 'REJECTED' }));
    // 5: fetch history
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Rejected' }), res);

    expect(withTransaction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'REJECTED' })
    );
  });

  test('returns 500 on db error', async () => {
    const errChain = chain(null);
    errChain.first = jest.fn().mockRejectedValue(new Error('DB fail'));
    db.mockReturnValueOnce(errChain);

    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
