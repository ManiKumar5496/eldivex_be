/**
 * Requires the caller to be the platform owner (role_id === 1).
 * Must be placed after the auth middleware so req.login_data is populated.
 */
module.exports = (req, res, next) => {
  if (!req.login_data || req.login_data.role_id !== 1) {
    return res.status(403).json({ success: false, error: 'Owner access required' });
  }
  next();
};
