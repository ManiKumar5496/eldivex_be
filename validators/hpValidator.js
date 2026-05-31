const Joi = require('joi');

const createHPSchema = Joi.object({
  hp_reg_first_name: Joi.string().min(2).max(100).required(),
  hp_reg_last_name: Joi.string().min(1).max(100).required(),
  hp_reg_email: Joi.string().email().optional().allow(''),
  hp_reg_phone_number: Joi.string().pattern(/^[0-9]{10,15}$/).required().messages({
    'string.pattern.base': 'Phone number must be 10-15 digits'
  }),
  hp_reg_address: Joi.string().optional().allow(''),
  hp_reg_dob: Joi.string().optional().allow(''),
  hp_reg_gender: Joi.string().valid('Male', 'Female', 'Other').optional(),
  hp_reg_city: Joi.string().optional().allow(''),
  hp_reg_state: Joi.string().optional().allow(''),
  hp_reg_pin_code: Joi.string().pattern(/^[0-9]{6}$/).optional().allow(''),
  hp_reg_emergency_contact_phone: Joi.string().optional().allow(''),
  hp_reg_languages: Joi.string().optional().allow(''),
  hp_reg_branch_id: Joi.number().integer().required(),
  hp_reg_marital_status: Joi.string().optional().allow(''),
  hp_reg_experience: Joi.number().min(0).max(60).optional(),
  hp_reg_father_name: Joi.string().optional().allow(''),
  hp_reg_father_occupation: Joi.string().optional().allow(''),
  hp_reg_mother_name: Joi.string().optional().allow(''),
  hp_reg_identity_proof_type: Joi.string().optional().allow(''),
  hp_reg_identity_proof_number: Joi.string().optional().allow(''),
  hp_reg_education: Joi.string().optional().allow(''),
  // pay rates
  livein_pay: Joi.number().min(0).optional(),
  liveout_pay: Joi.number().min(0).optional(),
  monthly_livein_pay: Joi.number().min(0).optional(),
  monthly_liveout_pay: Joi.number().min(0).optional(),
  hp_effect_date: Joi.string().optional().allow('')
});

module.exports = { createHPSchema };
