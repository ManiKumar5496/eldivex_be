/**
 * 20260609_013_attendance_fk.js
 *
 * Codifies the edx_hp_attendance.booking_id → edx_bookings.id foreign key.
 *
 * Production already has this FK (auto-named `edx_hp_attendance_ibfk_1`), but
 * the initial schema migration never declared it — so a fresh database built
 * from migrations would NOT have it. This migration closes that drift:
 *   • If a FK on booking_id already exists  → no-op (production stays as-is).
 *   • If it is missing (fresh DB)           → create it.
 */

const TABLE = 'edx_hp_attendance';

// Returns true if any FK constraint already references booking_id on TABLE.
async function hasBookingFk(knex) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS n
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = 'booking_id'
        AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [TABLE]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

exports.up = async (knex) => {
  if (await hasBookingFk(knex)) return; // production already has it → no-op

  await knex.schema.alterTable(TABLE, (t) => {
    t.foreign('booking_id', 'edx_hp_attendance_ibfk_1')
      .references('id')
      .inTable('edx_bookings');
  });
};

exports.down = async (knex) => {
  // Only drop if it exists, so down() is safe on databases where this
  // migration was a no-op.
  if (!(await hasBookingFk(knex))) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropForeign('booking_id', 'edx_hp_attendance_ibfk_1');
  });
};
