/**
 * Migration 004 — Phase 4.2
 * Creates edx_audit_log table for immutable event trail.
 */

exports.up = async (knex) => {
  await knex.schema.createTable('edx_audit_log', (table) => {
    table.increments('id').primary();
    // Entity being changed
    table.string('entity_type', 50).notNullable();   // 'BOOKING' | 'HP' | 'SUPPORT_TICKET' | 'SERVICE' | 'BRANCH'
    table.integer('entity_id').nullable();            // PK of the changed record (soft FK, no constraint)
    // What happened
    table.enu('action', ['CREATE', 'UPDATE', 'STATUS_CHANGE', 'DELETE']).notNullable();
    // Who did it
    table.integer('changed_by').nullable();           // edx_web_app_users.id (soft FK — stays if user deleted)
    table.string('changed_by_name', 100).nullable();  // denormalised display name
    // What changed
    table.json('old_values').nullable();              // snapshot before change (omit for CREATE)
    table.json('new_values').nullable();              // snapshot after change
    // When
    table.timestamp('created_on').defaultTo(knex.fn.now()).notNullable();

    // Indexes for the most common query patterns
    table.index(['entity_type', 'entity_id'], 'idx_audit_entity');
    table.index(['changed_by'],               'idx_audit_changed_by');
    table.index(['created_on'],               'idx_audit_created_on');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('edx_audit_log');
};
