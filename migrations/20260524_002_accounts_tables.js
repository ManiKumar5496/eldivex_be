/**
 * Migration: Accounts tables — edx_receipts + edx_write_offs
 * Phase 2.4 — Accounts module real data
 */

exports.up = async function (knex) {
  // ── edx_receipts ────────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_receipts'))) {
    await knex.schema.createTable('edx_receipts', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('user_id').unsigned().nullable();
      t.decimal('amount', 12, 2).nullable();
      t.decimal('tax_amount', 12, 2).defaultTo(0);
      t.decimal('total_amount', 12, 2).nullable();
      t.string('payment_mode', 50).defaultTo('Cash');
      t.string('transaction_id', 100).nullable();
      t.text('remarks').nullable();
      t.string('receipt_date', 30).nullable();
      t.string('period_from', 30).nullable();
      t.string('period_to', 30).nullable();
      // Pending → Approved (payment recorded) → Cancelled
      t.enum('status', ['Pending', 'Approved', 'Cancelled']).defaultTo('Pending');
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  // ── edx_write_offs ───────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_write_offs'))) {
    await knex.schema.createTable('edx_write_offs', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().nullable();
      t.integer('user_id').unsigned().nullable();
      t.decimal('write_off_amount', 12, 2).nullable();
      t.text('reason').nullable();
      t.text('remarks').nullable();
      t.string('approved_by', 100).nullable();
      // Pending → Approved / Rejected
      t.enum('status', ['Pending', 'Approved', 'Rejected']).defaultTo('Pending');
      t.string('write_off_date', 30).nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('edx_write_offs');
  await knex.schema.dropTableIfExists('edx_receipts');
};
