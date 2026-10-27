/**
 * createProvisionalReceipt generates and inserts a `receipt_number`
 * (format RCP-<org>-NNNNNN), and the client portal getReceipts selects both
 * `receipt_number` and `invoice_id` from edx_receipts — but neither column was
 * ever migrated (002 created the table; 006 added only receipt_type /
 * payment_link_id). On a fully-migrated DB the insert and the client receipts
 * list both failed with "Unknown column". This adds the two columns.
 * Idempotent so it is safe where a column was added by hand.
 */
exports.up = async (knex) => {
  const cols = {
    receipt_number: (t) => t.string('receipt_number', 50).nullable().after('id'),
    invoice_id:     (t) => t.integer('invoice_id').unsigned().nullable(),
  };

  const missing = [];
  for (const name of Object.keys(cols)) {
    if (!(await knex.schema.hasColumn('edx_receipts', name))) missing.push(name);
  }
  if (missing.length === 0) return;

  await knex.schema.alterTable('edx_receipts', (t) => {
    missing.forEach((name) => cols[name](t));
  });
};

exports.down = async (knex) => {
  for (const name of ['receipt_number', 'invoice_id']) {
    if (await knex.schema.hasColumn('edx_receipts', name)) {
      await knex.schema.alterTable('edx_receipts', (t) => t.dropColumn(name));
    }
  }
};
