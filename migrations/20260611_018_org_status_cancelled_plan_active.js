/**
 * 20260611_018_org_status_cancelled_plan_active.js — Owner Platform Phase 1/2
 *
 * 1. Adds 'cancelled' to edx_organizations.status ENUM.
 *    transitionSubscriptionStatus already writes 'cancelled' to the org row,
 *    which fails under MySQL strict mode with the old 3-value ENUM.
 * 2. Adds edx_plans.is_active so retired plans can be hidden from the
 *    create-account wizard without deleting rows still referenced by
 *    existing subscriptions.
 * 3. Adds edx_subscriptions.updated_on — transitionSubscriptionStatus has
 *    always written it, but the column was never created, so every
 *    suspend/reactivate failed with "Unknown column".
 * 4. Adds 'suspended' to edx_subscriptions.status ENUM — the transition state
 *    machine allows it but the original ENUM didn't include it.
 */

exports.up = async (knex) => {
  await knex.raw(
    "ALTER TABLE edx_organizations MODIFY status ENUM('active','suspended','trial','cancelled') NOT NULL DEFAULT 'active'"
  );

  await knex.raw(
    "ALTER TABLE edx_subscriptions MODIFY status ENUM('trial','active','suspended','expired','cancelled') NOT NULL DEFAULT 'active'"
  );

  const hasIsActive = await knex.schema.hasColumn('edx_plans', 'is_active');
  if (!hasIsActive) {
    await knex.schema.alterTable('edx_plans', (t) => {
      t.boolean('is_active').notNullable().defaultTo(true);
    });
  }

  const hasUpdatedOn = await knex.schema.hasColumn('edx_subscriptions', 'updated_on');
  if (!hasUpdatedOn) {
    await knex.schema.alterTable('edx_subscriptions', (t) => {
      t.datetime('updated_on').nullable();
    });
  }
};

exports.down = async (knex) => {
  // Map 'cancelled' back to 'suspended' before shrinking the ENUM
  await knex('edx_organizations').where('status', 'cancelled').update({ status: 'suspended' });
  await knex.raw(
    "ALTER TABLE edx_organizations MODIFY status ENUM('active','suspended','trial') NOT NULL DEFAULT 'active'"
  );

  await knex('edx_subscriptions').where('status', 'suspended').update({ status: 'expired' });
  await knex.raw(
    "ALTER TABLE edx_subscriptions MODIFY status ENUM('trial','active','expired','cancelled') NOT NULL DEFAULT 'active'"
  );

  const hasIsActive = await knex.schema.hasColumn('edx_plans', 'is_active');
  if (hasIsActive) {
    await knex.schema.alterTable('edx_plans', (t) => {
      t.dropColumn('is_active');
    });
  }

  const hasUpdatedOn = await knex.schema.hasColumn('edx_subscriptions', 'updated_on');
  if (hasUpdatedOn) {
    await knex.schema.alterTable('edx_subscriptions', (t) => {
      t.dropColumn('updated_on');
    });
  }
};
