/**
 * Add `care_type` to edx_master_services — the care arrangement, independent of
 * the Normal/Premium `service_type` tier: 'Live-in' | 'Live-out' |
 * 'Liveout-day' | 'Liveout-night'. Nullable. Idempotent.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('edx_master_services', 'care_type'))) {
    await knex.schema.alterTable('edx_master_services', (t) => {
      t.string('care_type', 20).nullable().comment('Live-in / Live-out / Liveout-day / Liveout-night');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.alterTable('edx_master_services', (t) => {
    t.dropColumn('care_type');
  });
};
