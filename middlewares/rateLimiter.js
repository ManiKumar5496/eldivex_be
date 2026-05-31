const rateLimit = require('express-rate-limit');

/**
 * Strict limiter for authentication endpoints.
 * 10 attempts per 15 minutes per IP — prevents brute force on login.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for localhost during development
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.connection?.remoteAddress || '';
      return ip === '::1' || ip === '127.0.0.1' || ip.includes('::ffff:127.');
    }
    return false;
  },
  message: {
    error: 'Too many login attempts. Please wait 15 minutes before trying again.'
  },
  handler: (req, res, next, options) => {
    res.status(429).json(options.message);
  }
});

/**
 * General API limiter.
 * 200 requests per 15 minutes per IP — prevents scraping/abuse.
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please slow down.'
  }
});

module.exports = { authLimiter, generalLimiter };
