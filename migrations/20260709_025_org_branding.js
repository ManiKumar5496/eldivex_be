/**
 * 025 — Organisation branding & billing preferences.
 *
 * Adds the fields an org admin manages from Settings → Organisation Profile.
 * These drive every outbound client communication (invoice / receipt emails):
 *   tagline, website, logo_url, brand_color  → email masthead & footer
 *   gstin                                    → tax line on invoices
 *   payment_terms_days                       → invoice due-date calculation
 *   invoice_notes                            → payment instructions block
 *                                              (UPI / bank details, free text)
 */

exports.up = async (knex) => {
  const add = async (col, cb) => {
    const has = await knex.schema.hasColumn('edx_organizations', col);
    if (!has) await knex.schema.alterTable('edx_organizations', cb);
  };

  await add('tagline',            (t) => t.string('tagline', 120).nullable());
  await add('website',            (t) => t.string('website', 150).nullable());
  await add('logo_url',           (t) => t.string('logo_url', 255).nullable());
  await add('brand_color',        (t) => t.string('brand_color', 7).nullable());
  await add('gstin',              (t) => t.string('gstin', 20).nullable());
  await add('payment_terms_days', (t) => t.integer('payment_terms_days').unsigned().defaultTo(15));
  await add('invoice_notes',      (t) => t.string('invoice_notes', 1000).nullable());
};

exports.down = async (knex) => {
  const drop = async (col) => {
    const has = await knex.schema.hasColumn('edx_organizations', col);
    if (has) await knex.schema.alterTable('edx_organizations', (t) => t.dropColumn(col));
  };
  for (const col of ['tagline', 'website', 'logo_url', 'brand_color', 'gstin', 'payment_terms_days', 'invoice_notes']) {
    await drop(col);
  }
};
