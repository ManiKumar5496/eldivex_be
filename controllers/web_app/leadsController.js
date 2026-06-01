/**
 * leadsController.js
 * Handles public lead capture from the website.
 */

const db     = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');

/**
 * POST /api/leads/capture
 * Public endpoint — no auth required.
 * Saves a website lead into edx_client_app_users.
 * If the phone_number already exists the record is enriched with the new lead details.
 */
const captureLead = async (req, res) => {
  try {
    const { name, phone, email, city, service_enquired, message } = req.body;

    if (!phone || !name) {
      return res.status(400).json({ success: false, error: 'name and phone are required' });
    }

    const now = getCurrentDateTime();

    // Check if a record for this phone already exists
    const existing = await db('edx_client_app_users')
      .where({ phone_number: phone })
      .first();

    let leadId;

    if (existing) {
      // Enrich the existing record with the latest lead info
      await db('edx_client_app_users')
        .where({ phone_number: phone })
        .update({
          user_name:          name,
          user_email:         email   || existing.user_email,
          user_location:      city    || existing.user_location,
          user_source:        '2',          // Website
          lead_potential:     '2',          // Warm
          enquired_for_other: message || existing.enquired_for_other,
          enquired_for:       service_enquired || existing.enquired_for,
          updated_on:         now,
        });
      leadId = existing.id;
    } else {
      const [insertedId] = await db('edx_client_app_users').insert({
        phone_number:       phone,
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

    logger.info(`Lead captured: id=${leadId}, phone=${phone}`);
    return res.status(200).json({ success: true, lead_id: leadId });

  } catch (err) {
    logger.error('captureLead error:', err);
    return res.status(500).json({ success: false, error: 'Failed to capture lead' });
  }
};

module.exports = { captureLead };
