/**
 * Migration: 006 — Advanced Accounts Module
 *
 * Changes:
 *   1. ALTER edx_invoice  → add due_date, invoice_type
 *   2. ALTER edx_receipts → add receipt_type, payment_link_id
 *   3. CREATE edx_credit_notes
 *   4. CREATE edx_insurance_claims
 *   5. CREATE edx_rate_history
 *   6. CREATE edx_period_closing
 *   7. CREATE edx_payment_reminders
 *   8. CREATE edx_payment_links
 */

exports.up = async function (knex) {

  // ── 1. Alter edx_invoice ─────────────────────────────────────────────────
  const hasInvDueDate = await knex.schema.hasColumn('edx_invoice', 'due_date');
  if (!hasInvDueDate) {
    await knex.schema.alterTable('edx_invoice', (t) => {
      t.string('due_date', 30).nullable().after('inv_date');
      t.enum('invoice_type', ['Regular', 'Credit Note', 'Advance']).defaultTo('Regular').after('due_date');
    });
  }

  // ── 2. Alter edx_receipts ────────────────────────────────────────────────
  const hasReceiptType = await knex.schema.hasColumn('edx_receipts', 'receipt_type');
  if (!hasReceiptType) {
    await knex.schema.alterTable('edx_receipts', (t) => {
      t.enum('receipt_type', ['Advance', 'Payment', 'Final']).defaultTo('Payment').after('status');
      t.integer('payment_link_id').unsigned().nullable().after('receipt_type');
    });
  }

  // ── 3. edx_credit_notes ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_credit_notes'))) {
    await knex.schema.createTable('edx_credit_notes', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('invoice_id').unsigned().nullable();
      // Hold / Cancellation / Overpayment
      t.enum('credit_type', ['Hold', 'Cancellation', 'Overpayment', 'Other']).defaultTo('Hold');
      t.decimal('amount', 12, 2).notNullable();
      t.text('reason').nullable();
      // Pending → Approved / Rejected
      t.enum('status', ['Pending', 'Approved', 'Rejected']).defaultTo('Pending');
      t.string('credit_date', 30).nullable();
      t.integer('org_id').unsigned().nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  // ── 4. edx_insurance_claims ──────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_insurance_claims'))) {
    await knex.schema.createTable('edx_insurance_claims', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('user_id').unsigned().nullable();
      t.string('tpa_name', 100).nullable();
      t.string('policy_number', 100).nullable();
      t.string('pre_auth_number', 100).nullable();
      t.decimal('claim_amount', 12, 2).nullable();
      t.decimal('settled_amount', 12, 2).nullable();
      // Pending → Submitted → Approved / Rejected → Settled
      t.enum('status', ['Pending', 'Submitted', 'Approved', 'Rejected', 'Settled']).defaultTo('Pending');
      t.text('remarks').nullable();
      t.string('submitted_date', 30).nullable();
      t.string('settled_date', 30).nullable();
      t.integer('org_id').unsigned().nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  // ── 5. edx_rate_history ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_rate_history'))) {
    await knex.schema.createTable('edx_rate_history', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.decimal('old_rate', 10, 2).nullable();
      t.decimal('new_rate', 10, 2).nullable();
      t.string('effective_date', 30).nullable();
      t.text('reason').nullable();
      t.integer('org_id').unsigned().nullable();
      t.integer('changed_by').nullable();
      t.string('changed_on', 30).nullable();
    });
  }

  // ── 6. edx_period_closing ────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_period_closing'))) {
    await knex.schema.createTable('edx_period_closing', (t) => {
      t.increments('id').primary();
      t.integer('org_id').unsigned().notNullable();
      t.integer('period_month').notNullable();   // 1-12
      t.integer('period_year').notNullable();    // e.g. 2026
      // Open → Closed
      t.enum('status', ['Open', 'Closed']).defaultTo('Closed');
      t.integer('closed_by').nullable();
      t.string('closed_at', 30).nullable();
      t.unique(['org_id', 'period_month', 'period_year']);
    });
  }

  // ── 7. edx_payment_reminders ────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_payment_reminders'))) {
    await knex.schema.createTable('edx_payment_reminders', (t) => {
      t.increments('id').primary();
      t.integer('invoice_id').unsigned().notNullable();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('reminder_day').notNullable();  // 0 = due date, 3, 7, 15
      t.string('channel', 20).defaultTo('email'); // email | sms | both
      t.string('sent_at', 30).nullable();
      t.integer('org_id').unsigned().nullable();
    });
  }

  // ── 8. edx_payment_links ────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_payment_links'))) {
    await knex.schema.createTable('edx_payment_links', (t) => {
      t.increments('id').primary();
      t.integer('invoice_id').unsigned().notNullable();
      t.string('razorpay_link_id', 100).nullable();
      t.text('link_url').nullable();
      t.decimal('amount', 12, 2).nullable();
      // Created → Paid / Expired / Cancelled
      t.enum('status', ['Created', 'Paid', 'Expired', 'Cancelled']).defaultTo('Created');
      t.string('paid_at', 30).nullable();
      t.integer('org_id').unsigned().nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
    });
  }
};

exports.down = async function (knex) {
  // Reverse in reverse order
  await knex.schema.dropTableIfExists('edx_payment_links');
  await knex.schema.dropTableIfExists('edx_payment_reminders');
  await knex.schema.dropTableIfExists('edx_period_closing');
  await knex.schema.dropTableIfExists('edx_rate_history');
  await knex.schema.dropTableIfExists('edx_insurance_claims');
  await knex.schema.dropTableIfExists('edx_credit_notes');

  // Remove added columns (MySQL/MariaDB)
  const hasReceiptType = await knex.schema.hasColumn('edx_receipts', 'receipt_type');
  if (hasReceiptType) {
    await knex.schema.alterTable('edx_receipts', (t) => {
      t.dropColumn('receipt_type');
      t.dropColumn('payment_link_id');
    });
  }
  const hasInvDueDate = await knex.schema.hasColumn('edx_invoice', 'due_date');
  if (hasInvDueDate) {
    await knex.schema.alterTable('edx_invoice', (t) => {
      t.dropColumn('due_date');
      t.dropColumn('invoice_type');
    });
  }
};
