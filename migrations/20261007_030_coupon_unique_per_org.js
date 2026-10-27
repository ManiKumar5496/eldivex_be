/**
 * Migration 030 — coupon names unique per org, not globally.
 *
 * 001 created edx_master_coupons.coupon_name UNIQUE, so a second tenant could
 * never create a coupon called "WELCOME10". Replaces every single-column unique
 * index on coupon_name (looked up by its real name in information_schema) with
 * UNIQUE (org_id, coupon_name) named uq_coupon_org_name.
 *
 * Guarded: no-op when the composite already exists. Refuses (throws) rather
 * than silently skipping when duplicate (org_id, coupon_name) rows exist.
 * down() restores a global unique on coupon_name (fails loudly if two orgs now
 * share a name).
 */

const TABLE = 'edx_master_coupons';
const COMPOSITE = 'uq_coupon_org_name';
const GLOBAL = 'edx_master_coupons_coupon_name_unique';

async function uniqueIndexes(knex) {
  const [rows] = await knex.raw(
    `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND NON_UNIQUE = 0
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [TABLE]
  );
  const map = {};
  for (const r of rows) (map[r.name] = map[r.name] || []).push(String(r.col).toLowerCase());
  return map;
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'org_id'))) return;

  const uniques = await uniqueIndexes(knex);

  if (!uniques[COMPOSITE]) {
    const [dups] = await knex.raw(
      `SELECT org_id, coupon_name, COUNT(*) AS cnt FROM \`${TABLE}\`
        GROUP BY org_id, coupon_name HAVING cnt > 1 LIMIT 5`
    );
    if (dups.length) {
      throw new Error(`[030] duplicate (org_id, coupon_name) rows exist — resolve them first: ${JSON.stringify(dups)}`);
    }
    await knex.raw(`ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`${COMPOSITE}\` (\`org_id\`, \`coupon_name\`)`);
  }

  for (const [name, cols] of Object.entries(uniques)) {
    if (name === 'PRIMARY') continue;
    if (cols.length === 1 && cols[0] === 'coupon_name') {
      await knex.raw(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${name}\``);
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const uniques = await uniqueIndexes(knex);

  const hasGlobal = Object.values(uniques).some((c) => c.length === 1 && c[0] === 'coupon_name');
  if (!hasGlobal) {
    const [dups] = await knex.raw(
      `SELECT coupon_name, COUNT(*) AS cnt FROM \`${TABLE}\` GROUP BY coupon_name HAVING cnt > 1 LIMIT 5`
    );
    if (dups.length) {
      throw new Error(`[030 down] coupon names shared across orgs — cannot restore global unique: ${JSON.stringify(dups)}`);
    }
    await knex.raw(`ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`${GLOBAL}\` (\`coupon_name\`)`);
  }
  if (uniques[COMPOSITE]) await knex.raw(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${COMPOSITE}\``);
};
