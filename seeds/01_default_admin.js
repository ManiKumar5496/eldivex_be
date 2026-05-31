/**
 * Seed: Default superadmin user + default branch
 *
 * This seed is idempotent — it checks for existing records before inserting.
 * Default credentials (CHANGE IMMEDIATELY after first login):
 *   Email    : admin@eldivex.com
 *   Password : Admin@1234!
 */

const bcrypt = require('bcrypt');
const { getCurrentDateTime } = require('../utils/dateTime');
const SALT_ROUNDS = 12;

exports.seed = async function (knex) {
  // ── 1. Default branch ──────────────────────────────────────────────────────
  const existingBranch = await knex('edx_branches')
    .where({ br_name: 'Main Branch' })
    .first();

  let branchId;
  if (!existingBranch) {
    const [id] = await knex('edx_branches').insert({
      br_name: 'Main Branch',
      br_phone: '',
      br_email: 'admin@eldivex.com',
      br_address: 'Head Office',
      br_status: 1,
    });
    branchId = id;
    console.log(`✅ Default branch created (id: ${branchId})`);
  } else {
    branchId = existingBranch.br_id;
    console.log(`ℹ️  Default branch already exists (id: ${branchId})`);
  }

  // ── 2. Superadmin role ──────────────────────────────────────────────────────
  const existingRole = await knex('edx_web_emp_roles')
    .where({ role_name: 'Super Admin' })
    .first();

  let roleId;
  if (!existingRole) {
    const [id] = await knex('edx_web_emp_roles').insert({
      role_name: 'Super Admin',
      access_list: JSON.stringify([]), // full access — populate as needed
      status: 1,
      created_on: getCurrentDateTime(),
    });
    roleId = id;
    console.log(`✅ Super Admin role created (id: ${roleId})`);
  } else {
    roleId = existingRole.id;
    console.log(`ℹ️  Super Admin role already exists (id: ${roleId})`);
  }

  // ── 3. Default admin user ──────────────────────────────────────────────────
  const existingUser = await knex('edx_web_app_users')
    .where({ user_email: 'admin@eldivex.com' })
    .first();

  if (!existingUser) {
    const hashedPassword = await bcrypt.hash('Admin@1234!', SALT_ROUNDS);
    const [userId] = await knex('edx_web_app_users').insert({
      user_name: 'Super Admin',
      user_email: 'admin@eldivex.com',
      user_password: hashedPassword,
      user_role: roleId,
      user_home_branch: branchId,
      user_branch_access: String(branchId),
      user_status: 1,
      created_on: getCurrentDateTime(),
    });
    console.log(`✅ Default admin user created (id: ${userId})`);
    console.log('⚠️  IMPORTANT: Change the default password immediately!');
    console.log('   Email   : admin@eldivex.com');
    console.log('   Password: Admin@1234!');
  } else {
    console.log(`ℹ️  Admin user already exists (id: ${existingUser.id})`);
  }
};
