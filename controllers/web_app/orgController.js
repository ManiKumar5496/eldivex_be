/**
 * orgController.js — Phase 5.4
 *
 * GET  /api/getOrganisations          — superadmin; all orgs + plan name
 * POST /api/createOrganisation        — superadmin; create org + default sub
 * PUT  /api/updateOrganisation/:id    — superadmin; update org fields
 * GET  /api/getOrgDetails             — any authenticated user; own org
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const bcrypt = require('bcrypt');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { logAudit }           = require('../../utils/auditLogger');
const { generateOrgCode }    = require('../../utils/orgCode');
const { invalidateOrgStatusCache } = require('../../middlewares/orgStatusGate');
const withTransaction        = require('../../utils/withTransaction');
const { getOrgId }           = require('../../utils/orgScope');
const { ensureDefaultSupportCategories } = require('../../utils/supportCategories');

function requireSuperadmin(req, res) {
  // Owner = is_owner JWT claim from /ownerLogin, never a tenant role.
  if (req.login_data?.is_owner !== true) {
    res.status(403).json({ message: 'Owner access required.' });
    return false;
  }
  return true;
}

// ── 1. List all organisations ─────────────────────────────────────────────────

const getOrganisations = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const orgs = await db('edx_organizations as o')
      .leftJoin(
        db('edx_subscriptions')
          .select('org_id')
          .max('id as sub_id')
          .where('status', 'active')
          .groupBy('org_id')
          .as('latest_sub_ref'),
        'latest_sub_ref.org_id', 'o.id'
      )
      .leftJoin('edx_subscriptions as s', 's.id', 'latest_sub_ref.sub_id')
      .leftJoin('edx_plans as p', 's.plan_id', 'p.id')
      .select(
        'o.id',
        'o.org_code',
        'o.name',
        'o.slug',
        'o.email',
        'o.phone',
        'o.address',
        'o.status',
        'o.created_on',
        'p.name as plan_name',
        's.status as sub_status',
        's.expires_on',
      )
      .orderBy('o.id', 'asc');

    res.json(orgs);
  } catch (err) {
    logger.error(`[orgController] getOrganisations error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch organisations.' });
  }
};

// ── 2. Create organisation ────────────────────────────────────────────────────

const createOrganisation = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const {
      name,
      slug,
      email,
      phone,
      address,
      plan_id = 1,
      admin_name,
      admin_email,
      admin_password,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ message: 'name and slug are required.' });
    }

    // Check slug uniqueness
    const existing = await db('edx_organizations')
      .whereRaw('LOWER(slug) = ?', [slug.trim().toLowerCase()])
      .first();
    if (existing) {
      return res.status(409).json({ message: 'Slug already in use.' });
    }

    // Soft check: warn if a near-duplicate name exists (case-insensitive)
    const nameDuplicate = await db('edx_organizations')
      .whereRaw('LOWER(name) = ?', [name.trim().toLowerCase()])
      .first();
    if (nameDuplicate) {
      return res.status(409).json({
        message: `An organisation named "${nameDuplicate.name}" already exists.`,
        code: 'DUPLICATE_NAME',
        existing_id: nameDuplicate.id,
      });
    }

    // Public org code (e.g. SUN-482913) — what users see and log in with.
    // Pre-existing orgs have org_code = NULL and keep using their numeric id.
    const org_code = await generateOrgCode(db, name);

    // Org, default subscription, the org's Super Admin role and admin user are
    // created atomically — a failure part-way never leaves a half-built tenant.
    const hashed = admin_email && admin_password ? await bcrypt.hash(admin_password, 10) : null;
    const org_id = await withTransaction(async (trx) => {
      const [newOrgId] = await trx('edx_organizations').insert({
        name,
        slug,
        org_code,
        email:    email   || null,
        phone:    phone   || null,
        address:  address || null,
        plan_id,
        status: 'active',
        created_on: getCurrentDateTime(),
      });

      // Create default subscription (active, no expiry)
      await trx('edx_subscriptions').insert({
        org_id:      newOrgId,
        plan_id,
        status:      'active',
        started_on:  getCurrentDateTime(),
        activated_by: req.login_data.id,
        created_on:  getCurrentDateTime(),
      });

      // Default support ticket types, so the org's ticket forms aren't empty
      await ensureDefaultSupportCategories(trx, newOrgId);

      // Optionally create an admin user for the new org
      if (hashed) {
        // Each org gets its own Super Admin role (scoped to this org_id) with full
        // module access — never reuse the global role id 1, which belongs to org 1.
        const mods = await trx('edx_web_module').select('id');
        const accessList = mods.map((m) => m.id).join(','); // comma-separated for FIND_IN_SET

        const [adminRoleId] = await trx('edx_web_emp_roles').insert({
          role_name:   'Super Admin',
          access_list: accessList,   // every module id → full side-panel access
          status:      1,
          org_id:      newOrgId,     // the org we just created
          created_by:  req.login_data.id,
          created_on:  getCurrentDateTime(),
        });

        await trx('edx_web_app_users').insert({
          user_name:          admin_name || 'Admin',
          user_email:         admin_email,
          user_password:      hashed,
          user_role:          adminRoleId, // this org's own Super Admin role
          user_mobile:        null,
          user_gender:        null,
          user_home_branch:   null,
          user_branch_access: 'all',
          user_status:        1,
          org_id:             newOrgId,
          created_by: req.login_data.id,
          created_on: getCurrentDateTime(),
        });
      }
      return newOrgId;
    });

    logAudit({
      entityType: 'ORGANISATION',
      entityId:   org_id,
      action:     'CREATE',
      changedBy:  req.login_data.id,
      org_id,
      newValues:  { name, slug, org_code, plan_id, admin_email: admin_email || null },
    });

    const org = await db('edx_organizations').where({ id: org_id }).first();
    res.status(201).json({ message: 'Organisation created successfully.', data: org });
  } catch (err) {
    logger.error(`[orgController] createOrganisation error: ${err.message}`);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Slug or admin email already in use.' });
    }
    res.status(500).json({ message: 'Failed to create organisation.' });
  }
};

// ── 3. Update organisation ────────────────────────────────────────────────────

const updateOrganisation = async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;

    const { id } = req.params;
    const { name, email, phone, address, status } = req.body;

    const existing = await db('edx_organizations').where({ id }).first();
    if (!existing) {
      return res.status(404).json({ message: 'Organisation not found.' });
    }

    const payload = {};
    if (name    !== undefined) payload.name    = name;
    if (email   !== undefined) payload.email   = email;
    if (phone   !== undefined) payload.phone   = phone;
    if (address !== undefined) payload.address = address;
    if (status  !== undefined) payload.status  = status;

    await db('edx_organizations').where({ id }).update(payload);

    if (status !== undefined && status !== existing.status) {
      invalidateOrgStatusCache(id);
      logAudit({
        entityType: 'ORGANISATION',
        entityId:   Number(id),
        action:     'STATUS_CHANGE',
        changedBy:  req.login_data.id,
        org_id:     Number(id),
        oldValues:  { status: existing.status },
        newValues:  { status },
      });
    }

    res.json({ message: 'Organisation updated successfully.' });
  } catch (err) {
    logger.error(`[orgController] updateOrganisation error: ${err.message}`);
    res.status(500).json({ message: 'Failed to update organisation.' });
  }
};

// ── 4. Get own org details ────────────────────────────────────────────────────

const getOrgDetails = async (req, res) => {
  try {
    // Owner-only route: the target org comes from ?org_id. (A staff caller
    // would get their own org from the token.)
    const orgId = req.login_data?.is_owner === true
      ? parseInt(req.query.org_id, 10) || null
      : getOrgId(req);
    if (!orgId) {
      return res.status(req.login_data?.is_owner === true ? 400 : 401)
        .json({ message: 'Organisation context is required.' });
    }

    const org = await db('edx_organizations as o')
      .leftJoin('edx_plans as p', 'o.plan_id', 'p.id')
      .where('o.id', orgId)
      .select(
        'o.id',
        'o.org_code',
        'o.name',
        'o.slug',
        'o.email',
        'o.phone',
        'o.address',
        'o.status',
        'o.created_on',
        'p.name as plan_name',
        'p.features',
        'p.booking_limit',
        'p.hp_limit',
      )
      .first();

    if (!org) {
      return res.status(404).json({ message: 'Organisation not found.' });
    }

    res.json(org);
  } catch (err) {
    logger.error(`[orgController] getOrgDetails error: ${err.message}`);
    res.status(500).json({ message: 'Failed to fetch organisation details.' });
  }
};

module.exports = { getOrganisations, createOrganisation, updateOrganisation, getOrgDetails };
