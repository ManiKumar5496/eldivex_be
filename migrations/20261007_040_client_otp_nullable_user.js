/**
 * 20261007_040_client_otp_nullable_user.js
 *
 * Client OTP self-signup: /clientAuth/requestOtp now sends an OTP to numbers
 * that have no edx_client_app_users row yet, so the OTP row is stored with
 * user_id NULL until verifyOtp creates the client.
 *
 * Idempotent: only alters when the table/column exist and the column is still
 * NOT NULL. down() restores NOT NULL after removing rows that would violate it
 * (unverified signup OTPs — short-lived, safe to drop).
 */

const TABLE = 'edx_client_login_otp';
const COLUMN = 'user_id';

async function isNullable(knex) {
  const [rows] = await knex.raw(
    `SELECT IS_NULLABLE AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [TABLE, COLUMN]
  );
  return rows.length > 0 && rows[0].n === 'YES';
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  if (await isNullable(knex)) return;

  await knex.schema.alterTable(TABLE, (t) => {
    t.integer(COLUMN).unsigned().nullable().comment('FK → edx_client_app_users.id; NULL for a signup OTP').alter();
  });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  if (!(await isNullable(knex))) return;

  await knex(TABLE).whereNull(COLUMN).del();
  await knex.schema.alterTable(TABLE, (t) => {
    t.integer(COLUMN).unsigned().notNullable().comment('FK → edx_client_app_users.id').alter();
  });
};
