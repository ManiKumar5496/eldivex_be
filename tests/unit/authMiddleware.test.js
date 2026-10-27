'use strict';

/**
 * Unit tests — middlewares/auth.js, requireStaff, requireModule, plus the
 * org/branch helpers they rely on. DB is mocked; no connection is made.
 */

process.env.JWT_TOKEN_KEY = 'unit-test-secret-'.padEnd(64, 'x');

jest.mock('../../config/db', () => jest.fn());
jest.mock('../../logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const jwt = require('jsonwebtoken');
const db = require('../../config/db');
const auth = require('../../middlewares/auth');
const requireStaff = require('../../middlewares/requireStaff');
const requireModule = require('../../middlewares/requireModule');
const { getOrgId } = require('../../utils/orgScope');
const applyBranchFilter = require('../../utils/applyBranchFilter');
const { generateToken, generateHpToken, generateClientToken } = require('../../utils/jwt');
const { isAllowedFile } = require('../../middlewares/upload');

const SECRET = process.env.JWT_TOKEN_KEY;

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const reqWith = (payload) => ({
  headers: { authorization: `Bearer ${jwt.sign(payload, SECRET)}` },
});

// Knex-like chain resolving `.first()` / `.select()` to the given values.
function chain({ first, select } = {}) {
  const q = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(first),
    select: jest.fn().mockResolvedValue(select),
  };
  return q;
}

beforeEach(() => {
  db.mockReset();
  auth.invalidateStaffCache();
  requireModule.invalidateModuleCache();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('auth', () => {
  test('401 when the token is missing', async () => {
    const res = mockRes(); const next = jest.fn();
    await auth({ headers: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 when the token is invalid', async () => {
    const res = mockRes(); const next = jest.fn();
    await auth({ headers: { authorization: 'Bearer nope' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('owner token passes without a DB lookup', async () => {
    const req = reqWith({ id: 0, is_owner: true, org_id: 1 });
    const res = mockRes(); const next = jest.fn();
    await auth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(req.login_data.is_owner).toBe(true);
  });

  test.each([
    ['caregiver', { role: 'caregiver', hp_id: 5, org_id: 2 }],
    ['client', { role: 'client', user_id: 5, org_id: 2 }],
    ['legacy client (role_id null)', { id: 5, role_id: null, branch_access: null, org_id: 2 }],
    ['staff without org_id', { id: 5, role_id: 3, branch_access: '1' }],
  ])('rejects %s tokens with 401', async (_, payload) => {
    const res = mockRes(); const next = jest.fn();
    await auth(reqWith(payload), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token for this endpoint' });
    expect(next).not.toHaveBeenCalled();
  });

  test('active staff passes and exposes the current DB role', async () => {
    db.mockReturnValue(chain({ first: { id: 7, user_status: 1, user_role: 4, org_id: 2, tokens_valid_after: null } }));
    const req = reqWith({ id: 7, role_id: 3, branch_access: '1', org_id: 2 });
    const res = mockRes(); const next = jest.fn();
    await auth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.staff_role_id).toBe(4);
    expect(req.login_data.role_id).toBe(3);
  });

  test('terminated staff (user_status 0) gets 401', async () => {
    db.mockReturnValue(chain({ first: { id: 7, user_status: 0, user_role: 3, org_id: 2 } }));
    const res = mockRes(); const next = jest.fn();
    await auth(reqWith({ id: 7, role_id: 3, org_id: 2 }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('token issued before tokens_valid_after is revoked', async () => {
    const iat = Math.floor(Date.now() / 1000) - 3600;
    db.mockReturnValue(chain({ first: { id: 7, user_status: 1, user_role: 3, org_id: 2, tokens_valid_after: new Date() } }));
    const res = mockRes(); const next = jest.fn();
    await auth(reqWith({ id: 7, role_id: 3, org_id: 2, iat }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('token from another org than the user row is rejected', async () => {
    db.mockReturnValue(chain({ first: { id: 7, user_status: 1, user_role: 3, org_id: 9 } }));
    const res = mockRes(); const next = jest.fn();
    await auth(reqWith({ id: 7, role_id: 3, org_id: 2 }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('staff lookup is cached between requests', async () => {
    db.mockReturnValue(chain({ first: { id: 7, user_status: 1, user_role: 3, org_id: 2 } }));
    const payload = { id: 7, role_id: 3, org_id: 2 };
    await auth(reqWith(payload), mockRes(), jest.fn());
    await auth(reqWith(payload), mockRes(), jest.fn());
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('falls back when tokens_valid_after column does not exist yet', async () => {
    const missing = chain();
    missing.first = jest.fn().mockRejectedValue(Object.assign(new Error('bad field'), { code: 'ER_BAD_FIELD_ERROR' }));
    db.mockReturnValueOnce(missing)
      .mockReturnValueOnce(chain({ first: { id: 8, user_status: 1, user_role: 3, org_id: 2 } }));
    const next = jest.fn();
    await auth(reqWith({ id: 8, role_id: 3, org_id: 2 }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('requireStaff', () => {
  test('rejects owner tokens', () => {
    const res = mockRes(); const next = jest.fn();
    requireStaff({ login_data: { is_owner: true, org_id: 1 } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes staff tokens', () => {
    const next = jest.fn();
    requireStaff({ login_data: { id: 1, role_id: 3, org_id: 2 } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('requireModule', () => {
  const staffReq = () => ({ login_data: { id: 1, role_id: 3, org_id: 2 }, staff_role_id: 3 });

  function mockRole(accessList, modules) {
    db.mockImplementation((table) =>
      table === 'edx_web_emp_roles'
        ? chain({ first: accessList === null ? undefined : { access_list: accessList, status: 1 } })
        : chain({ select: modules })
    );
  }

  test('passes when the role grants one of the modules', async () => {
    mockRole('1,4', [{ module_name: 'Home' }, { module_name: 'Billing' }]);
    const next = jest.fn();
    await requireModule('Billing')(staffReq(), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('any-of semantics and case-insensitive names', async () => {
    mockRole('5', [{ module_name: 'bookings ' }]);
    const next = jest.fn();
    await requireModule('Users', 'Bookings')(staffReq(), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('403 MODULE_FORBIDDEN when the module is not granted', async () => {
    mockRole('1', [{ module_name: 'Home' }]);
    const res = mockRes(); const next = jest.fn();
    await requireModule('Billing')(staffReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'You do not have access to this feature', code: 'MODULE_FORBIDDEN' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when the role is not in the caller org', async () => {
    mockRole(null, []);
    const res = mockRes();
    await requireModule('Home')(staffReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('rejects owner tokens', async () => {
    const res = mockRes();
    await requireModule('Home')({ login_data: { is_owner: true } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db).not.toHaveBeenCalled();
  });

  test('caches the module set per org+role', async () => {
    mockRole('1', [{ module_name: 'Home' }]);
    await requireModule('Home')(staffReq(), mockRes(), jest.fn());
    await requireModule('Home')(staffReq(), mockRes(), jest.fn());
    expect(db).toHaveBeenCalledTimes(2); // roles + modules, once
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('org + token helpers', () => {
  test('getOrgId never defaults to org 1', () => {
    expect(getOrgId({ login_data: { id: 1, role_id: 3, org_id: 5 } })).toBe(5);
    expect(getOrgId({ login_data: { is_owner: true, org_id: 1 } })).toBeNull();
    expect(getOrgId({ login_data: { id: 1, role_id: 3 } })).toBeNull();
    expect(getOrgId({})).toBeNull();
  });

  test('token generators refuse a missing org_id', () => {
    expect(() => generateToken({ id: 1, user_role: 3 })).toThrow(/org_id/);
    expect(() => generateHpToken({ hp_id: 1 })).toThrow(/org_id/);
    expect(() => generateClientToken({ user_id: 1 })).toThrow(/org_id/);
    expect(typeof generateToken({ id: 1, user_role: 3, org_id: 2 })).toBe('string');
  });
});

describe('applyBranchFilter', () => {
  const q = () => ({ whereIn: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis() });

  test('role 1 and "all" are unrestricted', () => {
    const a = q(); applyBranchFilter(a, { role_id: 1 }, 'b.branch_id');
    const b = q(); applyBranchFilter(b, { role_id: 3, branch_access: 'all' }, 'b.branch_id');
    expect(a.whereIn).not.toHaveBeenCalled(); expect(a.whereRaw).not.toHaveBeenCalled();
    expect(b.whereIn).not.toHaveBeenCalled(); expect(b.whereRaw).not.toHaveBeenCalled();
  });

  test('CSV restricts to those branches', () => {
    const a = q(); applyBranchFilter(a, { role_id: 3, branch_access: '1, 4' }, 'b.branch_id');
    expect(a.whereIn).toHaveBeenCalledWith('b.branch_id', [1, 4]);
  });

  test.each([null, '', 'NA'])('branch_access %p grants no branches', (ba) => {
    const a = q(); applyBranchFilter(a, { role_id: 3, branch_access: ba }, 'b.branch_id');
    expect(a.whereRaw).toHaveBeenCalledWith('1 = 0');
  });
});

describe('upload allow-list', () => {
  test.each([
    ['a.jpg', 'image/jpeg', true],
    ['a.PNG', 'image/png', true],
    ['a.pdf', 'application/pdf', true],
    ['a.webp', 'image/webp', true],
    ['a.svg', 'image/svg+xml', false],
    ['a.html', 'text/html', false],
    ['a.png', 'text/html', false],
    ['a.jpg.html', 'image/jpeg', false],
  ])('%s (%s) → %p', (name, mime, ok) => {
    expect(isAllowedFile({ originalname: name, mimetype: mime })).toBe(ok);
  });
});
