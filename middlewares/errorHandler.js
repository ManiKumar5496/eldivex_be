// middleware/errorHandler.js
const logger = require('../logger');

module.exports = (err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
};
