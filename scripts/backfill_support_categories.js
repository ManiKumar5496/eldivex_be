/**
 * One-off backfill: default support ticket types (edx_support_category) for
 * organisations that have none — orgs created before createOrganisation
 * started adding them get an empty Ticket Type dropdown.
 *
 *   node scripts/backfill_support_categories.js            # dry run (default)
 *   node scripts/backfill_support_categories.js --apply    # insert the defaults
 *   node scripts/backfill_support_categories.js --apply --org 3   # one org
 *
 * Idempotent: an org that already has any category row (active or not) is
 * skipped, so a re-run never duplicates.
 */
require('dotenv').config();
const db = require('../config/db');
const {
  DEFAULT_SUPPORT_CATEGORIES,
  ensureDefaultSupportCategories,
} = require('../utils/supportCategories');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const orgArg = args.indexOf('--org');
const ONLY_ORG = orgArg >= 0 ? Number(args[orgArg + 1]) : null;

async function main() {
  const q = db('edx_organizations as o')
    .leftJoin('edx_support_category as c', 'c.org_id', 'o.id')
    .whereNull('c.id')
    .distinct('o.id', 'o.name')
    .orderBy('o.id');
  if (ONLY_ORG != null) q.where('o.id', ONLY_ORG);
  const orgs = await q;

  console.log(`${orgs.length} organisation(s) without support categories${ONLY_ORG != null ? ` (org ${ONLY_ORG})` : ''}.`);
  for (const o of orgs) console.log(`  org ${o.id}  ${o.name ?? ''}`);
  console.log(`Defaults: ${DEFAULT_SUPPORT_CATEGORIES.map((c) => c.name).join(', ')}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to insert the defaults.');
    return;
  }

  let inserted = 0;
  for (const o of orgs) {
    try {
      inserted += await db.transaction((trx) => ensureDefaultSupportCategories(trx, o.id));
      console.log(`  org ${o.id}: done`);
    } catch (err) {
      console.error(`  org ${o.id} failed: ${err.message}`);
    }
  }
  console.log(`\nInserted ${inserted} categor${inserted === 1 ? 'y' : 'ies'}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.destroy());
