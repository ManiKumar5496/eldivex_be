/**
 * Seed edx_master_languages. The Create HP form spins forever when this table
 * is empty (the language picker shows a loader until rows arrive). getLangM
 * returns all rows regardless of org, so a single shared set (org_id 1) serves
 * every tenant. Idempotent — only inserts names that aren't already present.
 */
const LANGUAGES = [
  'English', 'Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam',
  'Marathi', 'Bengali', 'Gujarati', 'Punjabi', 'Urdu', 'Odia',
  'Assamese', 'Konkani',
];

exports.up = async (knex) => {
  const existing = await knex('edx_master_languages').pluck('name');
  const have = new Set(existing.map((n) => String(n).toLowerCase()));
  const rows = LANGUAGES
    .filter((name) => !have.has(name.toLowerCase()))
    .map((name) => ({ name, org_id: 1 }));
  if (rows.length) await knex('edx_master_languages').insert(rows);
};

exports.down = async (knex) => {
  await knex('edx_master_languages').whereIn('name', LANGUAGES).del();
};
