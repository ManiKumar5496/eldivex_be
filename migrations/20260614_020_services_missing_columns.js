/**
 * The Phase 2.5 services CRUD and the admin UI read/write `description`,
 * `service_rate`, `effective_from_date` and `effective_to_date` on
 * edx_master_services, but only `market_rate` was ever migrated (007). The
 * missing columns made getServicesList / createService fail with
 * "Unknown column" on a fully-migrated DB. This adds them. Idempotent so it is
 * safe on environments where a column was added by hand.
 */
exports.up = async (knex) => {
  const cols = {
    description:         (t) => t.text('description').nullable(),
    service_rate:        (t) => t.decimal('service_rate', 10, 2).nullable(),
    effective_from_date: (t) => t.date('effective_from_date').nullable(),
    effective_to_date:   (t) => t.date('effective_to_date').nullable(),
  };

  const missing = [];
  for (const name of Object.keys(cols)) {
    if (!(await knex.schema.hasColumn('edx_master_services', name))) missing.push(name);
  }
  if (missing.length === 0) return;

  await knex.schema.alterTable('edx_master_services', (t) => {
    missing.forEach((name) => cols[name](t));
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('edx_master_services', (t) => {
    t.dropColumn('description');
    t.dropColumn('service_rate');
    t.dropColumn('effective_from_date');
    t.dropColumn('effective_to_date');
  });
};
