/**
 * orgBrand.js — organisation identity for outbound communications.
 *
 * Returns { name, org_code, email, phone, address } for the org, cached for
 * 5 minutes so fire-and-forget email hooks don't add a query per send.
 * Returns null if the org can't be found — callers should still send the
 * email (templates fall back to the platform brand).
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // orgId -> { brand, expires }

async function getOrgBrand(db, orgId) {
  if (!orgId) return null;

  const hit = _cache.get(orgId);
  if (hit && hit.expires > Date.now()) return hit.brand;

  let brand;
  try {
    brand = await db('edx_organizations')
      .where({ id: orgId })
      .first(
        'name', 'org_code', 'email', 'phone', 'address',
        'tagline', 'website', 'logo_url', 'brand_color', 'gstin',
        'payment_terms_days', 'invoice_notes',
      ) || null;
  } catch (e) {
    // Branding migration (025) not applied yet — fall back to the base
    // columns so invoice/receipt emails keep working during a staged deploy.
    brand = await db('edx_organizations')
      .where({ id: orgId })
      .first('name', 'org_code', 'email', 'phone', 'address') || null;
  }

  _cache.set(orgId, { brand, expires: Date.now() + CACHE_TTL_MS });
  return brand;
}

/** Call after an org profile update so emails pick up the new identity immediately. */
function clearOrgBrandCache(orgId) {
  if (orgId) _cache.delete(orgId);
  else _cache.clear();
}

module.exports = { getOrgBrand, clearOrgBrandCache };
