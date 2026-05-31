exports.up = async function (knex) {
  const hasBrCity  = await knex.schema.hasColumn('edx_branches', 'br_city');
  const hasBrState = await knex.schema.hasColumn('edx_branches', 'br_state');

  if (!hasBrCity || !hasBrState) {
    await knex.schema.alterTable('edx_branches', (t) => {
      if (!hasBrCity)  t.string('br_city',  100).nullable().after('br_address');
      if (!hasBrState) t.string('br_state', 100).nullable().after('br_city');
    });
    console.log('✅ Added br_city and br_state to edx_branches');
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('edx_branches', (t) => {
    t.dropColumn('br_city');
    t.dropColumn('br_state');
  });
};
