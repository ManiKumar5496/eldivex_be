'use strict';

jest.mock('../../config/db');
jest.mock('../../utils/dateTime', () => ({
  getCurrentDateTime: jest.fn().mockReturnValue('2026-10-29 10:00:00'),
}));
jest.mock('../../utils/orgScope', () => ({ getOrgId: jest.fn(() => 1) }));
jest.mock('../../utils/notify', () => ({ notifyOrgAdmins: jest.fn() }));
jest.mock('../../logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../../utils/planUsage', () => ({
  countBookingsThisMonth: jest.fn().mockResolvedValue(4),
  countActiveHPs: jest.fn().mockResolvedValue(3),
}));
jest.mock('../../utils/orgPlan', () => ({
  ...jest.requireActual('../../utils/orgPlan'),
  latestSubscription: jest.fn(),
  applyOrgPlan: jest.fn(),
}));

const db = require('../../config/db');
const { getOrgId } = require('../../utils/orgScope');
const { notifyOrgAdmins } = require('../../utils/notify');
const orgPlan = require('../../utils/orgPlan');
const requireSuperAdmin = require('../../middlewares/requireSuperAdmin');
const {
  requestPlanExtension, cancelPlanRequest, resolvePlanRequest,
} = require('../../controllers/web_app/planRequestController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const req = (body = {}, params = {}, extra = {}) =>
  ({ body, params, query: {}, login_data: { id: 9, org_id: 1, role_id: 1 }, ...extra });

// Knex-like fake per table: `first` / `rows` / `updated`; writes recorded.
function fakeTables(config = {}) {
  const writes = {};
  db.mockImplementation((name) => {
    const table = String(name).split(/\s+as\s+/i)[0];
    const cfg = config[table] || {};
    const q = {};
    ['where', 'whereIn', 'leftJoin', 'select', 'orderBy', 'limit']
      .forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(() => Promise.resolve(cfg.first ?? null));
    q.insert = jest.fn((row) => { (writes[table] = writes[table] || []).push({ insert: row }); return Promise.resolve([77]); });
    q.update = jest.fn((row) => { (writes[table] = writes[table] || []).push({ update: row }); return Promise.resolve(cfg.updated ?? 1); });
    q.then = (ok, fail) => Promise.resolve(cfg.rows ?? []).then(ok, fail);
    return q;
  });
  return writes;
}

const currentSub = {
  subscription_id: 5, plan_id: 2, plan_name: 'Growth', status: 'active', expires_on: '2026-11-30',
};

beforeEach(() => {
  jest.clearAllMocks();
  getOrgId.mockReturnValue(1);
});

describe('requireSuperAdmin', () => {
  test.each([
    ['Super Admin', true],
    [' super admin ', true],
    ['Accountant', false],
  ])('role "%s" → allowed: %s', async (roleName, allowed) => {
    fakeTables({ edx_web_emp_roles: { first: { role_name: roleName } } });
    const next = jest.fn();
    const res = mockRes();
    await requireSuperAdmin({ ...req(), staff_role_id: 4 }, res, next);
    expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requestPlanExtension', () => {
  test('rejects a period other than 1, 3, 6 or 12 months', async () => {
    const res = mockRes();
    await requestPlanExtension(req({ extend_months: 2 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('refuses a second request while one is pending', async () => {
    orgPlan.latestSubscription.mockResolvedValue(currentSub);
    const writes = fakeTables({ edx_plan_requests: { first: { id: 3 } } });
    const res = mockRes();
    await requestPlanExtension(req({ extend_months: 3 }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(writes.edx_plan_requests).toBeUndefined();
  });

  test('records an extension of the current plan by default', async () => {
    orgPlan.latestSubscription.mockResolvedValue(currentSub);
    const writes = fakeTables({ edx_plan_requests: { first: null } });
    const res = mockRes();
    await requestPlanExtension(req({ extend_months: 6, notes: ' Renewing for the year ' }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(writes.edx_plan_requests[0].insert).toEqual(expect.objectContaining({
      org_id: 1, subscription_id: 5, current_plan_id: 2, requested_plan_id: 2,
      extend_months: 6, notes: 'Renewing for the year', status: 'PENDING', requested_by: 9,
    }));
  });

  test('refuses a plan that is not available', async () => {
    orgPlan.latestSubscription.mockResolvedValue(currentSub);
    fakeTables({ edx_plans: { first: null } });
    const res = mockRes();
    await requestPlanExtension(req({ extend_months: 1, plan_id: 9 }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('cancelPlanRequest', () => {
  test('only a pending request of the caller org can be withdrawn', async () => {
    fakeTables({ edx_plan_requests: { updated: 0 } });
    const res = mockRes();
    await cancelPlanRequest(req({}, { id: '3' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('resolvePlanRequest', () => {
  const pending = { id: 3, org_id: 1, requested_plan_id: 2, extend_months: 3, status: 'PENDING' };
  const plan = { id: 2, name: 'Growth' };

  test('approving extends from the current expiry and marks the request approved in the same transaction', async () => {
    orgPlan.latestSubscription.mockResolvedValue(currentSub);
    const trxUpdate = jest.fn().mockResolvedValue(1);
    orgPlan.applyOrgPlan.mockImplementation(async ({ inTransaction }) => {
      const trx = jest.fn(() => ({ where: jest.fn().mockReturnThis(), update: trxUpdate }));
      await inTransaction(trx, 88);
      return { subscriptionId: 88 };
    });
    fakeTables({ edx_plan_requests: { first: pending }, edx_plans: { first: plan } });
    const res = mockRes();
    await resolvePlanRequest(req({ action: 'approve', notes: 'Paid' }, { id: '3' }), res);

    expect(orgPlan.applyOrgPlan).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 1, plan, status: 'active', expiresOn: '2027-02-28',
    }));
    expect(trxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'APPROVED', resolved_by: 9, new_expires_on: '2027-02-28', resolution_notes: 'Paid',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ expires_on: '2027-02-28' }));
    expect(notifyOrgAdmins).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'subscription' }));
  });

  test('the owner can set the expiry date directly', async () => {
    orgPlan.applyOrgPlan.mockResolvedValue({ subscriptionId: 88 });
    fakeTables({ edx_plan_requests: { first: pending }, edx_plans: { first: plan } });
    const res = mockRes();
    await resolvePlanRequest(req({ action: 'APPROVE', expires_on: '2027-06-30' }, { id: '3' }), res);
    expect(orgPlan.applyOrgPlan).toHaveBeenCalledWith(expect.objectContaining({ expiresOn: '2027-06-30' }));
  });

  test('a downgrade the org no longer fits is refused', async () => {
    orgPlan.latestSubscription.mockResolvedValue(currentSub);
    orgPlan.applyOrgPlan.mockResolvedValue({ blocked: '30 active bookings exceed the Starter limit of 20' });
    fakeTables({ edx_plan_requests: { first: pending }, edx_plans: { first: plan } });
    const res = mockRes();
    await resolvePlanRequest(req({ action: 'APPROVE' }, { id: '3' }), res);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('rejecting records the decision and tells the org', async () => {
    const writes = fakeTables({ edx_plan_requests: { first: pending } });
    const res = mockRes();
    await resolvePlanRequest(req({ action: 'REJECT', notes: 'Payment pending' }, { id: '3' }), res);
    expect(writes.edx_plan_requests[0].update).toEqual(expect.objectContaining({
      status: 'REJECTED', resolution_notes: 'Payment pending',
    }));
    expect(orgPlan.applyOrgPlan).not.toHaveBeenCalled();
    expect(notifyOrgAdmins).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Plan request declined' }));
  });

  test('a request that is no longer pending cannot be resolved', async () => {
    fakeTables({ edx_plan_requests: { first: { ...pending, status: 'CANCELLED' } } });
    const res = mockRes();
    await resolvePlanRequest(req({ action: 'APPROVE' }, { id: '3' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('extendedExpiry', () => {
  const { extendedExpiry } = jest.requireActual('../../utils/orgPlan');
  const today = new Date(2026, 9, 29);
  test('extends from a future expiry, clamped to the month end', () => {
    expect(extendedExpiry('2026-11-30', 3, today)).toBe('2027-02-28');
  });
  test('extends from today once expired', () => {
    expect(extendedExpiry('2026-09-01', 1, today)).toBe('2026-11-29');
  });
  test('no end date stays open-ended', () => {
    expect(extendedExpiry(null, 6, today)).toBeNull();
  });
});
