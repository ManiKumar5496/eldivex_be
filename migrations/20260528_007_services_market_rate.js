exports.up = async (knex) => {
  await knex.schema.alterTable('edx_master_services', (t) => {
    t.decimal('market_rate', 10, 2).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('edx_master_services', (t) => {
    t.dropColumn('market_rate');
  });
};
