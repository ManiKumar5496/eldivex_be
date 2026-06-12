/**
 * orgCode.js — public organisation codes (e.g. SUN-482913).
 *
 * Format: first 3 letters of the org name (A–Z, padded with X) + '-' +
 * 6 crypto-random digits. The numeric edx_organizations.id remains the
 * internal/FK identifier; the code is the only org reference exposed to
 * caregivers and clients. Orgs created before the code rollout have
 * org_code = NULL and keep using their numeric id at login.
 */

const crypto = require('crypto');

const ORG_CODE_RE = /^[A-Z]{3}-\d{6}$/;

// "Sunrise Care" → SUN, "A1 Homes" → AHO, "Z" → ZXX.
const codePrefix = (name) =>
  (String(name || '').toUpperCase().replace(/[^A-Z]/g, '') + 'XXX').slice(0, 3);

/** Generate a unique org code for a new organisation. */
const generateOrgCode = async (db, name) => {
  const prefix = codePrefix(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = `${prefix}-${crypto.randomInt(100000, 1000000)}`;
    const clash = await db('edx_organizations').where({ org_code: code }).first('id');
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique org code.');
};

/**
 * Resolve a public org reference to the internal numeric id.
 * Accepts a numeric id (legacy orgs) or an org code (new orgs).
 * Returns null when the value is malformed or the code is unknown.
 */
const resolveOrgId = async (db, ref) => {
  const value = String(ref ?? '').trim();
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const code = value.toUpperCase();
  if (!ORG_CODE_RE.test(code)) return null;
  const org = await db('edx_organizations').where({ org_code: code }).first('id');
  return org ? org.id : null;
};

module.exports = { generateOrgCode, resolveOrgId, ORG_CODE_RE };
