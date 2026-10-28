/**
 * supportCategories.js — the support ticket types every organisation starts
 * with (edx_support_category), and the helper that gives an org its defaults.
 *
 * The web app picks a ticket's extra fields, and bookings detect open hold /
 * cancellation tickets, by name ('hold', 'cancel', 'replacement'), so keep
 * those words in the names below.
 */

const DEFAULT_SUPPORT_CATEGORIES = Object.freeze([
  { name: 'Billing Issue',         app_type: 'web' },
  { name: 'Service Hold',          app_type: 'web' },
  { name: 'Service Cancellation',  app_type: 'web' },
  { name: 'Caregiver Replacement', app_type: 'web' },
  { name: 'General Inquiry',       app_type: 'web' },
  { name: 'Booking Help',          app_type: 'client' },
  { name: 'Payment Issue',         app_type: 'client' },
  { name: 'Payout Issue',          app_type: 'hp' },
  { name: 'Attendance Issue',      app_type: 'hp' },
]);

// Insert the defaults for an org that has no support categories at all (an
// org whose categories were all deactivated is left alone). Returns how many
// rows were inserted.
async function ensureDefaultSupportCategories(trxOrDb, orgId) {
  const existing = await trxOrDb('edx_support_category').where({ org_id: orgId }).first('id');
  if (existing) return 0;
  await trxOrDb('edx_support_category').insert(
    DEFAULT_SUPPORT_CATEGORIES.map((c) => ({ ...c, status: 1, org_id: orgId }))
  );
  return DEFAULT_SUPPORT_CATEGORIES.length;
}

module.exports = { DEFAULT_SUPPORT_CATEGORIES, ensureDefaultSupportCategories };
