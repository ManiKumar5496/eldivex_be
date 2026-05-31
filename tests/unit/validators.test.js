/**
 * Unit tests — Joi validators (Phase 1.3)
 * Verifies every schema accepts valid data and rejects missing required fields.
 */

const { loginWebSchema, createUserSchema }         = require('../../validators/userValidator');
const { createBookingSchema, extendBookingSchema, finalBookingSaveSchema } = require('../../validators/bookingValidator');
const { createHPSchema }                           = require('../../validators/hpValidator');
const { createSupportTicketSchema }                = require('../../validators/supportValidator');

// Helper
function validate(schema, data) {
  const { error } = schema.validate(data, { abortEarly: false, allowUnknown: true });
  return {
    valid: !error,
    fields: error ? error.details.map(d => d.path.join('.')) : [],
  };
}

// ── Login ────────────────────────────────────────────────────────────────────

describe('loginWebSchema', () => {
  test('accepts valid email + password', () => {
    expect(validate(loginWebSchema, { email: 'admin@test.com', password: 'Secret1!' }).valid).toBe(true);
  });
  test('rejects missing email', () => {
    const { valid, fields } = validate(loginWebSchema, { password: 'Secret1!' });
    expect(valid).toBe(false);
    expect(fields).toContain('email');
  });
  test('rejects invalid email format', () => {
    const { valid, fields } = validate(loginWebSchema, { email: 'not-an-email' });
    expect(valid).toBe(false);
    expect(fields).toContain('email');
  });
});

// ── Create Booking ───────────────────────────────────────────────────────────

describe('createBookingSchema', () => {
  const valid = {
    user_id: 1,
    branch_id: 1,
    service_type_id: 2,
    service_start_date: '2026-06-01',
    service_end_date: '2026-06-30',
    base_rate: 500,
    patient_name: 'Radha Devi',
  };

  test('accepts all required fields', () => {
    expect(validate(createBookingSchema, valid).valid).toBe(true);
  });

  test('rejects missing user_id', () => {
    const { valid: ok, fields } = validate(createBookingSchema, { ...valid, user_id: undefined });
    expect(ok).toBe(false);
    expect(fields).toContain('user_id');
  });

  test('rejects missing branch_id', () => {
    const { fields } = validate(createBookingSchema, { ...valid, branch_id: undefined });
    expect(fields).toContain('branch_id');
  });

  test('rejects missing service_type_id', () => {
    const { fields } = validate(createBookingSchema, { ...valid, service_type_id: undefined });
    expect(fields).toContain('service_type_id');
  });

  test('rejects missing service_start_date', () => {
    const { fields } = validate(createBookingSchema, { ...valid, service_start_date: undefined });
    expect(fields).toContain('service_start_date');
  });

  test('rejects missing base_rate', () => {
    const { fields } = validate(createBookingSchema, { ...valid, base_rate: undefined });
    expect(fields).toContain('base_rate');
  });

  test('rejects missing patient_name', () => {
    const { fields } = validate(createBookingSchema, { ...valid, patient_name: undefined });
    expect(fields).toContain('patient_name');
  });

  test('rejects invalid date format for service_start_date', () => {
    const { valid: ok } = validate(createBookingSchema, { ...valid, service_start_date: '01-06-2026' });
    expect(ok).toBe(false);
  });
});

// ── Extend Booking ───────────────────────────────────────────────────────────

describe('extendBookingSchema', () => {
  const valid = {
    booking_id: 5,
    from_date: '2026-07-01',
    to_date: '2026-07-31',
  };

  test('accepts valid extend data', () => {
    expect(validate(extendBookingSchema, valid).valid).toBe(true);
  });

  test('rejects missing booking_id', () => {
    const { fields } = validate(extendBookingSchema, { ...valid, booking_id: undefined });
    expect(fields).toContain('booking_id');
  });

  test('rejects missing from_date', () => {
    const { fields } = validate(extendBookingSchema, { ...valid, from_date: undefined });
    expect(fields).toContain('from_date');
  });

  test('rejects missing to_date', () => {
    const { fields } = validate(extendBookingSchema, { ...valid, to_date: undefined });
    expect(fields).toContain('to_date');
  });
});

// ── Final Booking Save (OTP verify) ──────────────────────────────────────────

describe('finalBookingSaveSchema', () => {
  const valid = {
    booking_id: 3,
    otp: '482910',
    hp_unique_id: 7,
  };

  test('accepts valid OTP verification data', () => {
    expect(validate(finalBookingSaveSchema, valid).valid).toBe(true);
  });

  test('rejects 5-digit OTP (must be 6 digits)', () => {
    const { valid: ok } = validate(finalBookingSaveSchema, { ...valid, otp: '12345' });
    expect(ok).toBe(false);
  });

  test('rejects 7-digit OTP', () => {
    const { valid: ok } = validate(finalBookingSaveSchema, { ...valid, otp: '1234567' });
    expect(ok).toBe(false);
  });

  test('rejects missing hp_unique_id', () => {
    const { fields } = validate(finalBookingSaveSchema, { ...valid, hp_unique_id: undefined });
    expect(fields).toContain('hp_unique_id');
  });
});

// ── Create HP Profile ─────────────────────────────────────────────────────────

describe('createHPSchema', () => {
  const valid = {
    hp_reg_first_name: 'Priya',
    hp_reg_last_name: 'Kumar',
    hp_reg_phone_number: '9876543210',
    hp_reg_branch_id: 1,
  };

  test('accepts valid HP profile data', () => {
    expect(validate(createHPSchema, valid).valid).toBe(true);
  });

  test('rejects missing first name', () => {
    const { fields } = validate(createHPSchema, { ...valid, hp_reg_first_name: undefined });
    expect(fields).toContain('hp_reg_first_name');
  });

  test('rejects missing phone number', () => {
    const { fields } = validate(createHPSchema, { ...valid, hp_reg_phone_number: undefined });
    expect(fields).toContain('hp_reg_phone_number');
  });
});

// ── Create Support Ticket ────────────────────────────────────────────────────

describe('createSupportTicketSchema', () => {
  const valid = {
    user_id: 1,
    support_type_id: 2,
    title: 'HP is late',
    description: 'The caregiver has not arrived for the morning shift.',
  };

  test('accepts valid ticket data', () => {
    expect(validate(createSupportTicketSchema, valid).valid).toBe(true);
  });

  test('rejects missing user_id', () => {
    const { fields } = validate(createSupportTicketSchema, { ...valid, user_id: undefined });
    expect(fields).toContain('user_id');
  });

  test('rejects title shorter than 3 chars', () => {
    const { valid: ok } = validate(createSupportTicketSchema, { ...valid, title: 'Hi' });
    expect(ok).toBe(false);
  });

  test('rejects description shorter than 5 chars', () => {
    const { valid: ok } = validate(createSupportTicketSchema, { ...valid, description: 'Bad' });
    expect(ok).toBe(false);
  });

  test('allows optional fields to be empty strings', () => {
    expect(validate(createSupportTicketSchema, { ...valid, comments: '', booking_details: '' }).valid).toBe(true);
  });
});
