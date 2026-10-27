const Joi = require('joi');

const createBookingSchema = Joi.object({
  user_id: Joi.number().integer().required(),
  branch_id: Joi.number().integer().required(),
  service_type_id: Joi.number().integer().required(),
  service_start_date: Joi.string().isoDate().required(),
  service_end_date: Joi.string().isoDate().required(),
  service_start_time: Joi.string().optional(),
  service_end_time: Joi.string().optional(),
  address_id: Joi.number().integer().optional(),
  base_rate: Joi.number().positive().required(),
  base_discount_percentage: Joi.number().min(0).max(100).optional(),
  // patient fields
  patient_name: Joi.string().min(2).max(150).required(),
  phone_number: Joi.string().pattern(/^[0-9]{10,15}$/).optional(),
  email: Joi.string().email().optional().allow(''),
  age: Joi.number().integer().min(0).max(150).optional(),
  yob: Joi.number().integer().min(1900).max(2100).optional(),
  weight: Joi.number().min(0).optional(),
  languages: Joi.string().optional(),
  relation: Joi.string().optional(),
  gender: Joi.number().valid(1, 2, 3).optional(),
  is_stay_alone: Joi.number().valid(0, 1).optional(),
  // booking care details (optional)
  patient_conditions_others: Joi.string().max(2000).allow('', null).optional(),
  spl_care_requirements: Joi.string().max(2000).allow('', null).optional(),
  placement_time: Joi.string().max(30).allow('', null).optional()
});

const extendBookingSchema = Joi.object({
  booking_id: Joi.number().integer().required(),
  from_date: Joi.string().isoDate().required(),
  to_date: Joi.string().isoDate().required(),
  from_time: Joi.string().optional(),
  to_time: Joi.string().optional(),
  hp_id: Joi.number().integer().optional(),
  hp_unique_id: Joi.number().integer().optional()
});

const finalBookingSaveSchema = Joi.object({
  booking_id: Joi.number().integer().required(),
  otp: Joi.string().length(6).required().messages({
    'string.length': 'OTP must be exactly 6 digits'
  }),
  hp_unique_id: Joi.number().integer().required()
});

module.exports = { createBookingSchema, extendBookingSchema, finalBookingSaveSchema };
