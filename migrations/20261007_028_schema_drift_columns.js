/**
 * Migration 028 — schema drift: columns the code uses but no migration created.
 *
 *   edx_support_category.app_type   VARCHAR(20) NULL   'web' | 'client' | 'hp' | 'all'
 *                                                     (portal category lists)
 *   edx_support_category.status     TINYINT DEFAULT 1  (1 = active)
 *   edx_support_requests.created_by INT NULL           (client / caregiver id on
 *                                                     portal-raised tickets)
 *   edx_support_requests.updated_by INT NULL           (staff id on status change)
 *   edx_support_requests.updated_on VARCHAR(30) NULL   (already in 001; guarded)
 *
 * Every column is guarded with hasColumn, so the migration is a no-op on a DB
 * that was altered by hand. down() drops only the columns this file lists.
 */

const COLUMNS = {
  edx_support_category: {
    app_type: (t) => t.string('app_type', 20).nullable(),
    status:   (t) => t.tinyint('status').defaultTo(1),
  },
  edx_support_requests: {
    created_by: (t) => t.integer('created_by').nullable(),
    updated_by: (t) => t.integer('updated_by').nullable(),
    updated_on: (t) => t.string('updated_on', 30).nullable(),
  },
};

exports.up = async function (knex) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const [name, add] of Object.entries(cols)) {
      if (await knex.schema.hasColumn(table, name)) continue;
      await knex.schema.alterTable(table, (t) => add(t));
    }
  }
};

exports.down = async function (knex) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const name of Object.keys(cols)) {
      // updated_on belongs to the 001 baseline — never drop it here.
      if (table === 'edx_support_requests' && name === 'updated_on') continue;
      if (await knex.schema.hasColumn(table, name)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(name));
      }
    }
  }
};
