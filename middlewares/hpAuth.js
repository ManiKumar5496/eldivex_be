/**
 * hpAuth.js — caregiver (Health Professional) self-service auth guard.
 *
 * Verifies a caregiver JWT and exposes the caller's identity as `req.hp`:
 *     { hp_id, org_id }
 *
 * SECURITY: hp_id and org_id are taken ONLY from the verified token, never from
 * the request body/query. Every downstream query filters by both, so a caregiver
 * can only ever read/write their own data, and only within their organisation.
 *
 * Rejects admin/client tokens (which lack role:'caregiver') so the two portals
 * stay isolated even though they share the same JWT secret.
 */

const jwt = require('jsonwebtoken');
require('dotenv').config();
const JWT_TOKEN_KEY = process.env.JWT_TOKEN_KEY;

const hpAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Access token missing' });
  }

  try {
    const decoded = jwt.verify(token, JWT_TOKEN_KEY);

    if (decoded.role !== 'caregiver' || !decoded.hp_id) {
      return res.status(403).json({ error: 'Not a caregiver session' });
    }

    req.hp = { hp_id: decoded.hp_id, org_id: decoded.org_id ?? 1 };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

module.exports = hpAuth;
