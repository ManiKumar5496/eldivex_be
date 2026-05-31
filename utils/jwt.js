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