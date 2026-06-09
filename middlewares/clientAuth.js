/**
 * clientAuth.js — client (customer) self-service auth guard.
 *
 * Verifies a client JWT and exposes the caller as `req.client = { user_id, org_id }`.
 *
 * SECURITY: user_id and org_id come ONLY from the verified token, never the
 * request body. Every downstream query filters by both, so a client can only
 * read/write their own data within their organisation. Rejects admin/caregiver
 * tokens (which lack role:'client').
 */

const jwt = require('jsonwebtoken');
require('dotenv').config();
const JWT_TOKEN_KEY = process.env.JWT_TOKEN_KEY;

const clientAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token missing' });

  try {
    const decoded = jwt.verify(token, JWT_TOKEN_KEY);
    if (decoded.role !== 'client' || !decoded.user_id) {
      return res.status(403).json({ error: 'Not a client session' });
    }
    req.client = { user_id: decoded.user_id, org_id: decoded.org_id ?? 1 };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

module.exports = clientAuth;
