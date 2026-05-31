/**
 * Unit tests — middlewares/validateRequest.js (Phase 1.3)
 * Tests that the middleware returns 422 with structured errors on bad input
 * and calls next() on valid input.
 */

const Joi = require('joi');
const validate = require('../../middlewares/validateRequest');

const schema = Joi.object({
  name: Joi.string().required(),
  age:  Joi.number().integer().min(0).required(),
});

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

describe('validateRequest middleware', () => {
  test('calls next() when body is valid', () => {
    const req  = { body: { name: 'Priya', age: 30 } };
    const res  = mockRes();
    const next = jest.fn();

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 422 when required field is missing', () => {
    const req  = { body: { age: 30 } };  // name missing
    const res  = mockRes();
    const next = jest.fn();

    validate(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns structured error details', () => {
    const req  = { body: {} };
    const res  = mockRes();
    const next = jest.fn();

    validate(schema)(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'name' }),
          expect.objectContaining({ field: 'age' }),
        ]),
      })
    );
  });

  test('collects all errors (abortEarly: false)', () => {
    const req  = { body: {} };
    const res  = mockRes();
    const next = jest.fn();

    validate(schema)(req, res, next);

    const { details } = res.json.mock.calls[0][0];
    expect(details.length).toBeGreaterThanOrEqual(2);
  });

  test('allows extra fields through (allowUnknown: true)', () => {
    const req  = { body: { name: 'Asha', age: 25, extra: 'field' } };
    const res  = mockRes();
    const next = jest.fn();

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('returns 422 on wrong type', () => {
    const req  = { body: { name: 'Asha', age: 'not-a-number' } };
    const res  = mockRes();
    const next = jest.fn();

    validate(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    const { details } = res.json.mock.calls[0][0];
    expect(details[0].field).toBe('age');
  });
});
