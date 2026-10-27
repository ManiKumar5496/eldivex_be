/**
 * termsController.js — Terms & Conditions for the web admin app.
 *
 * GET  /api/getCurrentTerms  (auth) — returns the active `web` T&C plus whether
 *                                     the calling user has already accepted it.
 * POST /api/acceptTerms      (auth) — records the calling user's acceptance of a
 *                                     given terms version (idempotent).
 *
 * Identity (user_id, org_id) is always taken from the verified JWT, never the
 * request body, so a user can only ever accept on their own behalf.
 */

const db = require('../../config/db');
const logger = require('../../logger');
const { getOrgId } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');
const { getCurrentDateTime } = require('../../utils/dateTime');

/** The single active terms row for an audience (default web), or null. */
async function getActiveTerms(audience = 'web') {
  return db('edx_terms')
    .where({ audience, is_active: true })
    .orderBy('version', 'desc')
    .first('id', 'version', 'audience', 'title', 'content', 'effective_from');
}

/**
 * Whether a web user has accepted the currently-active web terms.
 * Returns { accepted: boolean, version: number|null } so the login flow can
 * gate first-time / post-update access without a second round-trip.
 */
async function getAcceptanceStatus(userId) {
  try {
    const active = await getActiveTerms('web');
    if (!active) return { accepted: true, version: null }; // nothing to accept
    const row = await db('edx_web_user_terms_acceptance')
      .where({ user_id: userId, terms_id: active.id })
      .first('id');
    return { accepted: Boolean(row), version: active.version };
  } catch (err) {
    // Fail open: a missing table (code deployed before migration) or transient
    // DB error must never block a valid login. The dedicated /getCurrentTerms
    // endpoint still enforces the gate once the tables exist.
    logger.error(`[termsController] getAcceptanceStatus error: ${err.message}`);
    return { accepted: true, version: null };
  }
}

const getCurrentTerms = async (req, res) => {
  try {
    const active = await getActiveTerms('web');
    if (!active) {
      return res.status(404).json({ success: false, message: 'No active terms found.' });
    }
    const userId = req.login_data?.id;
    const accepted = await db('edx_web_user_terms_acceptance')
      .where({ user_id: userId, terms_id: active.id })
      .first('id', 'accepted_at');

    return res.status(200).json({
      success: true,
      terms: {
        id:             active.id,
        version:        active.version,
        title:          active.title,
        content:        active.content,
        effective_from: active.effective_from,
      },
      accepted:    Boolean(accepted),
      accepted_at: accepted?.accepted_at ?? null,
    });
  } catch (err) {
    logger.error(`[termsController] getCurrentTerms error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to load terms.' });
  }
};

const acceptTerms = async (req, res) => {
  try {
    const userId = req.login_data?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const orgId = getOrgId(req);

    // Resolve the terms being accepted. Prefer the client-supplied terms_id but
    // ALWAYS validate it is the active version — a client cannot satisfy the gate
    // by accepting a stale/arbitrary version.
    const active = await getActiveTerms('web');
    if (!active) {
      return res.status(404).json({ success: false, message: 'No active terms found.' });
    }
    if (req.body?.terms_id != null && Number(req.body.terms_id) !== active.id) {
      return res.status(409).json({
        success: false,
        code: 'TERMS_OUTDATED',
        message: 'The terms have been updated. Please reload and review the latest version.',
      });
    }

    const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').toString().slice(0, 64);
    const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 512);

    // Idempotent: onConflict → ignore so repeat clicks don't error.
    await db('edx_web_user_terms_acceptance')
      .insert({
        user_id:       userId,
        org_id:        orgId,
        terms_id:      active.id,
        terms_version: active.version,
        accepted_at:   getCurrentDateTime(),
        ip_address:    ip,
        user_agent:    userAgent,
      })
      .onConflict(['user_id', 'terms_id'])
      .ignore();

    return res.status(200).json({
      success: true,
      message: 'Terms accepted.',
      version: active.version,
    });
  } catch (err) {
    logger.error(`[termsController] acceptTerms error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to record acceptance.' });
  }
};

module.exports = guardOrgHandlers({
  getCurrentTerms,
  acceptTerms,
  // exported for the login flow
  getAcceptanceStatus,
  getActiveTerms,
}, ['getAcceptanceStatus', 'getActiveTerms']);
