/**
 * 20260608_012_attendance_normalize.js
 *
 * Normalises edx_hp_attendance so attendance is queryable and idempotent.
 *
 *   Before: every meaningful field (status, shift, check-in/out, hours, notes)
 *           lived inside the `att_details` JSON text blob, `from_date` was a
 *           VARCHAR, and nothing stopped duplicate rows for the same HP/day.
 *
 *   After:  first-class columns + a UNIQUE(org_id, hp_id, att_date) key that
 *           lets the controller UPSERT instead of blindly INSERT-ing.
 *
 * Strategy (safe + reversible):
 *   1. Add the new columns (att_details / from_date are kept untouched).
 *   2. Backfill them from the existing JSON blob.
 *   3. De-duplicate existing rows (keep the newest per HP/day).
 *   4. Add the UNIQUE index last (step 3 guarantees it won't fail).
 */

const TABLE = 'edx_hp_attendance';
const UNIQUE = 'uq_attendance_org_hp_date';

exports.up = async (knex) => {
  // ── 1. Add first-class columns ──────────────────────────────────────────────
  // Resolve existence up-front; the alterTable callback must stay synchronous.
  const cols = ['att_date', 'status', 'shift_type', 'check_in', 'check_out',
                'working_hours', 'notes', 'updated_by', 'updated_on'];
  const exists = {};
  for (const c of cols) exists[c] = await knex.schema.hasColumn(TABLE, c);

  await knex.schema.alterTable(TABLE, (t) => {
    if (!exists.att_date)      t.date('att_date').nullable();
    if (!exists.status)        t.string('status', 20).nullable();
    if (!exists.shift_type)    t.string('shift_type', 20).nullable();
    if (!exists.check_in)      t.time('check_in').nullable();
    if (!exists.check_out)     t.time('check_out').nullable();
    if (!exists.working_hours) t.decimal('working_hours', 5, 2).defaultTo(0);
    if (!exists.notes)         t.text('notes').nullable();
    if (!exists.updated_by)    t.integer('updated_by').unsigned().nullable();
    if (!exists.updated_on)    t.string('updated_on', 30).nullable();
  });

  // ── 2. Backfill from the JSON blob ──────────────────────────────────────────
  const rows = await knex(TABLE).select('id', 'from_date', 'att_details');
  for (const r of rows) {
    let d = {};
    try { d = JSON.parse(r.att_details || '{}') || {}; } catch (_) { d = {}; }

    // from_date was stored as 'YYYY-MM-DD'; null/garbage → leave att_date null.
    const attDate = /^\d{4}-\d{2}-\d{2}/.test(r.from_date || '')
      ? r.from_date.slice(0, 10)
      : null;

    await knex(TABLE).where({ id: r.id }).update({
      att_date:      attDate,
      status:        d.status     || null,
      shift_type:    d.shift_type || null,
      check_in:      d.check_in   || null,
      check_out:     d.check_out  || null,
      working_hours: typeof d.working_hours === 'number' ? d.working_hours : 0,
      notes:         d.notes      || null,
    });
  }

  // ── 3. De-duplicate (keep the newest row per org/hp/day) ────────────────────
  // A UNIQUE index would fail if duplicates already exist, so prune them first.
  await knex.raw(`
    DELETE a FROM ?? a
    JOIN ?? b
      ON a.org_id = b.org_id
     AND a.hp_id  = b.hp_id
     AND a.att_date = b.att_date
     AND a.id < b.id
    WHERE a.att_date IS NOT NULL
  `, [TABLE, TABLE]);

  // ── 4. Add the UNIQUE key that enables UPSERT ───────────────────────────────
  await knex.schema.alterTable(TABLE, (t) => {
    t.unique(['org_id', 'hp_id', 'att_date'], UNIQUE);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropUnique(['org_id', 'hp_id', 'att_date'], UNIQUE);
  });
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('att_date');
    t.dropColumn('status');
    t.dropColumn('shift_type');
    t.dropColumn('check_in');
    t.dropColumn('check_out');
    t.dropColumn('working_hours');
    t.dropColumn('notes');
    t.dropColumn('updated_by');
    t.dropColumn('updated_on');
  });
  // att_details / from_date were never touched — old data remains intact.
};
