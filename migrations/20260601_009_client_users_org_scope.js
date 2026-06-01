/**
 * Migration 009 — Multi-tenant client user scope
 *
 * The edx_client_app_users.phone_number column previously had a global
 * UNIQUE constraint, which prevented the same phone number from belonging
 * to clients of different organisations. This migration converts it to a
 * composite unique on (phone_number, org_id) so each org can have its own
 * user records and a person can be a client at multiple orgs.
 */
exports.up = async function (knex) {
  await knex.schema.table('edx_client_app_users', (t) => {
    t.dropUnique(['phone_number']);
  });

  await knex.schema.table('edx_client_app_users', (t) => {
    t.unique(['phone_number', 'org_id'], 'uq_client_phone_org');
  });
};

exports.down = async function (knex) {
  await knex.schema.table('edx_client_app_users', (t) => {
    t.dropUnique(['phone_number', 'org_id'], 'uq_client_phone_org');
  });

  await knex.schema.table('edx_client_app_users', (t) => {
    t.unique(['phone_number']);
  });
};
