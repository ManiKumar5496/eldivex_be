/**
 * One-off backfill: apply credit notes that were approved before approval
 * started applying them. Those notes are 'Approved' but never reached
 * edx_transaction_ledger, so they are missing from every outstanding figure.
 *
 *   node scripts/backfill_approved_credit_notes.js            # dry run (default)
 *   node scripts/backfill_approved_credit_notes.js --apply    # post the credits
 *   node scripts/backfill_approved_credit_notes.js --apply --org 3   # one org
 *
 * Only notes with nothing applied yet (no APPLIED application rows, used 0)
 * are touched — each in its own transaction with the note re-checked under a
 * row lock, so a re-run never posts twice. A note its booking's invoices can't
 * absorb is reported and skipped.
 */
require('dotenv').config();
const db = require('../config/db');
const { postCreditNoteToBooking } = require('../utils/accountsLedger');
const { round2 } = require('../utils/accountsCalc');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const orgArg = args.indexOf('--org');
const ONLY_ORG = orgArg >= 0 ? Number(args[orgArg + 1]) : null;

const untouched = (q) => q
  .where('cn.status', 'Approved')
  .where(function () { this.whereNull('cn.used_amount').orWhere('cn.used_amount', 0); })
  .whereNotExists(function () {
    this.select(db.raw(1)).from('edx_credit_note_applications as a')
      .whereRaw('a.credit_note_id = cn.id').where('a.status', 'APPLIED');
  });

async function main() {
  const q = untouched(db('edx_credit_notes as cn'))
    .select('cn.id', 'cn.org_id', 'cn.booking_id', 'cn.invoice_id', 'cn.amount', 'cn.reason')
    .orderBy(['cn.org_id', 'cn.id']);
  if (ONLY_ORG != null) q.where('cn.org_id', ONLY_ORG);
  const notes = await q;

  console.log(`${notes.length} approved credit note(s) never applied${ONLY_ORG != null ? ` in org ${ONLY_ORG}` : ''}.`);
  let total = 0;
  for (const n of notes) {
    total += Number(n.amount) || 0;
    console.log(`  CN-${n.id}  org ${n.org_id}  booking ${n.booking_id}  invoice ${n.invoice_id ?? '—'}  ₹${round2(n.amount).toFixed(2)}  ${n.reason ?? ''}`);
  }
  console.log(`Total: ₹${round2(total).toFixed(2)}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to apply these credit notes.');
    return;
  }

  let posted = 0;
  for (const n of notes) {
    try {
      await db.transaction(async (trx) => {
        const locked = await untouched(trx('edx_credit_notes as cn'))
          .where({ 'cn.id': n.id, 'cn.org_id': n.org_id }).forUpdate().first('cn.*');
        if (!locked) return;
        const result = await postCreditNoteToBooking(trx, {
          orgId: locked.org_id, userId: locked.updated_by || null, creditNote: locked,
          notes: 'Backfilled: approved before approval applied credit notes',
        });
        if (!result.ok) {
          console.log(`  CN-${n.id} skipped: booking ${n.booking_id} can only be credited ₹${round2(result.creditable).toFixed(2)} more`);
          return;
        }
        posted++;
      });
    } catch (err) {
      console.error(`  CN-${n.id} failed: ${err.message}`);
    }
  }
  console.log(`\nApplied ${posted} credit note(s).`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.destroy());
