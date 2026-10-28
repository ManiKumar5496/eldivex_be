/**
 * Migration 042 — edx_plan_requests.
 *
 * An organisation's Super Admin asks the platform owner to extend (or change)
 * its plan; the owner approves or rejects it from the owner portal.
 *   current_plan_id   — plan at the time of the request
 *   requested_plan_id — plan wanted (same as current for a plain extension)
 *   extend_months     — 1, 3, 6 or 12
 *   status            — PENDING → APPROVED | REJECTED | CANCELLED (by the org)
 *   new_expires_on    — expiry the approval set (NULL = no end date)
 */

const TABLE = 'edx_plan_requests';

exports.up = async function (knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('org_id').unsigned().notNullable();
    t.integer('subscription_id').unsigned().nullable();
    t.integer('current_plan_id').unsigned().nullable();
    t.integer('requested_plan_id').unsigned().notNullable();
    t.tinyint('extend_months').unsigned().notNullable();
    t.string('notes', 500).nullable();
    t.string('status', 20).notNullable().defaultTo('PENDING');
    t.integer('requested_by').nullable();
    t.string('requested_on', 30).nullable();
    t.integer('resolved_by').nullable();
    t.string('resolved_on', 30).nullable();
    t.string('resolution_notes', 500).nullable();
    t.date('new_expires_on').nullable();
    t.index(['org_id', 'status'], 'idx_plan_requests_org_status');
    t.index(['status'], 'idx_plan_requests_status');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
