'use strict';

jest.mock('../../config/db');
jest.mock('../../utils/dateTime', () => ({
  getCurrentDateTime: jest.fn().mockReturnValue('2026-05-25 10:00:00'),
}));

const {
  refreshHpRegStatus,
  releaseBookingCaregivers,
  invoicedDaysIn,
  attendanceBlockReason,
} = require('../../utils/bookingLifecycle');

// Minimal knex-like fake: per table, the rows a read resolves to; writes are
// recorded per table on `.writes`.
function fakeConn(rowsByTable = {}) {
  const writes = {};
  const conn = jest.fn((name) => {
    const table = String(name).split(/\s+as\s+/i)[0];
    const q = {};
    ['where', 'whereIn', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.update = jest.fn((row) => {
      (writes[table] = writes[table] || []).push({ row, whereIn: q.whereIn.mock.calls });
      return Promise.resolve(1);
    });
    q.then = (ok, fail) => Promise.resolve(rowsByTable[table] ?? []).then(ok, fail);
    return q;
  });
  conn.writes = writes;
  return conn;
}

describe('refreshHpRegStatus', () => {
  test.each([
    [[], 2, 'no other booking → Approved, offered by matching again'],
    [[{ status: 4 }], 5, 'still active on another booking'],
    [[{ status: 1 }], 6, 'still shortlisted elsewhere'],
  ])('%j → %i (%s)', async (open, expected) => {
    const conn = fakeConn({ edx_booking_hp: open });
    await refreshHpRegStatus(conn, { orgId: 1, hpIds: [7], userId: 99 });
    const [w] = conn.writes.edx_hp_registration;
    expect(w.row).toEqual(expect.objectContaining({ hp_reg_status: expected }));
    // Pending (1), rejected (3) and terminated (4) caregivers are never touched.
    expect(w.whereIn).toEqual([['hp_reg_status', [2, 5, 6]]]);
  });
});

describe('releaseBookingCaregivers', () => {
  test('releases every open assignment; only the active one gets an end date', async () => {
    const conn = fakeConn({
      edx_booking_hp: [{ id: 1, hp_unique_id: 7, status: 4 }, { id: 2, hp_unique_id: 8, status: 2 }],
    });
    const released = await releaseBookingCaregivers(conn, { orgId: 1, bookingId: 5, lastDay: '2026-06-10', userId: 99 });

    expect(released).toEqual([7, 8]);
    expect(conn.writes.edx_booking_hp.map((w) => w.row)).toEqual([
      expect.objectContaining({ status: 5, end_date_actual: '2026-06-10' }),
      expect.not.objectContaining({ end_date_actual: expect.anything() }),
    ]);
    expect(conn.writes.edx_hp_registration).toHaveLength(2);
  });

  test('does nothing for a booking without caregivers', async () => {
    const conn = fakeConn({ edx_booking_hp: [] });
    expect(await releaseBookingCaregivers(conn, { orgId: 1, bookingId: 5, lastDay: '2026-06-10' })).toEqual([]);
    expect(conn.writes).toEqual({});
  });
});

describe('invoicedDaysIn', () => {
  const d = (s) => { const [y, m, day] = s.split('-').map(Number); return new Date(y, m - 1, day); };

  test('counts only the days the invoices cover, once each', async () => {
    const conn = fakeConn({
      edx_invoice: [
        { id: 3, inv_start: '2026-06-01', inv_end: '2026-07-03' },
        { id: 4, inv_start: '2026-07-02', inv_end: '2026-07-05' },   // overlaps the first
      ],
    });
    // Jul 1 – Jul 10: Jul 1–5 billed → 5 days; first covering invoice #3.
    expect(await invoicedDaysIn(conn, 1, 5, d('2026-07-01'), d('2026-07-10')))
      .toEqual({ days: 5, invoiceId: 3 });
  });

  test('no invoices → nothing billed', async () => {
    const conn = fakeConn({ edx_invoice: [] });
    expect(await invoicedDaysIn(conn, 1, 5, d('2026-07-01'), d('2026-07-10'))).toEqual({ days: 0, invoiceId: null });
  });
});

describe('attendanceBlockReason', () => {
  const blocks = new Map([
    [5, { closedAfter: new Date(2026, 5, 10), holds: [] }],
    [6, { closedAfter: null, holds: [{ from: new Date(2026, 6, 1), to: new Date(2026, 6, 10) }] }],
  ]);

  test('blocks days after a cancelled booking\'s last service day, not the day itself', () => {
    expect(attendanceBlockReason(blocks, 5, '2026-06-10')).toBeNull();
    expect(attendanceBlockReason(blocks, 5, '2026-06-11')).toMatch(/cancelled; its last service day was 2026-06-10/);
  });

  test('blocks days inside a hold, inclusive', () => {
    expect(attendanceBlockReason(blocks, 6, '2026-06-30')).toBeNull();
    expect(attendanceBlockReason(blocks, 6, '2026-07-01')).toMatch(/on hold from 2026-07-01 to 2026-07-10/);
    expect(attendanceBlockReason(blocks, 6, '2026-07-10')).not.toBeNull();
    expect(attendanceBlockReason(blocks, 6, '2026-07-11')).toBeNull();
  });

  test('bookings without blocks are open', () => {
    expect(attendanceBlockReason(blocks, 99, '2026-07-01')).toBeNull();
  });
});
