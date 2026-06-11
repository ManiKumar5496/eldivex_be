/**
 * Migration: add gross_pay + hostel_deduction to edx_hp_payouts.
 *
 * pay_amount is the NET paid to the CG; these two columns retain the audit
 * trail of the gross attendance pay and the hostel lodging deducted from it.
 */

exports.up = async function (knex) {
  const hasGross = await knex.schema.hasColumn('edx_hp_payouts', 'gross_pay');
  const hasDeduction = await knex.schema.hasColumn('edx_hp_payouts', 'hostel_deduction');
  await knex.schema.alterTable('edx_hp_payouts', (t) => {
    if (!hasGross) t.decimal('gross_pay', 10, 2).nullable();
    if (!hasDeduction) t.decimal('hostel_deduction', 10, 2).defaultTo(0);
  });
};

exports.down = async function (knex) {
  const hasGross = await knex.schema.hasColumn('edx_hp_payouts', 'gross_pay');
  const hasDeduction = await knex.schema.hasColumn('edx_hp_payouts', 'hostel_deduction');
  await knex.schema.alterTable('edx_hp_payouts', (t) => {
    if (hasGross) t.dropColumn('gross_pay');
    if (hasDeduction) t.dropColumn('hostel_deduction');
  });
};
