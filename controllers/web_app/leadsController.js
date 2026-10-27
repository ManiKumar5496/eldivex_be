/**
 * leadsController.js
 * Handles public lead capture from the website.
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { resolveOrgId } = require('../../utils/orgCode');
const { isOrgLoginBlocked } = require('../../utils/orgStatus');

// Org that anonymous website leads belong to when the form does not carry an
// org reference (the SaaS marketing site). Overridable via env.
const DEFAULT_LEAD_ORG_ID = Number(process.env.DEFAULT_LEAD_ORG_ID) || 1;

/**
 * POST /api/leads/capture
 * Public endpoint — no auth required.
 * Saves a website lead into edx_client_app_users.
 * If the phone_number already exists in the org, only its EMPTY fields are
 * filled from the lead — existing client data is never overwritten.
 */
const captureLead = async (req, res) => {
  try {
    const { name, phone, email, city, service_enquired, message } = req.body;

    if (!phone || !name) {
      return res.status(400).json({ success: false, error: 'name and phone are required' });
    }

    // Resolve the owning org from the form (org code / id), defaulting to the
    // marketing org. An explicit but unknown reference is rejected rather than
    // silently filed under another org.
    const ref = req.body.org_id ?? req.body.org_code;
    const hasRef = ref !== undefined && ref !== null && ref !== '';
    const orgId = hasRef ? await resolveOrgId(db, ref) : DEFAULT_LEAD_ORG_ID;
    if (!orgId) {
      return res.status(400).json({ success: false, error: 'Unknown organisation.' });
    }
    const org = await db('edx_organizations').where({ id: orgId }).first('id', 'status');
    if (!org || isOrgLoginBlocked(org.status)) {
      return res.status(400).json({ success: false, error: 'Unknown organisation.' });
    }

    const now = getCurrentDateTime();

    // Check if a record for this phone already exists within this org
    const existing = await db('edx_client_app_users')
      .where({ phone_number: phone, org_id: orgId })
      .first();

    let leadId;

    if (existing) {
      // This is a PUBLIC endpoint: anyone who knows a phone number could call
      // it, so it must never overwrite what the client or staff already
      // recorded. Only fields that are still empty are filled in.
      const isEmpty = (v) => v === undefined || v === null || v === '' || v === 'NA';
      const candidate = {
        user_name:          name,
        user_email:         email,
        user_location:      city,
        enquired_for:       service_enquired,
        enquired_for_other: message,
        user_source:        '2',          // Website
        lead_potential:     '2',          // Warm
      };
      const fill = {};
      for (const [col, val] of Object.entries(candidate)) {
        if (!isEmpty(val) && isEmpty(existing[col])) fill[col] = val;
      }
      if (Object.keys(fill).length) {
        fill.updated_on = now;
        await db('edx_client_app_users')
          .where({ id: existing.id, org_id: orgId })
          .update(fill);
      }
      leadId = existing.id;
    } else {
      const [insertedId] = await db('edx_client_app_users').insert({
        phone_number:       phone,
        org_id:             orgId,
        user_name:          name,
        user_email:         email   || null,
        user_location:      city    || null,
        user_source:        '2',          // Website
        lead_potential:     '2',          // Warm
        enquired_for_other: message || null,
        enquired_for:       service_enquired || null,
        is_new_user_flag:   1,
        status:             1,
        created_on:         now,
      });
      leadId = insertedId;
    }

    logger.info(`Lead captured: id=${leadId}, phone=${phone}, org=${orgId}`);
    return res.status(200).json({ success: true, lead_id: leadId });

  } catch (err) {
    logger.error(`captureLead error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to capture lead' });
  }
};

module.exports = { captureLead };
