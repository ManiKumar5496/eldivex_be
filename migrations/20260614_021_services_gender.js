/**
 * Add `gender` to edx_master_services — the service gender:
 * 'Male' | 'Female' | 'Any' (default 'Any'). Idempotent.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('edx_master_services', 'gender'))) {
    await knex.schema.alterTable('edx_master_services', (t) => {
      t.string('gender', 20).nullable().comment('Preferred caregiver gender: Male/Female/Any');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.alterTable('edx_master_services', (t) => {
    t.dropColumn('gender');
  });
};
