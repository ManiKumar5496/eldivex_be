/**
 * Migration 031 — edx_report_schedules.
 *
 * Persists each org's weekly-report schedule (previously an in-memory Map that
 * was lost on restart and only ever read for org 1). One row per org.
 *   recipients   — JSON array of e-mail addresses; NULL/empty = the org's admins
 *   day_of_week  — 0 (Sun) … 6 (Sat), JS / cron numbering
 *   hour         — 0 … 23, server local time
 *   last_sent_on — YYYY-MM-DD of the last send (stops a double send per day)
 */

const TABLE = 'edx_report_schedules';

exports.up = async function (knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('org_id').unsigned().notNullable();
    t.tinyint('enabled').notNullable().defaultTo(0);
    t.text('recipients').nullable();
    t.tinyint('day_of_week').notNullable().defaultTo(1);
    t.tinyint('hour').notNullable().defaultTo(8);
    t.string('last_sent_on', 30).nullable();
    t.integer('updated_by').nullable();
    t.string('updated_on', 30).nullable();
    t.unique(['org_id'], 'uq_report_schedule_org');
    t.index(['enabled', 'day_of_week', 'hour'], 'idx_report_schedule_due');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
