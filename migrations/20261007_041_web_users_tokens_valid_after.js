/**
 * 20261007_041_web_users_tokens_valid_after.js
 *
 * Session revocation for staff: middlewares/auth.js rejects any staff JWT whose
 * iat is earlier than edx_web_app_users.tokens_valid_after. The column is set
 * to "now" when a user is terminated or resets their password. NULL = no
 * revocation (all unexpired tokens valid), so existing sessions are unaffected.
 *
 * Idempotent (hasColumn guard); down() drops the column.
 */

const TABLE = 'edx_web_app_users';
const COLUMN = 'tokens_valid_after';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dateTime(COLUMN).nullable();
  });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN);
  });
};
