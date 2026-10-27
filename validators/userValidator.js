const Joi = require('joi');

const loginWebSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'A valid email address is required',
    'any.required': 'Email is required'
  }),
  password: Joi.string().min(1).required().messages({
    'string.empty': 'Password is required',
    'any.required': 'Password is required'
  })
});

const createUserSchema = Joi.object({
  user_name: Joi.string().min(2).max(100).required(),
  user_email: Joi.string().email().required(),
  user_mobile: Joi.string().pattern(/^[0-9]{10,15}$/).required().messages({
    'string.pattern.base': 'Mobile number must be 10-15 digits'
  }),
  user_password: Joi.string().min(6).required(),
  user_role: Joi.number().integer().required(),
  user_gender: Joi.number().integer().valid(1, 2, 3).optional().messages({
    'any.only': 'Gender must be 1 (Male), 2 (Female) or 3 (Other)'
  }),
  user_home_branch: Joi.number().integer().optional(),
  user_branch_access: Joi.string().optional()
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'A valid email address is required',
    'any.required': 'Email is required',
  }),
});

const resetPasswordSchema = Joi.object({
  token:       Joi.string().min(64).required().messages({
    'string.min':  'Invalid reset token',
    'any.required': 'Reset token is required',
  }),
  newPassword: Joi.string().min(8).required().messages({
    'string.min':  'Password must be at least 8 characters',
    'any.required': 'New password is required',
  }),
});

module.exports = { loginWebSchema, createUserSchema, forgotPasswordSchema, resetPasswordSchema };
