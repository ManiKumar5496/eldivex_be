/**
 * validateRequest.js
 * Middleware factory that validates req.body against a Joi schema.
 * Returns HTTP 422 with error details on validation failure.
 */

const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,      // collect all errors, not just the first
      allowUnknown: true,     // allow extra fields (don't strip them)
      stripUnknown: false
    });

    if (error) {
      const details = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message.replace(/['"]/g, '')
      }));

      return res.status(422).json({
        error: 'Validation failed',
        details
      });
    }

    next();
  };
};

module.exports = validateRequest;
