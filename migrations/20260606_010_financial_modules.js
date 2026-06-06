exports.up = async function(knex) {

  // 1. Central transaction ledger — every financial event writes here
  await knex.schema.createTable('edx_transaction_ledger', function(t) {
    t.increments('id').primary();
    t.integer('org_id').notNullable().index();
    t.integer('client_id').notNullable().index();
    t.integer('booking_id').nullable().index();
    t.integer('invoice_id').nullable().index();
    t.enu('transaction_type', [
      'INVOICE','RECEIPT','WRITE_OFF','WRITE_OFF_REVERSED',
      'CREDIT_NOTE_ISSUED','CREDIT_NOTE_APPLIED','CREDIT_NOTE_REVERSED',
      'REFUND','REFUND_REVERSED',
      'INTERNAL_TRANSFER_IN','INTERNAL_TRANSFER_OUT','INTERNAL_TRANSFER_REVERSED'
    ]).notNullable();
    t.enu('direction', ['DEBIT','CREDIT']).notNullable();
    t.decimal('amount', 12, 2).notNullable();
    t.integer('reference_id').nullable();
    t.string('reference_type', 50).nullable();
    t.enu('status', ['PENDING','COMPLETED','REVERSED']).defaultTo('COMPLETED');
    t.text('description').nullable();
    t.text('notes').nullable();
    t.decimal('running_balance_client', 12, 2).nullable();
    t.decimal('running_balance_booking', 12, 2).nullable();
    t.integer('created_by').nullable();
    t.string('created_on', 30).nullable();
    t.integer('reversed_by').nullable();
    t.string('reversed_at', 30).nullable();
    t.text('reversal_reason').nullable();
  });

  // 2. Approval history — tracks every action on financial documents
  await knex.schema.createTable('edx_approval_history', function(t) {
    t.increments('id').primary();
    t.integer('org_id').notNullable().index();
    t.string('reference_type', 50).notNullable();
    t.integer('reference_id').notNullable().index();
    t.enu('action', ['SUBMITTED','APPROVED','REJECTED','ESCALATED','REVERSED']).notNullable();
    t.integer('action_by').notNullable();
    t.text('notes').nullable();
    t.integer('approval_level').nullable();
    t.string('action_on', 30).nullable();
  });

  // 3. Credit note applications — each time a credit note is applied to an invoice
  await knex.schema.createTable('edx_credit_note_applications', function(t) {
    t.increments('id').primary();
    t.integer('org_id').notNullable().index();
    t.integer('credit_note_id').notNullable().index();
    t.integer('target_booking_id').notNullable().index();
    t.integer('target_invoice_id').notNullable();
    t.decimal('amount_applied', 12, 2).notNullable();
    t.enu('status', ['APPLIED','REVERSED']).defaultTo('APPLIED');
    t.integer('applied_by').nullable();
    t.string('applied_at', 30).nullable();
    t.integer('ledger_entry_id').nullable();
    t.text('notes').nullable();
    t.integer('reversed_by').nullable();
    t.string('reversed_at', 30).nullable();
    t.text('reversal_reason').nullable();
  });

  // 4. Refunds — money going back to client
  await knex.schema.createTable('edx_refunds', function(t) {
    t.increments('id').primary();
    t.integer('org_id').notNullable().index();
    t.integer('client_id').notNullable().index();
    t.integer('booking_id').notNullable().index();
    t.text('receipt_ids').nullable();
    t.integer('invoice_id').nullable();
    t.decimal('refund_amount', 12, 2).notNullable();
    t.enu('refund_channel', ['CASH','BANK_TRANSFER','UPI','CHEQUE','GATEWAY_REVERSAL']).notNullable();
    t.enu('refund_reason', [
      'SERVICE_NOT_DELIVERED','PARTIAL_DELIVERY','OVERPAYMENT',
      'QUALITY_ISSUE','GOODWILL','CREDIT_NOTE_CASHOUT'
    ]).notNullable();
    t.text('channel_details').nullable();
    t.text('dispatch_details').nullable();
    t.enu('status', [
      'DRAFT','PENDING_APPROVAL','APPROVED','PROCESSING','COMPLETED','REJECTED','REVERSED'
    ]).defaultTo('DRAFT');
    t.string('approval_level', 5).nullable();
    t.integer('transaction_entry_id').nullable();
    t.integer('requested_by').nullable();
    t.integer('approved_by').nullable();
    t.string('approved_at', 30).nullable();
    t.integer('processed_by').nullable();
    t.string('processed_at', 30).nullable();
    t.integer('reversed_by').nullable();
    t.string('reversed_at', 30).nullable();
    t.text('reversal_reason').nullable();
    t.text('notes').nullable();
    t.string('created_on', 30).nullable();
    t.string('updated_on', 30).nullable();
    t.integer('created_by').nullable();
    t.integer('updated_by').nullable();
  });

  // 5. Internal transfers — moving balance between bookings of same client
  await knex.schema.createTable('edx_internal_transfers', function(t) {
    t.increments('id').primary();
    t.integer('org_id').notNullable().index();
    t.integer('client_id').notNullable().index();
    t.integer('source_booking_id').notNullable().index();
    t.integer('target_booking_id').notNullable().index();
    t.decimal('transfer_amount', 12, 2).notNullable();
    t.enu('transfer_type', [
      'OVERPAYMENT_TRANSFER','RECEIPT_REALLOCATION','CREDIT_BALANCE_TRANSFER','SERVICE_SWITCH'
    ]).notNullable();
    t.text('reason').notNullable();
    t.text('notes').nullable();
    t.enu('status', [
      'DRAFT','PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','REVERSED'
    ]).defaultTo('DRAFT');
    t.integer('source_transaction_entry_id').nullable();
    t.integer('target_transaction_entry_id').nullable();
    t.integer('requested_by').nullable();
    t.integer('approved_by').nullable();
    t.string('approved_at', 30).nullable();
    t.integer('reversed_by').nullable();
    t.string('reversed_at', 30).nullable();
    t.text('reversal_reason').nullable();
    t.string('created_on', 30).nullable();
    t.string('updated_on', 30).nullable();
    t.integer('created_by').nullable();
    t.integer('updated_by').nullable();
  });

  // 6. Enhance edx_write_offs with new fields
  const hasWriteOffType = await knex.schema.hasColumn('edx_write_offs', 'write_off_type');
  if (!hasWriteOffType) {
    await knex.schema.alterTable('edx_write_offs', function(t) {
      t.enu('write_off_type', ['BAD_DEBT','BILLING_ERROR','GOODWILL','ADJUSTMENT']).defaultTo('BAD_DEBT').nullable();
      t.text('invoice_ids').nullable();
      t.string('approval_level', 5).nullable();
      t.integer('transaction_entry_id').nullable();
      t.string('reversed_by_user', 100).nullable();
      t.text('reversal_reason').nullable();
      t.string('reversed_at', 30).nullable();
    });
  }

  // 7. Enhance edx_credit_notes with new fields
  const hasCreditNoteNumber = await knex.schema.hasColumn('edx_credit_notes', 'credit_note_number');
  if (!hasCreditNoteNumber) {
    await knex.schema.alterTable('edx_credit_notes', function(t) {
      t.string('credit_note_number', 30).nullable();
      t.enu('credit_note_type', [
        'SERVICE_ADJUSTMENT','BILLING_ERROR','GOODWILL','ADVANCE_CREDIT','CANCELLATION'
      ]).defaultTo('SERVICE_ADJUSTMENT').nullable();
      t.string('expiry_date', 30).nullable();
      t.decimal('remaining_amount', 12, 2).nullable();
      t.decimal('used_amount', 12, 2).defaultTo(0).nullable();
      t.integer('transaction_entry_id').nullable();
      t.integer('linked_receipt_id').nullable();
      t.string('reversed_by_user', 100).nullable();
      t.text('reversal_reason').nullable();
      t.string('reversed_at', 30).nullable();
      t.enu('extended_status', [
        'DRAFT','ACTIVE','PARTIALLY_APPLIED','FULLY_APPLIED','EXPIRED','REVERSED'
      ]).defaultTo('ACTIVE').nullable();
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('edx_internal_transfers');
  await knex.schema.dropTableIfExists('edx_refunds');
  await knex.schema.dropTableIfExists('edx_credit_note_applications');
  await knex.schema.dropTableIfExists('edx_approval_history');
  await knex.schema.dropTableIfExists('edx_transaction_ledger');
};
