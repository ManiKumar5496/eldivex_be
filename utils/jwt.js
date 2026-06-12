const jwt = require('jsonwebtoken');
require('dotenv').config();
const SECRET = process.env.JWT_TOKEN_KEY ;
const expiry =process.env.JWT_EXPIRES_IN || '30d'
// console.log(SECRET)

exports.generateToken = (user) => {
    const token = jwt.sign(
      {
        id: user.id,
        role_id: user.user_role,
        branch_access: user.user_branch_access,
        org_id: user.org_id ?? 1,
      },
      SECRET,
      { expiresIn: expiry }
    );

    return token;
  };

// Platform-owner token. The is_owner claim — not role_id — is what grants
// owner-platform access (requireOwner) and exemption from orgStatusGate.
// Tenant tokens never carry it: generateToken above cannot produce one.
const OWNER_EXPIRY = process.env.OWNER_JWT_EXPIRES_IN || '7d';

exports.generateOwnerToken = () =>
  jwt.sign(
    { id: 0, user_name: 'Owner', is_owner: true, org_id: 1, branch_access: 'all' },
    SECRET,
    { expiresIn: OWNER_EXPIRY }
  );

// Caregiver (Health Professional) self-service token.
// Carries role:'caregiver' + hp_id + org_id. The hpAuth middleware derives the
// caregiver's identity ONLY from these claims — never from the request body —
// which is what enforces per-caregiver and cross-org data isolation.
const HP_EXPIRY = process.env.HP_JWT_EXPIRES_IN || '7d';

exports.generateHpToken = ({ hp_id, org_id }) =>
  jwt.sign(
    { role: 'caregiver', hp_id, org_id: org_id ?? 1 },
    SECRET,
    { expiresIn: HP_EXPIRY }
  );

// Client self-service token. Carries role:'client' + user_id + org_id. The
// clientAuth middleware derives identity ONLY from these claims, enforcing
// per-client and cross-org data isolation.
const CLIENT_EXPIRY = process.env.CLIENT_JWT_EXPIRES_IN || '7d';

exports.generateClientToken = ({ user_id, org_id }) =>
  jwt.sign(
    { role: 'client', user_id, org_id: org_id ?? 1 },
    SECRET,
    { expiresIn: CLIENT_EXPIRY }
  );