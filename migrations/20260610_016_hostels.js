/**
 * Migration: Hostel module — edx_hostels, edx_hostel_stays, edx_hostel_settlements
 *
 * Caregivers (HPs) housed in company-managed / partner hostels. Lodging cost is
 * deducted from the CG's monthly earnings and reconciled per hostel at month end.
 *
 * Multi-tenancy: every table carries a NOT NULL org_id — all access is scoped to
 * the authenticated org (see utils/orgScope.js).
 */

exports.up = async function (knex) {
  // ── edx_hostels ────────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_hostels'))) {
    await knex.schema.createTable('edx_hostels', (t) => {
      t.increments('id').primary();
      t.string('hostel_name', 150).notNullable();
      t.string('address', 255).nullable();
      t.string('city', 100).nullable();
      t.string('state', 100).nullable();
      t.string('pincode', 20).nullable();
      // Gender restriction — only CGs of this gender may be housed here.
      t.enum('gender', ['Male', 'Female']).notNullable();
      t.decimal('rate_per_day', 10, 2).notNullable();
      t.integer('capacity').unsigned().nullable().comment('Total beds');
      t.string('contact_person_name', 150).nullable();
      t.string('contact_phone', 20).nullable();
      t.string('contact_email', 150).nullable();
      t.tinyint('status').defaultTo(1).comment('1=Active, 0=Inactive');
      t.integer('branch_id').unsigned().nullable();
      t.integer('org_id').unsigned().notNullable().defaultTo(1);
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
      t.index(['org_id'], 'idx_org_edx_hostels');
    });
  }

  // ── edx_hostel_settlements ──────────────────────────────────────────────────
  // Created before stays so stays can FK to it.
  if (!(await knex.schema.hasTable('edx_hostel_settlements'))) {
    await knex.schema.createTable('edx_hostel_settlements', (t) => {
      t.increments('id').primary();
      t.integer('hostel_id').unsigned().notNullable()
        .comment('FK → edx_hostels.id');
      t.string('period_from', 30).notNullable();
      t.string('period_to', 30).notNullable();
      t.decimal('total_amount', 12, 2).defaultTo(0);
      t.integer('total_nights').unsigned().defaultTo(0);
      t.integer('cg_count').unsigned().defaultTo(0);
      t.enum('status', ['Pending', 'Paid']).defaultTo('Pending');
      t.string('paid_on', 30).nullable();
      t.string('payment_mode', 50).nullable();
      t.integer('org_id').unsigned().notNullable().defaultTo(1);
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
      t.index(['org_id'], 'idx_org_edx_hostel_settlements');
    });
  }

  // ── edx_hostel_stays ────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('edx_hostel_stays'))) {
    await knex.schema.createTable('edx_hostel_stays', (t) => {
      t.increments('id').primary();
      t.integer('hostel_id').unsigned().notNullable()
        .comment('FK → edx_hostels.id');
      t.integer('hp_id').unsigned().notNullable()
        .comment('FK → edx_hp_registration.hp_reg_id');
      t.string('check_in_date', 30).notNullable();
      t.string('check_out_date', 30).nullable().comment('NULL while ongoing');
      // Snapshot of hostel rate at assignment time — later rate edits don't
      // rewrite stay history.
      t.decimal('rate_per_day', 10, 2).notNullable();
      t.enum('status', ['active', 'closed']).defaultTo('active');
      t.integer('settlement_id').unsigned().nullable()
        .comment('FK → edx_hostel_settlements.id, set when settled');
      t.integer('branch_id').unsigned().nullable();
      t.integer('org_id').unsigned().notNullable().defaultTo(1);
      t.integer('created_by').nullable();
      t.string('created_on', 30).nullable();
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
      t.index(['org_id'], 'idx_org_edx_hostel_stays');
      t.index(['hp_id'], 'idx_hp_edx_hostel_stays');
      t.index(['hostel_id'], 'idx_hostel_edx_hostel_stays');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('edx_hostel_stays');
  await knex.schema.dropTableIfExists('edx_hostel_settlements');
  await knex.schema.dropTableIfExists('edx_hostels');
};
