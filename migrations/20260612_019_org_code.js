/**
 * 20260612_019_org_code
 *
 * Adds a public organisation code (e.g. SUN-482913) to edx_organizations.
 * The numeric auto-increment `id` stays the internal identifier and FK across
 * all tables; `org_code` is what gets exposed in portal links and login forms
 * so org ids are no longer guessable/enumerable.
 *
 * Existing organisations keep org_code = NULL and continue to be referenced
 * by their numeric id; only orgs created after this migration get a code.
 */

exports.up = (knex) =>
  knex.schema.alterTable('edx_organizations', (t) => {
    t.string('org_code', 16).nullable().unique();
  });

exports.down = (knex) =>
  knex.schema.alterTable('edx_organizations', (t) => {
    t.dropColumn('org_code');
  });
