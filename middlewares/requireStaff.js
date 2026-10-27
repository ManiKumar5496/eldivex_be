/**
 * Requires a tenant staff session (token from /loginWeb).
 * Rejects platform-owner tokens: the owner acts on orgs only through the
 * owner-platform routes (auth + requireOwner), never through tenant routes.
 * Must be placed after the auth middleware so req.login_data is populated.
 */
module.exports = (req, res, next) => {
  const d = req.login_data;
  if (!d || d.is_owner === true || d.role_id === null || d.role_id === undefined || !d.org_id) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
};
