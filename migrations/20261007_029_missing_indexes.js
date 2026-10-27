/**
 * Migration 029 — indexes on join / filter columns.
 *
 * The schema has almost no indexes on FK-like columns, so every booking,
 * invoice and receipt join was a full scan. Each index is guarded:
 *   - table and column must exist (hasTable / hasColumn);
 *   - TEXT / BLOB columns are skipped;
 *   - skipped when any existing index already starts with the same column(s)
 *     (information_schema.statistics), so hand-made indexes are respected;
 *   - VARCHAR columns longer than 191 chars get a 191-char prefix index.
 * down() drops only the indexes created under the names below.
 */

const INDEXES = [
  ['edx_bookings',            ['user_id']],
  ['edx_bookings',            ['patient_id']],
  ['edx_bookings',            ['branch_id']],
  ['edx_bookings',            ['service_type_id']],
  ['edx_booking_hp',          ['bkng_id']],
  ['edx_booking_hp',          ['hp_unique_id']],
  ['edx_invoice',             ['booking_id']],
  ['edx_receipts',            ['booking_id']],
  ['edx_hold_booking',        ['booking_id']],
  ['edx_extension_booking',   ['booking_id']],
  ['edx_service_closed',      ['booking_id']],
  ['edx_write_offs',          ['booking_id']],
  ['edx_credit_notes',        ['booking_id']],
  ['edx_hp_payouts',          ['booking_id']],
  ['edx_hp_rate',             ['hp_unique_id']],
  ['edx_patient',             ['user_id']],
  ['edx_user_address',        ['user_id']],
  ['edx_payment_links',       ['invoice_id']],
  ['edx_payment_reminders',   ['invoice_id', 'reminder_day']],
  ['edx_hostel_settlements',  ['hostel_id']],
  ['edx_hp_registration',     ['hp_reg_phone_number']],
  // org_id on the migration-006 tables (005 indexed org_id on the older ones)
  ['edx_credit_notes',        ['org_id']],
  ['edx_insurance_claims',    ['org_id']],
  ['edx_rate_history',        ['org_id']],
  ['edx_period_closing',      ['org_id']],
  ['edx_payment_reminders',   ['org_id']],
  ['edx_payment_links',       ['org_id']],
  ['edx_audit_log',           ['org_id', 'created_on']],
];

const indexName = (table, cols) => `idx_b2_${table.replace(/^edx_/, '')}_${cols.join('_')}`.slice(0, 64);

async function columnInfo(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT DATA_TYPE AS data_type, CHARACTER_MAXIMUM_LENGTH AS max_len
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0] || null;
}

async function indexesOf(knex, table) {
  const [rows] = await knex.raw(
    `SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [table]
  );
  const map = {};
  for (const r of rows) (map[r.name] = map[r.name] || []).push(String(r.col).toLowerCase());
  return map;
}

// True when some index already has `cols` as its leading columns.
const isCovered = (existing, cols) =>
  Object.values(existing).some((idxCols) => cols.every((c, i) => idxCols[i] === c.toLowerCase()));

exports.up = async function (knex) {
  for (const [table, cols] of INDEXES) {
    if (!(await knex.schema.hasTable(table))) continue;

    let ok = true;
    const parts = [];
    for (const col of cols) {
      if (!(await knex.schema.hasColumn(table, col))) { ok = false; break; }
      const info = await columnInfo(knex, table, col);
      const type = String(info?.data_type || '').toLowerCase();
      if (/(text|blob|json)$/.test(type)) { ok = false; break; }
      const len = Number(info?.max_len) || 0;
      parts.push(type === 'varchar' && len > 191 ? `\`${col}\`(191)` : `\`${col}\``);
    }
    if (!ok) continue;

    const name = indexName(table, cols);
    const existing = await indexesOf(knex, table);
    if (existing[name] || isCovered(existing, cols)) continue;

    await knex.raw(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (${parts.join(', ')})`);
  }
};

exports.down = async function (knex) {
  for (const [table, cols] of INDEXES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const name = indexName(table, cols);
    const existing = await indexesOf(knex, table);
    if (existing[name]) await knex.raw(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
  }
};
