/**
 * 20260609_015_client_login_otp.js
 *
 * Backs phone+OTP login for the client (customer) self-service portal.
 * Org-scoped + hashed, single-use OTPs — mirrors edx_hp_login_otp. Idempotent.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('edx_client_login_otp'))) {
    await knex.schema.createTable('edx_client_login_otp', (t) => {
      t.increments('id').primary();
      t.integer('org_id').unsigned().notNullable();
      t.integer('user_id').unsigned().notNullable().comment('FK → edx_client_app_users.id');
      t.string('phone', 15).notNullable();
      t.string('otp_hash', 100).notNullable();
      t.datetime('expires_at').notNullable();
      t.integer('attempts').defaultTo(0);
      t.tinyint('consumed').defaultTo(0);
      t.string('created_on', 30).nullable();
      t.index(['org_id', 'phone'], 'idx_client_otp_org_phone');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('edx_client_login_otp');
};
