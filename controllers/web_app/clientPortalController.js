/**
 * clientPortalController.js — client (customer) self-service endpoints.
 *
 * Identity comes from req.client = { user_id, org_id } (set by clientAuth),
 * NEVER the request body. Every query filters by both, isolating each client
 * to their own data within their organisation.
 */

const db = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');

const DOC_URL = process.env.DOC_FOLDER_URL || '';

const BOOKING_STATUS = db.raw(`
  CASE
    WHEN b.status = 1 THEN 'Booking Submitted'
    WHEN b.status = 2 THEN 'HP Assigned'
    WHEN b.status = 3 THEN 'Booking Cancelled'
    WHEN b.status = 4 THEN 'Service Started'
    WHEN b.status = 5 THEN 'Service On Hold'
    WHEN b.status = 6 THEN 'Service Cancelled'
    WHEN b.status = 7 THEN 'Service Suspended'
    ELSE 'Unknown'
  END AS status_label`);

// ── Profile ──────────────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const me = await db('edx_client_app_users')
      .where({ id: user_id, org_id })
      .first('id', 'user_name', 'phone_number', 'user_email', 'user_gender',
             'user_location', 'user_image', 'status');
    if (!me) return res.status(404).json({ message: 'Profile not found.' });
    if (me.user_image && me.user_image !== 'NA') {
      me.user_image_url = `${DOC_URL}/user_image/${me.user_image}`;
    }
    res.json(me);
  } catch (err) {
    logger.error(`Error client getMe: ${err.message}`);
    res.status(500).json({ message: 'Error fetching profile.' });
  }
};

const updateMe = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const allowed = ['user_name', 'user_email', 'user_location', 'user_gender'];
    const payload = {};
    for (const k of allowed) if (req.body[k] !== undefined) payload[k] = req.body[k];
    if (!Object.keys(payload).length) return res.status(400).json({ message: 'No editable fields supplied.' });
    payload.updated_by = user_id;
    payload.updated_on = getCurrentDateTime();
    await db('edx_client_app_users').where({ id: user_id, org_id }).update(payload);
    res.json({ message: 'Profile updated.', updated_fields: Object.keys(payload) });
  } catch (err) {
    logger.error(`Error client updateMe: ${err.message}`);
    res.status(500).json({ message: 'Error updating profile.' });
  }
};

// ── Bookings ─────────────────────────────────────────────────────────────────
const baseBookingsQuery = (userId, orgId) =>
  db('edx_bookings as b')
    .leftJoin('edx_patient as p', 'p.id', 'b.patient_id')
    .leftJoin('edx_user_address as a', 'a.id', 'b.address_id')
    .leftJoin('edx_master_services as s', 's.id', 'b.service_type_id')
    .where('b.user_id', userId)
    .where('b.org_id', orgId)
    .select(
      'b.id as booking_id', 'b.status', BOOKING_STATUS, 'b.base_rate', 'b.base_unit',
      'b.final_rate', 'b.service_start_date', 'b.service_end_date',
      'b.service_start_time', 'b.service_end_time', 'b.spl_care_requirements', 'b.spl_instructions',
      's.name as service_name',
      'p.id as patient_id', 'p.patient_name', 'p.age as patient_age', 'p.gender as patient_gender',
      'p.phone_number as patient_phone', 'p.relation as patient_relation',
      'a.address_tag_name', 'a.address_line1', 'a.address_line2', 'a.locality',
      'a.landmark', 'a.city', 'a.state', 'a.pincode'
    );

const getBookings = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const filter = String(req.query.filter || 'all').toLowerCase();
    let q = baseBookingsQuery(user_id, org_id);
    if (filter === 'active') q = q.whereIn('b.status', [2, 4, 5]);
    else if (filter === 'completed') q = q.whereIn('b.status', [3, 6]);
    const rows = await q.orderBy('b.id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getBookings: ${err.message}`);
    res.status(500).json({ message: 'Error fetching bookings.' });
  }
};

const getBookingById = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const row = await baseBookingsQuery(user_id, org_id).where('b.id', req.params.id).first();
    if (!row) return res.status(404).json({ message: 'Booking not found.' });
    res.json(row);
  } catch (err) {
    logger.error(`Error client getBookingById: ${err.message}`);
    res.status(500).json({ message: 'Error fetching booking.' });
  }
};

// Confirm a booking belongs to this client (used before exposing HP/attendance).
const ownsBooking = (userId, orgId, bookingId) =>
  db('edx_bookings').where({ id: bookingId, user_id: userId, org_id: orgId }).first('id');

// Assigned caregiver profile + the service-start OTP for an active booking.
const getAssignedHp = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const bookingId = parseInt(req.params.id, 10);
    if (!(await ownsBooking(user_id, org_id, bookingId))) {
      return res.status(403).json({ message: 'Booking not found.' });
    }
    const rows = await db('edx_booking_hp as bh')
      .join('edx_hp_registration as hp', 'hp.hp_reg_id', 'bh.hp_unique_id')
      .where('bh.bkng_id', bookingId).where('bh.org_id', org_id)
      .select(
        'bh.id as assignment_id', 'bh.status as assignment_status',
        'bh.otp', 'bh.otp_verified', 'bh.otp_verification_datetime',
        'bh.reporting_date_planned', 'bh.end_date_planned',
        'bh.service_start_date', 'bh.service_end_date', 'bh.in_time', 'bh.out_time',
        'hp.hp_reg_id', 'hp.hp_reg_first_name', 'hp.hp_reg_last_name', 'hp.hp_reg_gender',
        'hp.hp_reg_phone_number', 'hp.hp_reg_languages', 'hp.hp_reg_experience',
        'hp.hp_reg_education', 'hp.hp_reg_city', 'hp.hp_reg_photo'
      )
      .orderBy('bh.id', 'desc');
    rows.forEach((r) => {
      if (r.hp_reg_photo && r.hp_reg_photo !== 'NA') {
        r.hp_reg_photo_url = `${DOC_URL}/hp_reg_photo/${r.hp_reg_photo}`;
      }
    });
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getAssignedHp: ${err.message}`);
    res.status(500).json({ message: 'Error fetching assigned caregiver.' });
  }
};

// Caregiver attendance over the booking's service period (read-only for client).
const getBookingAttendance = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const bookingId = parseInt(req.params.id, 10);
    if (!(await ownsBooking(user_id, org_id, bookingId))) {
      return res.status(403).json({ message: 'Booking not found.' });
    }
    const eff = 'COALESCE(att_date, from_date)';
    const rows = await db('edx_hp_attendance')
      .where({ booking_id: bookingId, org_id })
      .select('id', 'att_date', 'from_date', 'status', 'shift_type',
              'check_in', 'check_out', 'working_hours')
      .orderByRaw(`${eff} desc`);
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getBookingAttendance: ${err.message}`);
    res.status(500).json({ message: 'Error fetching attendance.' });
  }
};

// ── Patients ─────────────────────────────────────────────────────────────────
const getPatients = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const rows = await db('edx_patient').where({ user_id, org_id })
      .select('id', 'patient_name', 'phone_number', 'email', 'age', 'yob',
              'gender', 'weight', 'languages', 'relation', 'is_stay_alone');
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getPatients: ${err.message}`);
    res.status(500).json({ message: 'Error fetching patients.' });
  }
};

const updatePatient = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const patientId = parseInt(req.params.id, 10);
    const owns = await db('edx_patient').where({ id: patientId, user_id, org_id }).first('id');
    if (!owns) return res.status(403).json({ message: 'Patient not found.' });

    const allowed = ['patient_name', 'phone_number', 'email', 'age', 'weight',
                     'languages', 'relation', 'is_stay_alone'];
    const payload = {};
    for (const k of allowed) if (req.body[k] !== undefined) payload[k] = req.body[k];
    if (!Object.keys(payload).length) return res.status(400).json({ message: 'No editable fields supplied.' });
    payload.updated_by = user_id;
    payload.updated_on = getCurrentDateTime();
    await db('edx_patient').where({ id: patientId, user_id, org_id }).update(payload);
    res.json({ message: 'Patient updated.', updated_fields: Object.keys(payload) });
  } catch (err) {
    logger.error(`Error client updatePatient: ${err.message}`);
    res.status(500).json({ message: 'Error updating patient.' });
  }
};

// ── Support ─────────────────────────────────────────────────────────────────
const clientTicketMarker = (userId) => JSON.stringify({ source: 'client', user_id: userId });

const getSupportCategories = async (req, res) => {
  try {
    let rows = await db('edx_support_category').where({ app_type: 'client' }).select('id', 'name');
    if (!rows.length) rows = await db('edx_support_category').select('id', 'name');
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getSupportCategories: ${err.message}`);
    res.status(500).json({ message: 'Error fetching support categories.' });
  }
};

const createSupport = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const { support_type_id, title, description, booking_details } = req.body;
    if (!title || !description) return res.status(400).json({ message: 'title and description are required.' });
    const [id] = await db('edx_support_requests').insert({
      org_id, user_id,
      support_type_id: support_type_id ? parseInt(support_type_id, 10) : null,
      title, description,
      booking_details: booking_details ? parseInt(booking_details, 10) : null,
      conversionlog_details: clientTicketMarker(user_id),
      created_by: user_id, status: 1, created_on: getCurrentDateTime(),
    });
    res.status(201).json({ message: 'Support ticket created.', id });
  } catch (err) {
    logger.error(`Error client createSupport: ${err.message}`);
    res.status(500).json({ message: 'Error creating support ticket.' });
  }
};

const getSupport = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    // Client's own tickets — exclude caregiver-raised ones that may share a user_id space.
    const rows = await db('edx_support_requests as s')
      .leftJoin('edx_support_category as c', 'c.id', 's.support_type_id')
      .where({ 's.org_id': org_id, 's.user_id': user_id })
      .whereRaw("(s.conversionlog_details IS NULL OR s.conversionlog_details NOT LIKE '%\"source\":\"caregiver\"%')")
      .select('s.id', 's.support_type_id', 's.title', 's.description', 's.comments',
              's.status', 's.created_on', 's.updated_on', 'c.name as category_name')
      .orderBy('s.id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getSupport: ${err.message}`);
    res.status(500).json({ message: 'Error fetching support tickets.' });
  }
};

// ── Accounts (read-only) ───────────────────────────────────────────────────
const getInvoices = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const rows = await db('edx_invoice as i')
      .join('edx_bookings as b', 'b.id', 'i.booking_id')
      .where('b.user_id', user_id).where('i.org_id', org_id)
      .select('i.id', 'i.booking_id', 'i.inv_raised_amnt', 'i.inv_start', 'i.inv_end',
              'i.inv_date', 'i.due_date', 'i.invoice_type')
      .orderBy('i.id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getInvoices: ${err.message}`);
    res.status(500).json({ message: 'Error fetching invoices.' });
  }
};

const getReceipts = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const rows = await db('edx_receipts')
      .where({ user_id, org_id })
      .select('id', 'receipt_number', 'booking_id', 'invoice_id', 'amount', 'total_amount',
              'payment_mode', 'transaction_id', 'receipt_date', 'status', 'receipt_type')
      .orderBy('id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error client getReceipts: ${err.message}`);
    res.status(500).json({ message: 'Error fetching receipts.' });
  }
};

// Outstanding = total invoiced − total received, for this client.
const getOutstanding = async (req, res) => {
  try {
    const { user_id, org_id } = req.client;
    const [{ invoiced }] = await db('edx_invoice as i')
      .join('edx_bookings as b', 'b.id', 'i.booking_id')
      .where('b.user_id', user_id).where('i.org_id', org_id)
      .sum({ invoiced: 'i.inv_raised_amnt' });
    const [{ paid }] = await db('edx_receipts')
      .where({ user_id, org_id })
      .sum({ paid: 'total_amount' });
    const totalInvoiced = Number(invoiced) || 0;
    const totalPaid = Number(paid) || 0;
    res.json({
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
      outstanding: Math.round((totalInvoiced - totalPaid) * 100) / 100,
    });
  } catch (err) {
    logger.error(`Error client getOutstanding: ${err.message}`);
    res.status(500).json({ message: 'Error fetching outstanding.' });
  }
};

module.exports = {
  getMe, updateMe,
  getBookings, getBookingById, getAssignedHp, getBookingAttendance,
  getPatients, updatePatient,
  getSupportCategories, createSupport, getSupport,
  getInvoices, getReceipts, getOutstanding,
};
