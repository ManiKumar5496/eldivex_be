/**
 * Migration 032 — edx_payment_webhook_events (Razorpay idempotency).
 *
 * Razorpay retries webhooks and an attacker could replay a captured payload.
 * Every processed payment is recorded here first; UNIQUE (provider, payment_id)
 * makes a second delivery a no-op instead of a duplicate receipt.
 */

const TABLE = 'edx_payment_webhook_events';

exports.up = async function (knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.string('provider', 20).notNullable().defaultTo('razorpay');
    t.string('event_id', 100).nullable();
    t.string('event_type', 60).nullable();
    t.string('payment_id', 100).notNullable();
    t.integer('invoice_id').unsigned().nullable();
    t.integer('org_id').unsigned().nullable();
    t.integer('receipt_id').unsigned().nullable();
    t.decimal('amount', 12, 2).nullable();
    t.string('status', 20).notNullable().defaultTo('received'); // received | processed | ignored
    t.string('received_on', 30).nullable();
    t.unique(['provider', 'payment_id'], 'uq_webhook_provider_payment');
    t.index(['event_id'], 'idx_webhook_event_id');
    t.index(['org_id'], 'idx_webhook_org');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
