const db = require('../config/db');

/**
 * withTransaction
 * Wraps a callback in a Knex transaction.
 * Commits on success, rolls back on any error, then re-throws.
 *
 * Usage:
 *   await withTransaction(async (trx) => {
 *     await trx('table_a').insert({...});
 *     await trx('table_b').insert({...});
 *   });
 */
const withTransaction = async (callback) => {
  const trx = await db.transaction();
  try {
    const result = await callback(trx);
    await trx.commit();
    return result;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
};

module.exports = withTransaction;
