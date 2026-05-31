const jwt = require('jsonwebtoken');
require('dotenv').config();
const JWT_TOKEN_KEY = process.env.JWT_TOKEN_KEY; // Load this from your .env

const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // supports "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Access token missing' });
  }

  try {
    const decoded = jwt.verify(token, JWT_TOKEN_KEY);
    req.login_data = decoded; // { id, role_id, branch_access }
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

module.exports = authenticate;
