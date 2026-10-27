'use strict';

jest.mock('../../config/db');
jest.mock('../../utils/withTransaction');
jest.mock('../../utils/notify', () => ({ notifyOrgAdmins: jest.fn() }));
jest.mock('../../utils/dateTime', () => ({
  getCurrentDateTime: jest.fn().mockReturnValue('2026-10-07 10:00:00'),
  toMysqlDate:        jest.fn((v) => v),
}));
jest.mock('../../logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const crypto          = require('crypto');
const db              = require('../../config/db');
const withTransaction = require('../../utils/withTransaction');
const { razorpayWebhook } = require('../../controllers/web_app/accountsController');

const SECRET = 'whsec_test';

function chain(value) {
  const p = Promise.resolve(value);
  const q = {
    where:     jest.fn().mockReturnThis(),
    whereIn:   jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    count:     jest.fn().mockReturnThis(),
    first:     jest.fn().mockResolvedValue(value),
    insert:    jest.fn().mockResolvedValue([501]),
    update:    jest.fn().mockResolvedValue(1),
    then:      p.then.bind(p),
    catch:     p.catch.bind(p),
  };
  return q;
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function signedReq(body, { secret = SECRET, tamper = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return {
    body:    tamper ? { ...body, event: 'payment.captured', tampered: true } : body,
    rawBody: tamper ? Buffer.from(JSON.stringify({ ...body, tampered: true })) : raw,
    headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' },
  };
}

const captured = {
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_1', amount: 150000, notes: { invoice_id: '42', org_id: '7' } } } },
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
});
afterAll(() => { delete process.env.RAZORPAY_WEBHOOK_SECRET; });

describe('razorpayWebhook', () => {
  test('503 when RAZORPAY_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const res = mockRes();
    await razorpayWebhook(signedReq(captured), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('400 when the raw body is missing', async () => {
    const req = signedReq(captured);
    delete req.rawBody;
    const res = mockRes();
    await razorpayWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 when the signature does not match the raw body', async () => {
    const res = mockRes();
    await razorpayWebhook(signedReq(captured, { tamper: true }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Invalid webhook signature.', message: 'Invalid webhook signature.',
    }));
  });

  test('400 when signed with a different secret', async () => {
    const res = mockRes();
    await razorpayWebhook(signedReq(captured, { secret: 'other' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('ignores unrelated events', async () => {
    const res = mockRes();
    await razorpayWebhook(signedReq({ event: 'refund.created', payload: {} }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('creates the receipt in the INVOICE org and records the event', async () => {
    const tables = {};
    const trx = jest.fn().mockImplementation((t) => {
      const map = {
        edx_payment_webhook_events: chain(null),
        edx_invoice:  chain({ id: 42, booking_id: 9, org_id: 7 }),
        edx_bookings: chain({ user_id: 3 }),
        edx_receipts: chain({ cnt: 4 }),
        edx_payment_links: chain(1),
      };
      tables[t] = tables[t] || [];
      const c = map[t] || chain(null);
      tables[t].push(c);
      return c;
    });
    withTransaction.mockImplementation(async (fn) => fn(trx));

    const res = mockRes();
    await razorpayWebhook(signedReq(captured), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const receiptInsert = tables.edx_receipts.find((c) => c.insert.mock.calls.length).insert.mock.calls[0][0];
    expect(receiptInsert).toEqual(expect.objectContaining({
      org_id: 7, invoice_id: 42, booking_id: 9, user_id: 3, total_amount: 1500, transaction_id: 'pay_1',
    }));
    expect(tables.edx_payment_webhook_events[0].insert).toHaveBeenCalledWith(
      expect.objectContaining({ payment_id: 'pay_1', provider: 'razorpay' })
    );
  });

  test('a replayed payment is acknowledged without a second receipt', async () => {
    const dup = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    const receipts = chain(null);
    const trx = jest.fn().mockImplementation((t) => {
      if (t === 'edx_payment_webhook_events') {
        const c = chain(null); c.insert = jest.fn().mockRejectedValue(dup); return c;
      }
      return t === 'edx_receipts' ? receipts : chain(null);
    });
    withTransaction.mockImplementation(async (fn) => fn(trx));

    const res = mockRes();
    await razorpayWebhook(signedReq(captured), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Already processed.' });
    expect(receipts.insert).not.toHaveBeenCalled();
  });

  test('ignores a payment whose notes.org_id does not match the invoice org', async () => {
    const receipts = chain(null);
    const trx = jest.fn().mockImplementation((t) => {
      if (t === 'edx_invoice') return chain({ id: 42, booking_id: 9, org_id: 8 });
      return t === 'edx_receipts' ? receipts : chain(null);
    });
    withTransaction.mockImplementation(async (fn) => fn(trx));

    const res = mockRes();
    await razorpayWebhook(signedReq(captured), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(receipts.insert).not.toHaveBeenCalled();
  });
});
