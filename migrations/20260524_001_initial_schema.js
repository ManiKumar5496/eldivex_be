/**
 * Migration: 001 — Initial Schema Baseline
 * Creates all tables that already exist in production.
 * Uses hasTable() checks so it is safe to run on an existing database.
 */

exports.up = async function (knex) {

  // ── Authentication & Users ───────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_web_app_users'))) {
    await knex.schema.createTable('edx_web_app_users', (t) => {
      t.increments('id').primary();
      t.string('user_name', 150);
      t.string('user_gender', 20);
      t.string('user_mobile', 20);
      t.string('user_email', 150).unique();
      t.string('user_password', 255);
      t.integer('user_role').unsigned();
      t.integer('user_home_branch').unsigned();
      t.string('user_branch_access', 255);
      t.string('user_image', 255);
      t.tinyint('user_status').defaultTo(1);
      t.integer('created_by').unsigned().nullable();
      t.string('created_on', 30);
      t.integer('updated_by').unsigned().nullable();
      t.string('updated_on', 30);
      // Phase 2 columns (password reset)
      t.string('password_reset_token', 255).nullable();
      t.dateTime('password_reset_expires').nullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_web_emp_roles'))) {
    await knex.schema.createTable('edx_web_emp_roles', (t) => {
      t.increments('id').primary();
      t.string('role_name', 100).notNullable();
      t.text('access_list');
      t.tinyint('status').defaultTo(1);
      t.integer('created_by').unsigned().nullable();
      t.string('created_on', 30);
      t.integer('updated_by').unsigned().nullable();
      t.string('updated_on', 30);
    });
  }

  if (!(await knex.schema.hasTable('edx_web_module'))) {
    await knex.schema.createTable('edx_web_module', (t) => {
      t.increments('id').primary();
      t.string('module_name', 100).notNullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_client_app_users'))) {
    await knex.schema.createTable('edx_client_app_users', (t) => {
      t.increments('id').primary();
      t.string('phone_number', 20).unique();
      t.text('user_token');
      t.tinyint('status').defaultTo(1);
      t.tinyint('is_new_user_flag').defaultTo(1);
      t.string('user_name', 150).nullable();
      t.string('user_email', 150).nullable();
      t.string('user_gender', 20).nullable();
      t.string('user_location', 255).nullable();
      t.string('user_image', 255).nullable();
      t.string('user_service_city', 100).nullable();
      t.string('user_source', 100).nullable();
      t.string('enquired_for', 100).nullable();
      t.string('enquired_for_other', 255).nullable();
      t.string('lead_potential', 50).nullable();
      t.string('created_on', 30);
      t.string('updated_on', 30).nullable();
    });
  }

  // ── Branches & Master Data ───────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_branches'))) {
    await knex.schema.createTable('edx_branches', (t) => {
      t.increments('br_id').primary();
      t.string('br_name', 150).notNullable();
      t.string('br_phone', 20).nullable();
      t.string('br_email', 150).nullable();
      t.text('br_address').nullable();
      t.tinyint('br_status').defaultTo(1);
    });
  }

  if (!(await knex.schema.hasTable('edx_master_languages'))) {
    await knex.schema.createTable('edx_master_languages', (t) => {
      t.increments('id').primary();
      t.string('name', 100).notNullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_master_services_category'))) {
    await knex.schema.createTable('edx_master_services_category', (t) => {
      t.increments('id').primary();
      t.string('name', 150).notNullable();
      t.tinyint('status').defaultTo(1);
    });
  }

  if (!(await knex.schema.hasTable('edx_master_services'))) {
    await knex.schema.createTable('edx_master_services', (t) => {
      t.increments('id').primary();
      t.string('name', 150).notNullable();
      t.tinyint('service_type').defaultTo(1).comment('1=Normal, 2=Premium');
      t.integer('branch_id').unsigned().nullable();
      t.integer('service_category_id').unsigned().nullable();
      t.tinyint('status').defaultTo(1);
    });
  }

  if (!(await knex.schema.hasTable('edx_master_coupons'))) {
    await knex.schema.createTable('edx_master_coupons', (t) => {
      t.increments('coupon_id').primary();
      t.string('coupon_name', 100).notNullable().unique();
      t.decimal('discount_percentage', 5, 2).notNullable();
      t.decimal('discount_upper_limit_value', 10, 2).nullable();
      t.tinyint('status').defaultTo(1);
    });
  }

  if (!(await knex.schema.hasTable('edx_master_banners'))) {
    await knex.schema.createTable('edx_master_banners', (t) => {
      t.increments('banner_id').primary();
      t.string('banner_name', 150).notNullable();
      t.text('banner_description').nullable();
      t.string('banner_photo', 255).nullable();
      t.tinyint('banner_status').defaultTo(1);
      t.integer('created_by').unsigned().nullable();
      t.string('created_on', 30);
      t.integer('updated_by').unsigned().nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  // ── Address ───────────────────────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_user_address'))) {
    await knex.schema.createTable('edx_user_address', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().notNullable();
      t.string('address_tag_name', 100).nullable();
      t.string('country', 100).nullable();
      t.string('state', 100).nullable();
      t.string('city', 100).nullable();
      t.text('address_line1').nullable();
      t.text('address_line2').nullable();
      t.string('landmark', 255).nullable();
      t.string('locality', 255).nullable();
      t.string('pincode', 20).nullable();
      t.tinyint('status').defaultTo(1);
      t.string('created_on', 30);
      t.integer('updated_by').unsigned().nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  // ── HP (Healthcare Provider) Registration ────────────────────────────────

  if (!(await knex.schema.hasTable('edx_hp_registration'))) {
    await knex.schema.createTable('edx_hp_registration', (t) => {
      t.increments('hp_reg_id').primary();
      t.string('hp_reg_first_name', 100).nullable();
      t.string('hp_reg_last_name', 100).nullable();
      t.string('hp_reg_email', 150).nullable();
      t.string('hp_reg_phone_number', 20).nullable();
      t.text('hp_reg_address').nullable();
      t.string('hp_reg_dob', 30).nullable();
      t.string('hp_reg_gender', 20).nullable();
      t.string('hp_reg_city', 100).nullable();
      t.string('hp_reg_state', 100).nullable();
      t.string('hp_reg_pin_code', 20).nullable();
      t.string('hp_reg_emergency_contact_phone', 20).nullable();
      t.string('hp_reg_languages', 255).nullable();
      t.integer('hp_reg_branch_id').unsigned().nullable();
      t.string('hp_reg_marital_status', 50).nullable();
      t.string('hp_reg_experience', 20).nullable();
      t.string('hp_reg_father_name', 150).nullable();
      t.string('hp_reg_father_occupation', 150).nullable();
      t.string('hp_reg_mother_name', 150).nullable();
      t.string('hp_reg_identity_proof_type', 100).nullable();
      t.string('hp_reg_identity_proof_number', 100).nullable();
      t.string('hp_reg_education', 150).nullable();
      t.string('hp_reg_photo', 255).nullable();
      t.string('hp_reg_identity_proof_front_image', 255).nullable();
      t.string('hp_reg_identity_proof_back_image', 255).nullable();
      t.string('hp_reg_education_certificate', 255).nullable();
      t.tinyint('hp_reg_status').defaultTo(1);
      t.integer('created_by').nullable();
      t.string('created_on', 30);
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_hp_rate'))) {
    await knex.schema.createTable('edx_hp_rate', (t) => {
      t.increments('id').primary();
      t.integer('hp_unique_id').unsigned().notNullable();
      t.decimal('livein_pay', 10, 2).nullable();
      t.decimal('liveout_pay', 10, 2).nullable();
      t.decimal('monthly_livein_pay', 10, 2).nullable();
      t.decimal('monthly_liveout_pay', 10, 2).nullable();
      t.string('hp_effect_date', 30).nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
    });
  }

  // ── Bookings & Patients ───────────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_patient'))) {
    await knex.schema.createTable('edx_patient', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().nullable();
      t.string('patient_name', 150).nullable();
      t.string('phone_number', 20).nullable();
      t.string('email', 150).nullable();
      t.string('age', 10).nullable();
      t.string('yob', 10).nullable();
      t.string('weight', 20).nullable();
      t.string('languages', 255).nullable();
      t.string('relation', 100).nullable();
      t.string('gender', 10).nullable();
      t.string('is_stay_alone', 5).nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_bookings'))) {
    await knex.schema.createTable('edx_bookings', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().nullable();
      t.integer('branch_id').unsigned().nullable();
      t.integer('service_type_id').unsigned().nullable();
      t.integer('patient_id').unsigned().nullable();
      t.string('service_start_date', 30).nullable();
      t.string('service_end_date', 30).nullable();
      t.string('service_start_time', 20).nullable();
      t.string('service_end_time', 20).nullable();
      t.integer('address_id').unsigned().nullable();
      t.decimal('base_rate', 10, 2).nullable();
      t.decimal('base_discount_percentage', 5, 2).nullable();
      t.decimal('final_rate', 10, 2).nullable();
      t.string('base_unit', 50).nullable();
      t.integer('hp_manager').unsigned().nullable();
      t.integer('coupon_discount_id').unsigned().nullable();
      t.decimal('coupon_discount_applied_value', 10, 2).nullable();
      t.integer('quantity').nullable();
      t.string('placement_time', 30).nullable();
      t.string('status', 5).defaultTo('1');
      t.text('patient_conditions_others').nullable();
      t.text('spl_care_requirements').nullable();
      t.string('original_booking_date', 30).nullable();
      t.string('updated_booking_date', 30).nullable();
      t.string('hold_start_date', 30).nullable();
      t.string('hold_end_date', 30).nullable();
      t.text('spl_instructions').nullable();
      t.string('landmark', 255).nullable();
      t.string('pending_internal_action', 255).nullable();
      t.string('lead_potential', 50).nullable();
      t.string('followup_date', 30).nullable();
      t.tinyint('created_through_newwebapp').defaultTo(0);
      t.integer('created_by').nullable();
      t.string('created_on', 30);
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_booking_hp'))) {
    await knex.schema.createTable('edx_booking_hp', (t) => {
      t.increments('id').primary();
      t.integer('bkng_id').unsigned().notNullable();
      t.integer('hp_unique_id').unsigned().notNullable();
      t.string('interview_date', 30).nullable();
      t.string('interview_time', 20).nullable();
      t.string('interview_expirydate', 30).nullable();
      t.string('reporting_date_planned', 30).nullable();
      t.string('reporting_date_requested_by_client', 30).nullable();
      t.string('reporting_date_actual', 30).nullable();
      t.string('in_time', 20).nullable();
      t.string('out_time', 20).nullable();
      t.string('end_date_planned', 30).nullable();
      t.string('end_date_actual', 30).nullable();
      t.string('service_start_date', 30).nullable();
      t.string('service_end_date', 30).nullable();
      t.string('otp', 10).nullable();
      t.tinyint('otp_verified').defaultTo(0);
      t.dateTime('otp_verification_datetime').nullable();
      t.tinyint('status').defaultTo(1);
      t.integer('created_by').nullable();
      t.string('created_on', 30);
      t.integer('updated_by').nullable();
      t.string('updated_on', 30).nullable();
    });
  }

  // ── Booking Events ────────────────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_hold_booking'))) {
    await knex.schema.createTable('edx_hold_booking', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('inv_id').unsigned().nullable();
      t.string('from_date', 30).nullable();
      t.string('to_date', 30).nullable();
      t.text('reason').nullable();
      t.integer('hp_id').unsigned().nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
    });
  }

  if (!(await knex.schema.hasTable('edx_extension_booking'))) {
    await knex.schema.createTable('edx_extension_booking', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('inv_id').unsigned().nullable();
      t.string('from_date', 30).nullable();
      t.string('to_date', 30).nullable();
      t.string('from_time', 20).nullable();
      t.string('to_time', 20).nullable();
      t.integer('hp_id').unsigned().nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
    });
  }

  if (!(await knex.schema.hasTable('edx_service_closed'))) {
    await knex.schema.createTable('edx_service_closed', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.string('term_date', 30).nullable();
      t.text('term_reason').nullable();
      t.text('term_remarks').nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
    });
  }

  if (!(await knex.schema.hasTable('edx_hp_attendance'))) {
    await knex.schema.createTable('edx_hp_attendance', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.integer('inv_id').unsigned().nullable();
      t.string('from_date', 30).nullable();
      t.text('att_details').nullable();
      t.integer('hp_id').unsigned().nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
    });
  }

  // ── Billing ───────────────────────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_invoice'))) {
    await knex.schema.createTable('edx_invoice', (t) => {
      t.increments('id').primary();
      t.integer('booking_id').unsigned().notNullable();
      t.decimal('inv_raised_amnt', 12, 2).nullable();
      t.string('inv_start', 30).nullable();
      t.string('inv_end', 30).nullable();
      t.string('inv_date', 30).nullable();
      t.integer('created_by').nullable();
      t.string('created_on', 30);
    });
  }

  // ── Support ───────────────────────────────────────────────────────────────

  if (!(await knex.schema.hasTable('edx_support_category'))) {
    await knex.schema.createTable('edx_support_category', (t) => {
      t.increments('id').primary();
      t.string('name', 150).notNullable();
    });
  }

  if (!(await knex.schema.hasTable('edx_support_requests'))) {
    await knex.schema.createTable('edx_support_requests', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().nullable();
      t.integer('support_type_id').unsigned().nullable();
      t.string('start_date', 30).nullable();
      t.string('end_date', 30).nullable();
      t.string('title', 255).nullable();
      t.text('description').nullable();
      t.text('comments').nullable();
      t.text('conversionlog_details').nullable();
      t.string('created_by_employee', 50).nullable();
      t.text('booking_details').nullable();
      t.tinyint('status').defaultTo(1);
      t.string('created_on', 30);
      t.string('updated_on', 30).nullable();
    });
  }
};

exports.down = async function (knex) {
  // Drop in reverse dependency order
  const tables = [
    'edx_support_requests', 'edx_support_category',
    'edx_invoice', 'edx_hp_attendance', 'edx_service_closed',
    'edx_extension_booking', 'edx_hold_booking', 'edx_booking_hp',
    'edx_bookings', 'edx_patient', 'edx_hp_rate', 'edx_hp_registration',
    'edx_user_address', 'edx_master_banners', 'edx_master_coupons',
    'edx_master_services', 'edx_master_services_category',
    'edx_master_languages', 'edx_branches',
    'edx_client_app_users', 'edx_web_module',
    'edx_web_emp_roles', 'edx_web_app_users'
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
};
