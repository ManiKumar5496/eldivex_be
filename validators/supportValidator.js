const Joi = require('joi');

const createSupportTicketSchema = Joi.object({
  user_id: Joi.number().integer().required(),
  support_type_id: Joi.number().integer().required(),
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(5).max(2000).required(),
  booking_details: Joi.string().optional().allow(''),
  start_date: Joi.string().isoDate().optional().allow(''),
  end_date: Joi.string().isoDate().optional().allow(''),
  comments: Joi.string().optional().allow(''),
  conversionlog_details: Joi.string().optional().allow(''),
  created_by_employee: Joi.alternatives().try(Joi.number(), Joi.string()).optional(),
  due_date: Joi.string().optional().allow('')
});

module.exports = { createSupportTicketSchema };
