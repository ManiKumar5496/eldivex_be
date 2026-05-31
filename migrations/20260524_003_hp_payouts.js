/**
 * Migration: HP Payout tracking — edx_hp_payouts
 * Phase 2.7
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('edx_hp_payouts'))) {
    await knex.schema.createTable('edx_hp_payouts', (t) => {
      t.increments('id').primary();
      t.integer('hp_unique_id').unsigned().notNullable()
        .comment('FK → edx_hp_registration.hp_reg_id');
      t.integer('booking_id').unsigned().nullable()
        .comment('FK → edx_bookings.id');
      t.string('period_from', 30).nullable();
      t.string('period_to', 30).nullable();
      t.decimal('pay_amount', 10, 2).nullable();
      t.string('payment_mode', 50).defaultTo('Cash');
      t.string('payment_date', 30).nullable();
      // Pending → Paid
      t.enum('status', ['Pending', 'Paid']).defaultTo('Pending');
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('edx_hp_payouts');
};
