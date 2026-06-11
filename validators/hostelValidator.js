const Joi = require('joi');

const createHostelSchema = Joi.object({
  hostel_name: Joi.string().min(3).max(150).required(),
  address: Joi.string().max(255).optional().allow(''),
  city: Joi.string().max(100).optional().allow(''),
  state: Joi.string().max(100).optional().allow(''),
  pincode: Joi.string().pattern(/^[0-9]{6}$/).optional().allow(''),
  gender: Joi.string().valid('Male', 'Female').required(),
  rate_per_day: Joi.number().positive().required(),
  capacity: Joi.number().integer().positive().optional(),
  contact_person_name: Joi.string().max(150).optional().allow(''),
  contact_phone: Joi.string().pattern(/^[0-9]{10,15}$/).optional().allow(''),
  contact_email: Joi.string().email().optional().allow(''),
  branch_id: Joi.number().integer().optional(),
});

const updateHostelSchema = Joi.object({
  hostel_name: Joi.string().min(3).max(150).optional(),
  address: Joi.string().max(255).optional().allow(''),
  city: Joi.string().max(100).optional().allow(''),
  state: Joi.string().max(100).optional().allow(''),
  pincode: Joi.string().pattern(/^[0-9]{6}$/).optional().allow(''),
  gender: Joi.string().valid('Male', 'Female').optional(),
  rate_per_day: Joi.number().positive().optional(),
  capacity: Joi.number().integer().positive().optional(),
  contact_person_name: Joi.string().max(150).optional().allow(''),
  contact_phone: Joi.string().pattern(/^[0-9]{10,15}$/).optional().allow(''),
  contact_email: Joi.string().email().optional().allow(''),
  branch_id: Joi.number().integer().optional(),
});

const createStaySchema = Joi.object({
  hostel_id: Joi.number().integer().required(),
  hp_id: Joi.number().integer().required(),
  check_in_date: Joi.string().isoDate().required(),
  check_out_date: Joi.string().isoDate().optional().allow(null, ''),
});

const closeStaySchema = Joi.object({
  check_out_date: Joi.string().isoDate().required(),
});

const createSettlementSchema = Joi.object({
  hostel_id: Joi.number().integer().required(),
  period_from: Joi.string().isoDate().required(),
  period_to: Joi.string().isoDate().required(),
  payment_mode: Joi.string().max(50).optional().allow(''),
});

module.exports = {
  createHostelSchema,
  updateHostelSchema,
  createStaySchema,
  closeStaySchema,
  createSettlementSchema,
};
