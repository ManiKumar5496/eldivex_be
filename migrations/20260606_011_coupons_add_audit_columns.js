/**
 * 20260606_011_coupons_add_audit_columns.js
 *
 * Adds missing created_by and created_on columns to edx_master_coupons.
 * The initial schema omitted these while the controller already inserts them.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('edx_master_coupons', (t) => {
    t.integer('created_by').unsigned().nullable();
    t.timestamp('created_on').nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('edx_master_coupons', (t) => {
    t.dropColumn('created_by');
    t.dropColumn('created_on');
  });
};
