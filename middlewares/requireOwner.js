/**
 * Requires the caller to be the platform owner.
 * Owner identity comes from the is_owner JWT claim issued by /ownerLogin —
 * NOT from role_id ("Super Admin" role 1 is just a tenant role of eldivex_web).
 * Must be placed after the auth middleware so req.login_data is populated.
 */
module.exports = (req, res, next) => {
  if (!req.login_data || req.login_data.is_owner !== true) {
    return res.status(403).json({ success: false, error: 'Owner access required' });
  }
  next();
};
