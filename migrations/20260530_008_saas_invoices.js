exports.up = async function (knex) {
  // ── edx_saas_invoices: subscription billing invoices raised to tenant orgs ──
  await knex.schema.createTable('edx_saas_invoices', (t) => {
    t.increments('id').primary();
    t.integer('org_id').unsigned().notNullable().index();
    t.integer('plan_id').unsigned().notNullable();
    t.tinyint('period_month').unsigned().notNullable().comment('1–12');
    t.smallint('period_year').unsigned().notNullable();
    t.decimal('amount', 10, 2).notNullable();
    t.enum('status', ['Draft', 'Sent', 'Paid', 'Overdue']).defaultTo('Draft');
    t.date('due_date').nullable();
    t.datetime('paid_at').nullable();
    t.string('transaction_ref', 100).nullable();
    t.integer('created_by').nullable();
    t.datetime('created_on').defaultTo(knex.fn.now());

    // Hard DB guard: one invoice per org per calendar month
    t.unique(['org_id', 'period_month', 'period_year'], 'uq_saas_inv_period');
  });

  // Add unique index on org email if not already unique
  const hasEmailIndex = await knex.schema.hasTable('edx_organizations');
  if (hasEmailIndex) {
    await knex.raw(
      `ALTER TABLE edx_organizations
       ADD UNIQUE INDEX IF NOT EXISTS uq_org_email (email)`
    ).catch(() => {
      // Index may already exist — ignore
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('edx_saas_invoices');
};
