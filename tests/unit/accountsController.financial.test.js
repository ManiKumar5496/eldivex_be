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
    whereNotNull: jest.fn().mockReturnThis(),
    leftJoin:   jest.fn().mockReturnThis(),
    join:       jest.fn().mockReturnThis(),
    select:     jest.fn().mockReturnThis(),
    orderBy:    jest.fn().mockReturnThis(),
    limit:      jest.fn().mockReturnThis(),
    offset:     jest.fn().mockReturnThis(),
    groupBy:    jest.fn().mockReturnThis(),
    sum:        jest.fn().mockReturnThis(),
    count:      jest.fn().mockReturnThis(),
    forUpdate:  jest.fn().mockReturnThis(),
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

/**
 * Outstanding endpoints read billed from edx_invoice, paid from approved
 * edx_receipts and adjustments from edx_transaction_ledger. Routes each table
 * to its own chain and records the chains so tests can inspect the scope.
 */
function outstandingDb({ ledger = [], billed = null, paid = null }) {
  const chains = {};
  db.mockImplementation((table) => {
    let c;
    if (table === 'edx_transaction_ledger') c = chain(ledger);
    else if (table === 'edx_invoice') c = chain({ total: billed });
    else if (table === 'edx_receipts') c = chain({ total: paid });
    else c = chain([]);
    (chains[table] = chains[table] || []).push(c);
    return c;
  });
  return chains;
}

describe('getClientOutstanding', () => {
  test('billed and paid come from invoices and approved receipts', async () => {
    outstandingDb({ billed: '1000', paid: '500' });

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

  test('invoiced client with no ledger entries is still outstanding', async () => {
    // Regression: invoices are never posted to the ledger, so a client billed
    // ₹15,600 used to show "No Balance Due".
    outstandingDb({ billed: '15600', paid: null });

    const res = mockRes();
    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ totalBilled: 15600, totalPaid: 0, outstandingAmount: 15600 })
    );
  });

  test('applies ledger adjustments on top of billed and paid', async () => {
    outstandingDb({
      billed: '1000',
      paid: '500',
      ledger: [
        { transaction_type: 'WRITE_OFF',           direction: 'CREDIT', total: '100' },
        { transaction_type: 'CREDIT_NOTE_APPLIED', direction: 'CREDIT', total: '50'  },
        { transaction_type: 'REFUND',              direction: 'DEBIT',  total: '20'  },
      ],
    });

    const res = mockRes();
    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        totalWriteOff: 100,
        totalCreditNoteApplied: 50,
        totalRefunded: 20,
        outstandingAmount: 370, // 1000 - 500 - 100 - 50 + 20
      })
    );
  });

  test('ignores INVOICE/RECEIPT ledger rows so nothing is double counted', async () => {
    outstandingDb({
      billed: '1000',
      paid: '0',
      ledger: [{ transaction_type: 'INVOICE', direction: 'DEBIT', total: '1000' }],
    });

    const res = mockRes();
    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ totalBilled: 1000, outstandingAmount: 1000 })
    );
  });

  test('scopes invoices and receipts to the client\'s bookings in the org', async () => {
    const chains = outstandingDb({ billed: '0', paid: '0' });

    await getClientOutstanding(mockReq({}, {}, { clientId: '7' }), mockRes());

    expect(chains.edx_bookings).toHaveLength(2);
    for (const scope of chains.edx_bookings) {
      expect(scope.where).toHaveBeenCalledWith('org_id', 1);
      expect(scope.where).toHaveBeenCalledWith('user_id', 7);
    }
    expect(chains.edx_receipts[0].where).toHaveBeenCalledWith('status', 'Approved');
  });

  test('returns zero outstanding when no entries', async () => {
    outstandingDb({});

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
    const chains = outstandingDb({ billed: '2000', paid: '800' });

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
    for (const scope of chains.edx_bookings) {
      expect(scope.where).toHaveBeenCalledWith('id', 42);
    }
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

  // Routes db() by table for a successful create: booking found, no pending
  // write-off, ₹1,00,000 outstanding (billed, nothing paid, no adjustments).
  function routeWriteOffDb({ booking, insertChain, created, billed = '100000' }) {
    const writeOffs = [chain(null), insertChain, chain(created)];
    db.mockImplementation((table) => {
      if (table === 'edx_bookings') return chain(booking);
      if (table === 'edx_write_offs') return writeOffs.shift() || chain(null);
      if (table === 'edx_invoice') return chain({ total: billed });
      if (table === 'edx_receipts') return chain({ total: '0' });
      if (table === 'edx_transaction_ledger') return chain([]);
      return chain([1]); // edx_approval_history insert
    });
  }

  test('returns 400 when the amount exceeds the outstanding balance', async () => {
    const insertChain = chain([80]);
    routeWriteOffDb({ booking: { id: 10, status: 1, user_id: 3 }, insertChain, created: {}, billed: '200' });

    const res = mockRes();
    await createWriteOffV2(mockReq(validBody), res);   // ₹300 against ₹200 owed

    expect(res.status).toHaveBeenCalledWith(400);
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

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

    routeWriteOffDb({ booking, insertChain: chain([77]), created });

    const res = mockRes();
    await createWriteOffV2(mockReq(validBody), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ booking_id: 10 })
    );
  });

  test('sets approval_level to L1 for amount <= 500', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 77, booking_id: 10, approval_level: 'L1' };

    const insertChain = chain([77]);
    routeWriteOffDb({ booking, insertChain, created });

    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 400, reason: 'bad debt' }), res);

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ approval_level: 'L1' })
    );
  });

  test('sets approval_level to L2 for amount 501-5000', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 78, booking_id: 10, approval_level: 'L2' };

    const insertChain = chain([78]);
    routeWriteOffDb({ booking, insertChain, created });

    const res = mockRes();
    await createWriteOffV2(mockReq({ booking_id: 10, write_off_amount: 2000, reason: 'bad debt' }), res);

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ approval_level: 'L2' })
    );
  });

  test('sets approval_level to L3 for amount > 5000', async () => {
    const booking = { id: 10, status: 1, user_id: 3 };
    const created = { id: 79, booking_id: 10, approval_level: 'L3' };

    const insertChain = chain([79]);
    routeWriteOffDb({ booking, insertChain, created });

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
        // Awaited grouped query (outstanding re-check) → no adjustments;
        // .first() sums in _createTransactionEntry → zero running balance.
        const c = chain([]);
        c.first = jest.fn().mockResolvedValue({ total_debit: '0', total_credit: '0' });
        return c;
      }
      if (tableName === 'edx_invoice') return chain({ total: '100000' });   // billed
      if (tableName === 'edx_receipts') return chain({ total: '0' });       // paid
      if (tableName === 'edx_write_offs') {
        // forUpdate().first() re-reads the locked row; update() resolves 1
        return chain(pendingWo);
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

  test('returns 403 when the approver created the write-off (maker-checker)', async () => {
    db.mockReturnValueOnce(chain({ ...pendingWo, created_by: 99 }));

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('returns 409 when a concurrent approval already processed the write-off', async () => {
    db.mockReturnValueOnce(chain(pendingWo));
    const trxMock = jest.fn().mockImplementation(() => chain({ ...pendingWo, status: 'Approved' }));
    trxMock.raw = jest.fn().mockReturnValue('RAW_EXPR');
    withTransaction.mockImplementation(async (fn) => fn(trxMock));

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 55, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Write-off was already processed.',
      message: 'Write-off was already processed.',
    }));
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
    refund_reason: 'SERVICE_NOT_DELIVERED',
  };

  // Routes db() by table: the booking, ₹paid in approved receipts and ₹committed
  // in refunds already raised (pending/approved/processing/completed).
  function routeRefundDb({ booking, paid = '500', committed = '0', insertChain = chain([88]), created = {} }) {
    const refunds = [chain({ total: committed }), insertChain, chain(created)];
    db.mockImplementation((table) => {
      if (table === 'edx_bookings') return chain(booking);
      if (table === 'edx_receipts') return chain({ total: paid });
      if (table === 'edx_refunds') return refunds.shift() || chain(null);
      if (table === 'edx_transaction_ledger') return chain([]);
      return chain([1]); // edx_approval_history insert
    });
    return insertChain;
  }

  test('returns 400 for an unknown refund_channel', async () => {
    const res = mockRes();
    await createRefund(mockReq({ ...validBody, refund_channel: 'CRYPTO' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('counts refunds still pending approval against the refundable balance', async () => {
    // Paid ₹500; a ₹450 refund is already awaiting approval → only ₹50 left.
    const insertChain = routeRefundDb({ booking: { id: 10, user_id: 3 }, paid: '500', committed: '450' });

    const res = mockRes();
    await createRefund(mockReq({ ...validBody, refund_amount: 100 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

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
    routeRefundDb({ booking: { id: 10, status: 1, user_id: 3 }, paid: '500', committed: '400' });

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

    routeRefundDb({ booking, created });

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

    const insertChain = routeRefundDb({ booking, insertChain: chain([89]), created });

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

  // Approval transaction for a booking with ₹paid in and nothing else committed;
  // `updated` is how many rows the conditional status update changes.
  function approveTrx({ paid = '500', updated = 1 } = {}) {
    const trx = jest.fn((table) => {
      if (table === 'edx_receipts') return chain({ total: paid });
      if (table === 'edx_refunds') {
        const c = chain({ total: '0' });
        c.update = jest.fn().mockResolvedValue(updated);
        return c;
      }
      if (table === 'edx_transaction_ledger') return chain([]);
      return chain({ id: 10 });
    });
    trx.raw = jest.fn().mockReturnValue('RAW_EXPR');
    withTransaction.mockImplementation(async (fn) => fn(trx));
    return trx;
  }

  test('refuses approval when it would refund more than was paid', async () => {
    db.mockReturnValueOnce(chain(pendingRefund));
    approveTrx({ paid: '150' });   // ₹200 refund, only ₹150 paid

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('transitions PENDING_APPROVAL to Approved', async () => {
    db.mockReturnValueOnce(chain(pendingRefund));
    approveTrx();
    // after the transaction: fetch updated + history
    db.mockReturnValueOnce(chain({ ...pendingRefund, status: 'APPROVED' }));
    db.mockReturnValueOnce(chain([]));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED' })
    );
  });

  test('returns 403 when the approver requested the refund (maker-checker)', async () => {
    db.mockReturnValueOnce(chain({ ...pendingRefund, requested_by: 99 }));

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 409 when the refund changed state concurrently', async () => {
    db.mockReturnValueOnce(chain(pendingRefund));
    approveTrx({ updated: 0 }); // conditional update matched no row

    const res = mockRes();
    await approveRefund(mockReq({ refund_id: 20, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
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
        return chain(processingRefund);
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

  test('returns 400 when amount_to_apply is zero or negative', async () => {
    for (const amt of [-50, '0', 'abc']) {
      const res = mockRes();
      await applyCreditNote(mockReq({ ...validBody, amount_to_apply: amt }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('returns 400 when the locked balance no longer covers the amount (race)', async () => {
    db.mockReturnValueOnce(chain(approvedCn));
    db.mockReturnValueOnce(chain({ id: 20 }));
    db.mockReturnValueOnce(chain({ id: 10, user_id: 3 }));
    const trxMock = jest.fn().mockImplementation(() => chain({ ...approvedCn, remaining_amount: '50' }));
    trxMock.raw = jest.fn().mockReturnValue('RAW_EXPR');
    withTransaction.mockImplementation(async (fn) => fn(trxMock));

    const res = mockRes();
    await applyCreditNote(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('exceeds credit note') }));
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
        return chain(approvedCn); // locked re-read; update() resolves 1
      }
      if (tableName === 'edx_credit_note_applications') {
        return chain([99]);
      }
      // Target invoice ₹1,000 with nothing paid → ₹1,000 open.
      if (tableName === 'edx_invoice') {
        return chain([{ id: 20, booking_id: 10, inv_start: '2026-01-01', inv_raised_amnt: '1000' }]);
      }
      if (tableName === 'edx_receipts') return chain([]);
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
    transfer_type: 'CREDIT_BALANCE_TRANSFER',
    reason: 'Relocation',
  };
  const srcBk = { id: 10, user_id: 3 };
  const tgtBk = { id: 20, user_id: 3 };

  // Routes db() by table: source/target bookings, the source's money (₹paid
  // received, nothing billed → ₹paid credit) and edx_internal_transfers calls
  // in order (pending sum, insert, fetch created).
  function routeTransferDb({ paid = '1000', insertChain = chain([101]), created = {} }) {
    const bookings = [chain(srcBk), chain(tgtBk)];
    const transfers = [chain({ total: '0' }), insertChain, chain(created)];
    db.mockImplementation((table) => {
      if (table === 'edx_bookings') return bookings.shift() || chain([]);
      if (table === 'edx_internal_transfers') return transfers.shift() || chain(null);
      if (table === 'edx_invoice') return chain({ total: '0' });
      if (table === 'edx_receipts') return chain({ total: paid });
      if (table === 'edx_transaction_ledger') return chain([]);
      return chain([1]); // edx_approval_history insert
    });
    return insertChain;
  }

  test('returns 400 when the source booking has less credit than the transfer', async () => {
    const insertChain = routeTransferDb({ paid: '200' });   // ₹200 credit, moving ₹500

    const res = mockRes();
    await createInternalTransfer(mockReq(validBody), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

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

    routeTransferDb({ created });

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
        // Awaited grouped queries (balance re-check) → no rows; .first()
        // sums in _createTransactionEntry → zero running balance.
        const c = chain([]);
        c.first = jest.fn().mockResolvedValue({ total_debit: '0', total_credit: '0' });
        return c;
      }
      if (tableName === 'edx_internal_transfers') {
        return chain(pendingTransfer); // locked re-read; update() resolves 1
      }
      // Source booking lock, and ₹10,000 received into it.
      if (tableName === 'edx_bookings') return chain({ id: 10 });
      if (tableName === 'edx_invoice') return chain({ total: '0' });
      if (tableName === 'edx_receipts') return chain({ total: '10000' });
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

  test('returns 403 when the approver requested the transfer (maker-checker)', async () => {
    db.mockReturnValueOnce(chain({ ...pendingTransfer, requested_by: 99 }));

    const res = mockRes();
    await approveInternalTransfer(mockReq({ transfer_id: 30, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
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

// ─────────────────────────────────────────────────────────────────────────────
// bulkGenerateInvoices — only bills days no existing invoice covers
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkGenerateInvoices', () => {
  const { bulkGenerateInvoices } = require('../../controllers/web_app/accountsController');

  // Routes db()/trx() by table; returns the rows inserted into edx_invoice.
  function setupBulk({ booking, invoices }) {
    db.mockImplementation((table) => {
      if (table === 'edx_period_closing') return chain(undefined);
      if (table === 'edx_bookings') return chain([booking]);
      return chain([]);
    });
    const inserted = [];
    const trx = jest.fn((table) => {
      if (table === 'edx_bookings') return chain({ id: booking.id });
      if (table === 'edx_invoice') {
        const c = chain(invoices);
        c.insert = jest.fn((row) => { inserted.push(row); return Promise.resolve([1]); });
        return c;
      }
      return chain([]);
    });
    withTransaction.mockImplementation(async (fn) => fn(trx));
    return inserted;
  }

  test('does not re-bill a booking already invoiced for its whole period', async () => {
    // Activation invoiced 15 Jan → 14 Apr; February must not be billed again.
    const inserted = setupBulk({
      booking: { id: 7, final_rate: '1000', service_start_date: '2026-01-15', service_end_date: '2026-04-14' },
      invoices: [{ inv_start: '2026-01-15', inv_end: '2026-04-14' }],
    });

    const res = mockRes();
    await bulkGenerateInvoices(mockReq({ month: 2, year: 2026 }), res);

    expect(inserted).toHaveLength(0);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ generated: 0 }));
  });

  test('bills the whole month for an open-ended booking with no invoice in it', async () => {
    const inserted = setupBulk({
      booking: { id: 8, final_rate: '1000', service_start_date: '2026-01-15', service_end_date: null },
      invoices: [{ inv_start: '2026-01-15', inv_end: '2026-01-31' }],
    });

    const res = mockRes();
    await bulkGenerateInvoices(mockReq({ month: 2, year: 2026 }), res);

    expect(inserted).toEqual([
      expect.objectContaining({
        booking_id: 8, inv_start: '2026-02-01', inv_end: '2026-02-28', inv_raised_amnt: 28000,
      }),
    ]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ generated: 1 }));
  });

  test('bills only the uncovered days when part of the month is invoiced', async () => {
    const inserted = setupBulk({
      booking: { id: 9, final_rate: '1000', service_start_date: '2026-01-01', service_end_date: null },
      invoices: [{ inv_start: '2026-02-01', inv_end: '2026-02-10' }],
    });

    await bulkGenerateInvoices(mockReq({ month: 2, year: 2026 }), mockRes());

    expect(inserted).toEqual([
      expect.objectContaining({ inv_start: '2026-02-11', inv_end: '2026-02-28', inv_raised_amnt: 18000 }),
    ]);
  });

  test('rejects an invalid month with 400', async () => {
    const res = mockRes();
    await bulkGenerateInvoices(mockReq({ month: 13, year: 2026 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write-off approval: balance re-check and the legacy endpoint's ledger post
// ─────────────────────────────────────────────────────────────────────────────

describe('write-off approval re-checks the balance and always posts to the ledger', () => {
  const { approveWriteOff, updateWriteOffStatus } = require('../../controllers/web_app/accountsController');
  const wo = {
    id: 56, booking_id: 10, user_id: 3, write_off_amount: '5000',
    status: 'Pending', reason: 'Bad debt', approval_level: 'L2', created_by: 1,
  };

  // Transaction mock for one booking billed `billed` and paid `paid`; returns
  // the rows inserted into edx_transaction_ledger.
  function trxFor({ billed, paid }) {
    const ledgerRows = [];
    const trx = jest.fn((table) => {
      if (table === 'edx_write_offs') return chain(wo);
      if (table === 'edx_bookings') return chain({ id: 10, user_id: 3 });
      if (table === 'edx_invoice') return chain({ total: billed });
      if (table === 'edx_receipts') return chain({ total: paid });
      if (table === 'edx_transaction_ledger') {
        const c = chain([]);
        c.first = jest.fn().mockResolvedValue({ total_debit: '0', total_credit: '0' });
        c.insert = jest.fn((row) => { ledgerRows.push(row); return Promise.resolve([77]); });
        return c;
      }
      return chain([1]);
    });
    trx.raw = jest.fn().mockReturnValue('RAW_EXPR');
    withTransaction.mockImplementation(async (fn) => fn(trx));
    return ledgerRows;
  }

  test('approveWriteOff refuses a write-off larger than the outstanding balance', async () => {
    db.mockReturnValueOnce(chain(wo));
    const ledgerRows = trxFor({ billed: '3000', paid: '0' });   // owes ₹3,000, write-off ₹5,000

    const res = mockRes();
    await approveWriteOff(mockReq({ write_off_id: 56, action: 'Approved' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(ledgerRows).toHaveLength(0);
  });

  test('legacy updateWriteOffStatus approval posts the WRITE_OFF ledger entry', async () => {
    db.mockReturnValueOnce(chain(wo));
    const ledgerRows = trxFor({ billed: '10000', paid: '0' });

    const res = mockRes();
    await updateWriteOffStatus(mockReq({ id: 56, status: 'Approved' }), res);

    expect(ledgerRows).toEqual([
      expect.objectContaining({ transaction_type: 'WRITE_OFF', direction: 'CREDIT', amount: 5000, booking_id: 10 }),
    ]);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Write-off approved successfully.' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyCreditNote: same client only, never past the invoice's open balance
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCreditNote limits', () => {
  const { applyCreditNote } = require('../../controllers/web_app/accountsController');
  const body = { credit_note_id: 5, target_booking_id: 10, target_invoice_id: 20, amount_to_apply: 300 };
  const cn = { id: 5, booking_id: 11, amount: '500', remaining_amount: '500', used_amount: '0', status: 'Approved' };

  test('refuses a credit note that belongs to a different client', async () => {
    db.mockReturnValueOnce(chain(cn))                                   // credit note
      .mockReturnValueOnce(chain({ id: 20, booking_id: 10 }))            // target invoice
      .mockReturnValueOnce(chain({ id: 10, user_id: 3 }))                // target booking (client 3)
      .mockReturnValueOnce(chain({ user_id: 4 }));                       // credit note's booking (client 4)

    const res = mockRes();
    await applyCreditNote(mockReq(body), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('refuses more than the invoice still has open', async () => {
    db.mockReturnValueOnce(chain(cn))
      .mockReturnValueOnce(chain({ id: 20, booking_id: 10 }))
      .mockReturnValueOnce(chain({ id: 10, user_id: 3 }))
      .mockReturnValueOnce(chain({ user_id: 3 }));                       // same client

    const appInsert = jest.fn().mockResolvedValue([1]);
    const trx = jest.fn((table) => {
      if (table === 'edx_credit_notes') return chain(cn);
      // ₹1,000 invoice with ₹800 already received → ₹200 open; applying ₹300.
      if (table === 'edx_invoice') return chain([{ id: 20, booking_id: 10, inv_start: '2026-01-01', inv_raised_amnt: '1000' }]);
      if (table === 'edx_receipts') return chain([{ booking_id: 10, invoice_id: 20, total_amount: '800' }]);
      if (table === 'edx_credit_note_applications') { const c = chain([]); c.insert = appInsert; return c; }
      return chain(null);
    });
    trx.raw = jest.fn().mockReturnValue('RAW_EXPR');
    withTransaction.mockImplementation(async (fn) => fn(trx));

    const res = mockRes();
    await applyCreditNote(mockReq(body), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(appInsert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getInvoices — paid / balance / status are per invoice, not per booking
// ─────────────────────────────────────────────────────────────────────────────

describe('getInvoices per-invoice balances', () => {
  const { getInvoices } = require('../../controllers/web_app/accountsController');

  test('a payment is not credited to every invoice of the booking', async () => {
    // Two ₹30,000 invoices on booking 10, one unlinked ₹30,000 receipt.
    const rows = [
      { invoice_db_id: 2, booking_id: 10, total_amount: '30000', due_date: '2099-03-15' },
      { invoice_db_id: 1, booking_id: 10, total_amount: '30000', due_date: '2099-02-15' },
    ];
    db.mockImplementation((table) => {
      if (table === 'edx_invoice as i') return chain(rows);
      if (table === 'edx_invoice') {
        return chain([
          { id: 1, booking_id: 10, inv_start: '2026-01-01', inv_raised_amnt: '30000' },
          { id: 2, booking_id: 10, inv_start: '2026-02-01', inv_raised_amnt: '30000' },
        ]);
      }
      if (table === 'edx_receipts') return chain([{ booking_id: 10, invoice_id: null, total_amount: '30000' }]);
      return chain([]);
    });

    const res = mockRes();
    await getInvoices(mockReq({}, {}), res);

    const out = res.json.mock.calls[0][0];
    const byId = Object.fromEntries(out.map((r) => [r.invoice_db_id, r]));
    expect(byId[1]).toEqual(expect.objectContaining({ paid_amount: 30000, balance_due: 0, status: 'Paid' }));
    expect(byId[2]).toEqual(expect.objectContaining({ paid_amount: 0, balance_due: 30000, status: 'Pending' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Receipts: recorded payments can be cancelled (maker-checker)
// ─────────────────────────────────────────────────────────────────────────────

describe('updateReceiptStatus', () => {
  const { updateReceiptStatus } = require('../../controllers/web_app/accountsController');
  const approved = { id: 12, booking_id: 10, total_amount: '1000', status: 'Approved', created_by: 1 };

  function routeReceiptDb({ receipt, updated = 1, paid = '1000', committed = '0' }) {
    const updateSpy = jest.fn().mockResolvedValue(updated);
    let receiptCalls = 0;
    db.mockImplementation((table) => {
      if (table === 'edx_receipts') {
        receiptCalls++;
        if (receiptCalls === 1) return chain(receipt);           // fetch
        const c = chain({ total: paid });                         // refundable sum / update
        c.update = updateSpy;
        return c;
      }
      if (table === 'edx_refunds') return chain({ total: committed });
      return chain([]);
    });
    return updateSpy;
  }

  test('a different user can cancel a recorded payment', async () => {
    const updateSpy = routeReceiptDb({ receipt: approved });
    const res = mockRes();
    await updateReceiptStatus(mockReq({ id: 12, status: 'Cancelled' }), res);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'Cancelled' }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Receipt cancelled successfully.' }));
  });

  test('the user who recorded a payment cannot cancel it', async () => {
    const updateSpy = routeReceiptDb({ receipt: { ...approved, created_by: 99 } });
    const res = mockRes();
    await updateReceiptStatus(mockReq({ id: 12, status: 'Cancelled' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('cannot cancel a payment that refunds were raised against', async () => {
    const updateSpy = routeReceiptDb({ receipt: approved, paid: '1000', committed: '600' });
    const res = mockRes();
    await updateReceiptStatus(mockReq({ id: 12, status: 'Cancelled' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
