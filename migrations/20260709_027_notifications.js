/**
 * 027 — In-app notifications (org-wide feed).
 *
 * One polymorphic table for every portal, replacing the HP-only design of
 * edx_hp_notifications (left in place; the HP portal can be migrated later):
 *
 *   recipient_type — 'admin' | 'client' | 'hp'. The admin feed is org-wide:
 *                    recipient_id NULL means "every user of that type in the
 *                    org"; a non-NULL id targets one user (client/HP portals).
 *   type           — semantic bucket the UI maps to an icon/colour:
 *                    booking | extension_due | payment_due | invoice | receipt |
 *                    credit_note | support | subscription | system
 *   data           — JSON string with entity ids / route hints for tap-to-open.
 *   dedupe_key     — set by cron producers so re-runs can't double-insert
 *                    (e.g. 'ext:12:2026-07-09:0'). Unique; NULLs don't collide.
 *
 * Read state is org-wide (not per-user) — small admin teams share one feed.
 * "Clear all" is a hard DELETE scoped to (org_id, recipient_type).
 */

exports.up = async (knex) => {
  if (await knex.schema.hasTable('edx_notifications')) return;

  await knex.schema.createTable('edx_notifications', (t) => {
    t.increments('id').primary();
    t.integer('org_id').unsigned().notNullable();
    t.string('recipient_type', 10).notNullable().defaultTo('admin');
    t.integer('recipient_id').unsigned().nullable();
    t.string('type', 30).notNullable().defaultTo('system');
    t.string('title', 200).notNullable();
    t.string('body', 500).nullable();
    t.text('data').nullable();
    t.string('dedupe_key', 150).nullable();
    t.boolean('read_flag').notNullable().defaultTo(false);
    t.string('created_on', 30).nullable();

    t.index(['org_id', 'recipient_type', 'read_flag'], 'idx_notif_org_recipient_read');
    t.index(['org_id', 'created_on'], 'idx_notif_org_created');
    t.unique(['dedupe_key'], 'uq_notif_dedupe');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('edx_notifications');
};
