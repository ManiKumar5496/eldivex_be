/**
 * ownerAuthController.js — platform-owner login.
 *
 * The owner platform is a single-operator portal, completely separate from
 * tenant logins (/loginWeb). The owner is NOT a row in edx_web_app_users and
 * NOT role 1 ("Super Admin" is just the eldivex_web tenant's admin role) —
 * the owner is identified by hardcoded credentials and an is_owner JWT claim.
 *
 * Credentials MUST be provided via OWNER_EMAIL / OWNER_PASSWORD_HASH env vars
 * (hash = bcrypt). There are no baked-in defaults — startup fails (see
 * config/envValidator.js) if they are unset, so a real credential is always
 * required and none is ever committed to source.
 */

const bcrypt = require('bcrypt');
const logger = require('../../logger');
const { generateOwnerToken } = require('../../utils/jwt');
require('dotenv').config();

const OWNER_EMAIL = process.env.OWNER_EMAIL;
const OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD_HASH;

const ownerLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (!OWNER_EMAIL || !OWNER_PASSWORD_HASH) {
      logger.error('[ownerAuth] OWNER_EMAIL / OWNER_PASSWORD_HASH not configured');
      return res.status(500).json({ message: 'Owner login is not configured' });
    }

    const emailOk = email.trim().toLowerCase() === OWNER_EMAIL.toLowerCase();
    const passOk  = await bcrypt.compare(password, OWNER_PASSWORD_HASH);

    if (!emailOk || !passOk) {
      logger.warn(`[ownerAuth] failed owner login attempt for ${email}`);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateOwnerToken();
    return res.status(200).json({
      message:   'Login successful',
      token,
      is_owner:  true,
      // role_id/org_id kept for owner-app storage compatibility — they are NOT
      // what grants owner access (the is_owner JWT claim is).
      role_id:   1,
      org_id:    1,
      userId:    0,
      user_name: 'Owner',
      user_image: null,
    });
  } catch (err) {
    logger.error(`[ownerAuth] error: ${err.message}`);
    return res.status(500).json({ message: 'Login failed' });
  }
};

module.exports = { ownerLogin };
