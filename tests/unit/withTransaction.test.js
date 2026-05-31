/**
 * Unit tests — utils/withTransaction.js (Phase 1.6)
 * Tests that the helper commits on success and rolls back on error.
 */

describe('withTransaction', () => {
  let mockTrx;
  let mockDb;

  beforeEach(() => {
    // Build a mock Knex transaction object
    mockTrx = {
      commit:   jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    // Mock the db module before requiring withTransaction
    mockDb = { transaction: jest.fn().mockResolvedValue(mockTrx) };

    jest.resetModules();
    jest.mock('../../config/db', () => mockDb);
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('commits when callback succeeds', async () => {
    const withTransaction = require('../../utils/withTransaction');
    const callback = jest.fn().mockResolvedValue('ok');

    const result = await withTransaction(callback);

    expect(callback).toHaveBeenCalledWith(mockTrx);
    expect(mockTrx.commit).toHaveBeenCalledTimes(1);
    expect(mockTrx.rollback).not.toHaveBeenCalled();
    expect(result).toBe('ok');
  });

  test('rolls back and rethrows when callback throws', async () => {
    const withTransaction = require('../../utils/withTransaction');
    const error = new Error('DB insert failed');
    const callback = jest.fn().mockRejectedValue(error);

    await expect(withTransaction(callback)).rejects.toThrow('DB insert failed');

    expect(mockTrx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTrx.commit).not.toHaveBeenCalled();
  });

  test('passes the transaction object to the callback', async () => {
    const withTransaction = require('../../utils/withTransaction');
    let receivedTrx;
    await withTransaction(async (trx) => { receivedTrx = trx; });

    expect(receivedTrx).toBe(mockTrx);
  });

  test('returns the callback return value on success', async () => {
    const withTransaction = require('../../utils/withTransaction');
    const result = await withTransaction(async () => 42);
    expect(result).toBe(42);
  });
});
