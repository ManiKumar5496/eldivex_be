/**
 * One-off backfill: WRITE_OFF ledger entries for write-offs approved through
 * the legacy PATCH /updateWriteOffStatus, which only flipped the status and
 * never posted to edx_transaction_ledger. Those write-offs are missing from
 * every outstanding figure (client / booking outstanding, accounts list).
 *
 *   node scripts/backfill_v1_writeoff_ledger.js            # dry run (default)
 *   node scripts/backfill_v1_writeoff_ledger.js --apply    # post the entries
 *   node scripts/backfill_v1_writeoff_ledger.js --apply --org 3   # one org
 *
 * Idempotent: only rows with status 'Approved' and no transaction_entry_id are
 * touched, each in its own transaction with the row locked and re-checked, so
 * a re-run (or a concurrent approval) never posts twice. The ledger entry is
 * dated when the write-off was approved (updated_on), falling back to its
 * write-off date.
 */
require('dotenv').config();
const db = require('../config/db');
const { createTransactionEntry } = require('../utils/accountsLedger');
const { round2 } = require('../utils/accountsCalc');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const orgArg = args.indexOf('--org');
const ONLY_ORG = orgArg >= 0 ? Number(args[orgArg + 1]) : null;

async function main() {
  const q = db('edx_write_offs')
    .where({ status: 'Approved' })
    .whereNull('transaction_entry_id')
    .select('id', 'org_id', 'booking_id', 'user_id', 'write_off_amount', 'reason',
      'updated_by', 'updated_on', 'write_off_date')
    .orderBy(['org_id', 'id']);
  if (ONLY_ORG != null) q.where('org_id', ONLY_ORG);
  const rows = await q;

  console.log(`${rows.length} approved write-off(s) without a ledger entry${ONLY_ORG != null ? ` in org ${ONLY_ORG}` : ''}.`);
  let total = 0;
  for (const r of rows) {
    total += Number(r.write_off_amount) || 0;
    console.log(`  WO-${r.id}  org ${r.org_id}  booking ${r.booking_id ?? '—'}  ₹${round2(r.write_off_amount).toFixed(2)}`);
  }
  console.log(`Total: ₹${round2(total).toFixed(2)}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to post these entries.');
    return;
  }

  let posted = 0;
  for (const r of rows) {
    try {
      await db.transaction(async (trx) => {
        const locked = await trx('edx_write_offs').where({ id: r.id, org_id: r.org_id }).forUpdate().first();
        if (!locked || locked.status !== 'Approved' || locked.transaction_entry_id) return;
        const booking = locked.booking_id
          ? await trx('edx_bookings').where({ id: locked.booking_id, org_id: locked.org_id }).first('user_id')
          : null;
        const entryId = await createTransactionEntry(trx, {
          orgId: locked.org_id,
          clientId: locked.user_id || booking?.user_id || null,
          bookingId: locked.booking_id,
          transactionType: 'WRITE_OFF',
          direction: 'CREDIT',
          amount: Number(locked.write_off_amount) || 0,
          referenceId: locked.id,
          referenceType: 'WRITE_OFF',
          description: 'Write-off approved (backfilled): ' + (locked.reason || ''),
          notes: 'Backfilled: approved via the legacy endpoint without a ledger entry',
          createdBy: locked.updated_by || null,
          createdOn: locked.updated_on || locked.write_off_date || undefined,
        });
        await trx('edx_write_offs').where({ id: locked.id, org_id: locked.org_id })
          .update({ transaction_entry_id: entryId });
        posted++;
      });
    } catch (err) {
      console.error(`  WO-${r.id} failed: ${err.message}`);
    }
  }
  console.log(`\nPosted ${posted} ledger entr${posted === 1 ? 'y' : 'ies'}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.destroy());
