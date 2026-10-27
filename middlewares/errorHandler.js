// middleware/errorHandler.js
const logger = require('../logger');

module.exports = (err, req, res, next) => {
  // Upload rejections (file filter / size limit) are client errors with a
  // safe message; everything else stays a generic 500.
  if (err && (err.name === 'MulterError' || (err.expose && err.status >= 400 && err.status < 500))) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5MB).' : err.message;
    return res.status(err.status && err.status < 500 ? err.status : 400).json({ error: message });
  }
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
};
