/**
 * 20260609_014_hp_self_service.js
 *
 * Tables backing the caregiver (Health Professional) self-service portal:
 *
 *   • edx_hp_login_otp     — short-lived, hashed, single-use phone-login OTPs
 *   • edx_hp_bank_details  — caregiver payout bank/UPI details (one per org+hp)
 *   • edx_hp_leave         — caregiver leave / unavailability requests
 *   • edx_hp_notifications — in-app notification feed (polling now, FCM later)
 *
 * All tables are org-scoped (org_id) to keep each organisation's caregivers
 * isolated, mirroring the rest of the schema (Phase 5 multi-tenancy).
 * Idempotent via hasTable guards so re-running is safe.
 */

exports.up = async (knex) => {
  // ── 1. Login OTPs ───────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_hp_login_otp'))) {
    await knex.schema.createTable('edx_hp_login_otp', (t) => {
      t.increments('id').primary();
      t.integer('org_id').unsigned().notNullable();
      t.integer('hp_id').unsigned().notNullable().comment('FK → edx_hp_registration.hp_reg_id');
      t.string('phone', 15).notNullable().comment('Normalised 10-digit number');
      t.string('otp_hash', 100).notNullable().comment('bcrypt hash — OTP never stored in plaintext');
      t.datetime('expires_at').notNullable();
      t.integer('attempts').defaultTo(0);
      t.tinyint('consumed').defaultTo(0);
      t.string('created_on', 30).nullable();
      t.index(['org_id', 'phone'], 'idx_hp_otp_org_phone');
    });
  }

  // ── 2. Bank / payout details ─────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_hp_bank_details'))) {
    await knex.schema.createTable('edx_hp_bank_details', (t) => {
      t.increments('id').primary();
      t.integer('org_id').unsigned().notNullable();
      t.integer('hp_id').unsigned().notNullable();
      t.string('account_holder_name', 150).nullable();
      t.string('account_number', 30).nullable();
      t.string('ifsc', 20).nullable();
      t.string('bank_name', 150).nullable();
      t.string('upi_id', 100).nullable();
      t.string('status', 20).defaultTo('pending').comment('pending | verified | rejected');
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
      // One bank record per caregiver per org → enables UPSERT.
      t.unique(['org_id', 'hp_id'], 'uq_hp_bank_org_hp');
    });
  }

  // ── 3. Leave / unavailability requests ───────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_hp_leave'))) {
    await knex.schema.createTable('edx_hp_leave', (t) => {
      t.increments('id').primary();
      t.integer('org_id').unsigned().notNullable();
      t.integer('hp_id').unsigned().notNullable();
      t.date('from_date').notNullable();
      t.date('to_date').notNullable();
      t.text('reason').nullable();
      t.enu('status', ['Pending', 'Approved', 'Rejected']).defaultTo('Pending');
      t.integer('reviewed_by').nullable();
      t.string('created_on', 30).nullable();
      t.string('updated_on', 30).nullable();
      t.index(['org_id', 'hp_id'], 'idx_hp_leave_org_hp');
    });
  }

  // ── 4. In-app notifications ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_hp_notifications'))) {
    await knex.schema.createTable('edx_hp_notifications', (t) => {
      t.increments('id').primary();
      t.integer('org_id').unsigned().notNullable();
      t.integer('hp_id').unsigned().notNullable();
      t.string('type', 50).nullable().comment('booking | attendance | payout | ticket | system');
      t.string('title', 200).nullable();
      t.text('body').nullable();
      t.json('data').nullable();
      t.tinyint('read_flag').defaultTo(0);
      t.string('created_on', 30).nullable();
      t.index(['org_id', 'hp_id', 'read_flag'], 'idx_hp_notif_org_hp_read');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('edx_hp_notifications');
  await knex.schema.dropTableIfExists('edx_hp_leave');
  await knex.schema.dropTableIfExists('edx_hp_bank_details');
  await knex.schema.dropTableIfExists('edx_hp_login_otp');
};
