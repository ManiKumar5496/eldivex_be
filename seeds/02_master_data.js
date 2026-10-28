/**
 * Seed: Master data — service categories, services, and support categories.
 * Idempotent: checks for existing records before inserting.
 * Column names follow the migrations: edx_master_services_category.name, and
 * edx_support_category.app_type / status (migration 028 — run migrations first).
 */

const { DEFAULT_SUPPORT_CATEGORIES } = require('../utils/supportCategories');

const ORG_ID = 1;

exports.seed = async function (knex) {
  // ── 1. Service categories ──────────────────────────────────────────────────
  const serviceCategories = [
    { name: 'Caregiving' },
    { name: 'Nursing' },
    { name: 'Physiotherapy' },
    { name: 'Housekeeping' },
  ];

  const categoryIds = {};
  for (const cat of serviceCategories) {
    let row = await knex('edx_master_services_category').where({ name: cat.name, org_id: ORG_ID }).first();
    if (!row) {
      const [id] = await knex('edx_master_services_category').insert({ ...cat, status: 1, org_id: ORG_ID });
      categoryIds[cat.name] = id;
      console.log(`✅ Service category created: ${cat.name} (id: ${id})`);
    } else {
      categoryIds[cat.name] = row.id;
      console.log(`ℹ️  Service category already exists: ${cat.name} (id: ${row.id})`);
    }
  }

  // ── 2. Services (Normal & Premium per category) ────────────────────────────
  const services = [
    { name: 'Basic Caregiving',        service_type: 1, category: 'Caregiving' },
    { name: 'Premium Caregiving',      service_type: 2, category: 'Caregiving' },
    { name: 'Basic Nursing',           service_type: 1, category: 'Nursing' },
    { name: 'ICU Nursing',             service_type: 2, category: 'Nursing' },
    { name: 'Basic Physiotherapy',     service_type: 1, category: 'Physiotherapy' },
    { name: 'Premium Physiotherapy',   service_type: 2, category: 'Physiotherapy' },
    { name: 'Basic Housekeeping',      service_type: 1, category: 'Housekeeping' },
    { name: 'Premium Housekeeping',    service_type: 2, category: 'Housekeeping' },
  ];

  for (const svc of services) {
    const catId = categoryIds[svc.category];
    if (!catId) {
      console.warn(`⚠️  Skipping service "${svc.name}" — category "${svc.category}" not found`);
      continue;
    }
    const existing = await knex('edx_master_services').where({ name: svc.name, org_id: ORG_ID }).first();
    if (!existing) {
      const [id] = await knex('edx_master_services').insert({
        name: svc.name,
        service_type: svc.service_type,
        service_category_id: catId,
        status: 1,
        org_id: ORG_ID,
      });
      console.log(`✅ Service created: ${svc.name} (id: ${id}, type: ${svc.service_type === 2 ? 'Premium' : 'Normal'})`);
    } else {
      console.log(`ℹ️  Service already exists: ${svc.name}`);
    }
  }

  // ── 3. Support ticket categories ───────────────────────────────────────────
  for (const cat of DEFAULT_SUPPORT_CATEGORIES) {
    const existing = await knex('edx_support_category').where({ name: cat.name, org_id: ORG_ID }).first();
    if (!existing) {
      const [id] = await knex('edx_support_category').insert({ ...cat, status: 1, org_id: ORG_ID });
      console.log(`✅ Support category created: ${cat.name} (id: ${id})`);
    } else {
      console.log(`ℹ️  Support category already exists: ${cat.name}`);
    }
  }
};
