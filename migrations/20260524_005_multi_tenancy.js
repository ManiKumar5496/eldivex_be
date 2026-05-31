/**
 * 20260524_005_multi_tenancy.js  — Phase 5
 *
 * 1. Creates edx_plans, edx_organizations, edx_subscriptions tables
 * 2. Seeds 3 plans + 1 default org + 1 default subscription
 * 3. Adds org_id (INT UNSIGNED NOT NULL DEFAULT 1) to every existing table
 */

const ALL_TABLES = [
  'edx_web_app_users',
  'edx_web_emp_roles',
  'edx_web_module',
  'edx_client_app_users',
  'edx_branches',
  'edx_master_languages',
  'edx_master_services_category',
  'edx_master_services',
  'edx_master_coupons',
  'edx_master_banners',
  'edx_user_address',
  'edx_hp_registration',
  'edx_hp_rate',
  'edx_patient',
  'edx_bookings',
  'edx_booking_hp',
  'edx_hold_booking',
  'edx_extension_booking',
  'edx_service_closed',
  'edx_hp_attendance',
  'edx_invoice',
  'edx_support_category',
  'edx_support_requests',
  'edx_receipts',
  'edx_write_offs',
  'edx_hp_payouts',
  'edx_audit_log',
];

exports.up = async (knex) => {
  // ── 1. edx_plans ──────────────────────────────────────────────────────────
  await knex.schema.createTable('edx_plans', (t) => {
    t.increments('id').primary();
    t.string('name', 50).notNullable();
    t.json('features').nullable();           // { reports, ai_matching, api_keys }
    t.integer('booking_limit').defaultTo(0); // 0 = unlimited
    t.integer('hp_limit').defaultTo(0);
    t.decimal('price_per_month', 10, 2).defaultTo(0);
    t.timestamp('created_on').defaultTo(knex.fn.now());
  });

  await knex('edx_plans').insert([
    {
      name: 'Starter',
      features: JSON.stringify({ reports: false, ai_matching: false, api_keys: false }),
      booking_limit: 100,
      hp_limit: 10,
      price_per_month: 999,
    },
    {
      name: 'Growth',
      features: JSON.stringify({ reports: true, ai_matching: false, api_keys: false }),
      booking_limit: 500,
      hp_limit: 50,
      price_per_month: 2999,
    },
    {
      name: 'Enterprise',
      features: JSON.stringify({ reports: true, ai_matching: true, api_keys: true }),
      booking_limit: 0,
      hp_limit: 0,
      price_per_month: 7999,
    },
  ]);

  // ── 2. edx_organizations ──────────────────────────────────────────────────
  await knex.schema.createTable('edx_organizations', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable();
    t.string('slug', 50).notNullable().unique();
    t.string('email', 100).nullable();
    t.string('phone', 20).nullable();
    t.string('address', 255).nullable();
    t.integer('plan_id').unsigned().defaultTo(3);
    t.enu('status', ['active', 'suspended', 'trial']).defaultTo('active');
    t.timestamp('created_on').defaultTo(knex.fn.now());
  });

  await knex('edx_organizations').insert({
    name: 'Eldivex',
    slug: 'eldivex',
    email: 'admin@eldivex.in',
    plan_id: 3,
    status: 'active',
  });

  // ── 3. edx_subscriptions ──────────────────────────────────────────────────
  await knex.schema.createTable('edx_subscriptions', (t) => {
    t.increments('id').primary();
    t.integer('org_id').unsigned().notNullable();
    t.integer('plan_id').unsigned().notNullable();
    t.enu('status', ['trial', 'active', 'expired', 'cancelled']).defaultTo('active');
    t.date('started_on').nullable();
    t.date('expires_on').nullable();
    t.integer('activated_by').nullable();
    t.timestamp('created_on').defaultTo(knex.fn.now());
    t.index(['org_id'], 'idx_sub_org');
  });

  await knex('edx_subscriptions').insert({
    org_id: 1,
    plan_id: 3,
    status: 'active',
    started_on: knex.fn.now(),
  });

  // ── 4. Add org_id to every existing table ─────────────────────────────────
  for (const table of ALL_TABLES) {
    const exists = await knex.schema.hasTable(table);
    if (!exists) continue;

    const hasCol = await knex.schema.hasColumn(table, 'org_id');
    if (hasCol) continue;

    await knex.schema.alterTable(table, (t) => {
      t.integer('org_id').unsigned().notNullable().defaultTo(1);
      t.index(['org_id'], `idx_org_${table}`);
    });
  }
};

exports.down = async (knex) => {
  for (const table of ALL_TABLES) {
    const exists = await knex.schema.hasTable(table);
    if (!exists) continue;
    const hasCol = await knex.schema.hasColumn(table, 'org_id');
    if (!hasCol) continue;
    await knex.schema.alterTable(table, (t) => {
      t.dropIndex(['org_id'], `idx_org_${table}`);
      t.dropColumn('org_id');
    });
  }
  await knex.schema.dropTableIfExists('edx_subscriptions');
  await knex.schema.dropTableIfExists('edx_organizations');
  await knex.schema.dropTableIfExists('edx_plans');
};
