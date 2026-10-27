'use strict';

jest.mock('../../config/db');

const db = require('../../config/db');
const { checkPlanLimit, countActiveHPs } = require('../../utils/planUsage');
const { guardOrgHandlers } = require('../../utils/requestOrg');

function chain(value) {
  const p = Promise.resolve(value);
  return {
    join: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(), count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(value),
    then: p.then.bind(p), catch: p.catch.bind(p),
  };
}

afterEach(() => { delete process.env.ENFORCE_PLAN_LIMITS; jest.resetAllMocks(); });

describe('checkPlanLimit', () => {
  test('is a no-op unless ENFORCE_PLAN_LIMITS=true', async () => {
    expect(await checkPlanLimit(5, 'booking')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('0 / null limit means unlimited', async () => {
    process.env.ENFORCE_PLAN_LIMITS = 'true';
    db.mockReturnValueOnce(chain({ name: 'Enterprise', booking_limit: 0, hp_limit: null }));
    expect(await checkPlanLimit(5, 'booking')).toBeNull();
  });

  test('blocks when monthly bookings reach the limit', async () => {
    process.env.ENFORCE_PLAN_LIMITS = 'true';
    db.mockReturnValueOnce(chain({ name: 'Starter', booking_limit: 100, hp_limit: 10 }))
      .mockReturnValueOnce(chain({ cnt: 100 }));
    const r = await checkPlanLimit(5, 'booking');
    expect(r).toEqual(expect.objectContaining({ code: 'PLAN_LIMIT', limit: 100, used: 100 }));
    expect(r.error).toBe(r.message);
  });

  test('allows HP creation below the hp_limit', async () => {
    process.env.ENFORCE_PLAN_LIMITS = 'true';
    db.mockReturnValueOnce(chain({ name: 'Starter', booking_limit: 100, hp_limit: 10 }))
      .mockReturnValueOnce(chain({ cnt: 9 }));
    expect(await checkPlanLimit(5, 'hp')).toBeNull();
  });
});

describe('countActiveHPs', () => {
  test('counts hp_reg_id with hp_reg_status in (2,5,6) — no is_active column', async () => {
    const c = chain({ cnt: '4' });
    db.mockReturnValueOnce(c);
    expect(await countActiveHPs(3)).toBe(4);
    expect(c.whereIn).toHaveBeenCalledWith('hp_reg_status', [2, 5, 6]);
    expect(c.count).toHaveBeenCalledWith('hp_reg_id as cnt');
  });
});

describe('guardOrgHandlers', () => {
  const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };

  test('401 for owner tokens / missing org, passes staff through', async () => {
    const handler = jest.fn();
    const { h, pub } = guardOrgHandlers({ h: handler, pub: handler }, ['pub']);

    const r1 = res();
    await h({ login_data: { is_owner: true, org_id: 1 } }, r1);
    expect(r1.status).toHaveBeenCalledWith(401);

    const r2 = res();
    await h({ login_data: { id: 1, role_id: 2 } }, r2);
    expect(r2.status).toHaveBeenCalledWith(401);

    await h({ login_data: { id: 1, role_id: 2, org_id: 9 } }, res());
    expect(handler).toHaveBeenCalledTimes(1);

    await pub({}, res());
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
