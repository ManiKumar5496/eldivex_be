/**
 * hpPortalController.js — caregiver (HP) self-service endpoints.
 *
 * Every handler reads identity from req.hp = { hp_id, org_id } (set by hpAuth),
 * NEVER from the request body. Every query filters by both hp_id and org_id so a
 * caregiver can only ever touch their own data, within their own organisation.
 */

const db = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');

const DOC_URL = process.env.DOC_FOLDER_URL || '';

// ── Small helpers ──────────────────────────────────────────────────────────────
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

// Stored pay columns can be 'NA' or a decimal string — parse defensively.
const toRate = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Daily payable amount for one attendance row given the caregiver's rates.
// present → full day, half_day → half, absent/leave → 0. Rate keyed by shift.
const dailyAmount = (rate, status, shiftType) => {
  const perDay = shiftType === 'live_in' ? rate.livein_pay : rate.liveout_pay;
  if (status === 'present')  return perDay;
  if (status === 'half_day') return perDay / 2;
  return 0; // absent | leave
};

const ATT_STATUSES = ['present', 'absent', 'half_day', 'leave'];

const _attMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h > 23 || min > 59 ? null : h * 60 + min;
};
const workingHours = (cin, cout) => {
  const a = _attMinutes(cin), b = _attMinutes(cout);
  if (a === null || b === null) return 0;
  let diff = b - a;
  if (diff <= 0) diff += 24 * 60; // overnight (live-in)
  return Math.round((diff / 60) * 100) / 100;
};

// Fetch this caregiver's current rate row (latest by effect date).
const fetchRate = async (hpId, orgId) => {
  const r = await db('edx_hp_rate')
    .where({ hp_unique_id: hpId, org_id: orgId })
    .orderBy('id', 'desc')
    .first('livein_pay', 'liveout_pay', 'monthly_livein_pay', 'monthly_liveout_pay');
  return {
    livein_pay:  toRate(r?.livein_pay),
    liveout_pay: toRate(r?.liveout_pay),
  };
};

// ── Profile ──────────────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const hp = await db('edx_hp_registration as hp')
      .leftJoin('edx_hp_rate as r', function () {
        this.on('r.hp_unique_id', '=', 'hp.hp_reg_id').andOn('r.org_id', '=', 'hp.org_id');
      })
      .where({ 'hp.hp_reg_id': hp_id, 'hp.org_id': org_id })
      .first(
        'hp.hp_reg_id', 'hp.hp_reg_first_name', 'hp.hp_reg_last_name', 'hp.hp_reg_email',
        'hp.hp_reg_phone_number', 'hp.hp_reg_gender', 'hp.hp_reg_dob', 'hp.hp_reg_address',
        'hp.hp_reg_city', 'hp.hp_reg_state', 'hp.hp_reg_pin_code', 'hp.hp_reg_languages',
        'hp.hp_reg_experience', 'hp.hp_reg_education', 'hp.hp_reg_marital_status',
        'hp.hp_reg_emergency_contact_phone', 'hp.hp_reg_status', 'hp.hp_reg_photo',
        'hp.hp_reg_identity_proof_type', 'hp.hp_reg_identity_proof_number',
        'r.livein_pay', 'r.liveout_pay', 'r.monthly_livein_pay', 'r.monthly_liveout_pay'
      );

    if (!hp) return res.status(404).json({ message: 'Profile not found.' });
    if (hp.hp_reg_photo && hp.hp_reg_photo !== 'NA') {
      hp.hp_reg_photo_url = `${DOC_URL}/hp_reg_photo/${hp.hp_reg_photo}`;
    }
    res.json(hp);
  } catch (err) {
    logger.error(`Error hp getMe: ${err.message}`);
    res.status(500).json({ message: 'Error fetching profile.' });
  }
};

// Caregiver may only edit a safe subset — never status, name, pay, or KYC.
const updateMe = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const allowed = [
      'hp_reg_phone_number', 'hp_reg_address', 'hp_reg_city', 'hp_reg_state',
      'hp_reg_pin_code', 'hp_reg_languages', 'hp_reg_emergency_contact_phone',
      'hp_reg_marital_status',
    ];
    const payload = {};
    for (const k of allowed) if (req.body[k] !== undefined) payload[k] = req.body[k];
    if (!Object.keys(payload).length) return res.status(400).json({ message: 'No editable fields supplied.' });

    payload.updated_by = hp_id;
    payload.updated_on = getCurrentDateTime();

    await db('edx_hp_registration').where({ hp_reg_id: hp_id, org_id }).update(payload);
    res.json({ message: 'Profile updated.', updated_fields: Object.keys(payload) });
  } catch (err) {
    logger.error(`Error hp updateMe: ${err.message}`);
    res.status(500).json({ message: 'Error updating profile.' });
  }
};

// ── Bank details ───────────────────────────────────────────────────────────────
const getBank = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const bank = await db('edx_hp_bank_details').where({ hp_id, org_id }).first();
    res.json(bank || null);
  } catch (err) {
    logger.error(`Error hp getBank: ${err.message}`);
    res.status(500).json({ message: 'Error fetching bank details.' });
  }
};

const upsertBank = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const { account_holder_name, account_number, ifsc, bank_name, upi_id } = req.body;
    const now = getCurrentDateTime();

    await db('edx_hp_bank_details')
      .insert({
        org_id, hp_id, account_holder_name, account_number, ifsc, bank_name, upi_id,
        status: 'pending', created_by: hp_id, created_on: now, updated_by: hp_id, updated_on: now,
      })
      .onConflict(['org_id', 'hp_id'])
      .merge({
        account_holder_name, account_number, ifsc, bank_name, upi_id,
        status: 'pending', updated_by: hp_id, updated_on: now,
      });

    res.status(201).json({ message: 'Bank details saved. Pending verification.' });
  } catch (err) {
    logger.error(`Error hp upsertBank: ${err.message}`);
    res.status(500).json({ message: 'Error saving bank details.' });
  }
};

// ── Bookings ─────────────────────────────────────────────────────────────────
const baseBookingsQuery = (hpId, orgId) =>
  db('edx_booking_hp as bh')
    .join('edx_bookings as b', 'b.id', 'bh.bkng_id')
    .leftJoin('edx_patient as p', 'p.id', 'b.patient_id')
    .leftJoin('edx_user_address as a', 'a.id', 'b.address_id')
    .leftJoin('edx_master_services as s', 's.id', 'b.service_type_id')
    .where('bh.hp_unique_id', hpId)
    .where('bh.org_id', orgId)
    .select(
      'b.id as booking_id', 'b.status as booking_status', 'b.base_rate', 'b.base_unit',
      'b.final_rate', 'b.service_start_date', 'b.service_end_date',
      'b.service_start_time', 'b.service_end_time', 'b.spl_care_requirements', 'b.spl_instructions',
      'bh.id as assignment_id', 'bh.in_time', 'bh.out_time', 'bh.status as assignment_status',
      'bh.reporting_date_planned', 'bh.end_date_planned', 'bh.otp_verified',
      's.name as service_name',
      'p.patient_name', 'p.age as patient_age', 'p.gender as patient_gender',
      'a.address_tag_name', 'a.address_line1', 'a.address_line2', 'a.locality',
      'a.landmark', 'a.city', 'a.state', 'a.pincode'
    );

const getBookings = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const filter = String(req.query.filter || 'active').toLowerCase();
    let q = baseBookingsQuery(hp_id, org_id);

    const today = todayStr();
    if (filter === 'active') {
      q = q.whereRaw('DATE(b.service_start_date) <= ?', [today])
           .whereRaw('DATE(b.service_end_date) >= ?', [today]);
    } else if (filter === 'upcoming') {
      q = q.whereRaw('DATE(b.service_start_date) > ?', [today]);
    } else if (filter === 'past') {
      q = q.whereRaw('DATE(b.service_end_date) < ?', [today]);
    }
    const rows = await q.orderBy('b.service_start_date', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error hp getBookings: ${err.message}`);
    res.status(500).json({ message: 'Error fetching bookings.' });
  }
};

const getBookingById = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const row = await baseBookingsQuery(hp_id, org_id).where('b.id', req.params.id).first();
    if (!row) return res.status(404).json({ message: 'Booking not found.' });
    res.json(row);
  } catch (err) {
    logger.error(`Error hp getBookingById: ${err.message}`);
    res.status(500).json({ message: 'Error fetching booking.' });
  }
};

// ── Attendance (view + self check-in/out) ───────────────────────────────────────
const getAttendance = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const { from, to } = req.query;
    const eff = 'COALESCE(att_date, from_date)';
    let q = db('edx_hp_attendance')
      .where({ hp_id, org_id })
      .select('id', 'booking_id', 'att_date', 'from_date', 'status', 'shift_type',
              'check_in', 'check_out', 'working_hours', 'notes')
      .orderByRaw(`${eff} desc`);
    if (from) q = q.whereRaw(`${eff} >= ?`, [from]);
    if (to)   q = q.whereRaw(`${eff} <= ?`, [to]);
    res.json(await q);
  } catch (err) {
    logger.error(`Error hp getAttendance: ${err.message}`);
    res.status(500).json({ message: 'Error fetching attendance.' });
  }
};

// Confirm the caregiver is actually assigned to this booking in this org.
const verifyAssignment = (hpId, orgId, bookingId) =>
  db('edx_booking_hp')
    .where({ hp_unique_id: hpId, org_id: orgId, bkng_id: bookingId })
    .first('id', 'in_time', 'out_time', 'otp', 'otp_verified');

const checkIn = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const bookingId = parseInt(req.body.booking_id, 10);
    const { lat, lng, otp } = req.body;
    if (!bookingId) return res.status(400).json({ message: 'booking_id is required.' });

    const assignment = await verifyAssignment(hp_id, org_id, bookingId);
    if (!assignment) return res.status(403).json({ message: 'You are not assigned to this booking.' });

    // Optional OTP gate: if an OTP is provided it must match the booking OTP.
    if (otp && assignment.otp && String(otp).trim() !== String(assignment.otp).trim()) {
      return res.status(400).json({ message: 'Incorrect verification OTP.' });
    }

    // Shift inferred from the assignment's planned timings.
    const shiftType = assignment.in_time && assignment.out_time ? 'live_out' : 'live_in';
    const date = todayStr();
    const checkInTime = nowTime();
    const now = getCurrentDateTime();
    const geo = { lat: lat ?? null, lng: lng ?? null, source: 'self_checkin' };

    await db('edx_hp_attendance')
      .insert({
        booking_id: bookingId, hp_id, org_id, att_date: date, from_date: date,
        status: 'present', shift_type: shiftType, check_in: checkInTime,
        working_hours: 0, notes: JSON.stringify(geo),
        att_details: JSON.stringify({ check_in: checkInTime, status: 'present', shift_type: shiftType, geo }),
        created_by: hp_id, created_on: now, updated_by: hp_id, updated_on: now,
      })
      .onConflict(['org_id', 'hp_id', 'att_date'])
      .merge({
        booking_id: bookingId, status: 'present', shift_type: shiftType,
        check_in: checkInTime, updated_by: hp_id, updated_on: now,
      });

    res.status(201).json({ message: 'Checked in.', date, check_in: checkInTime, shift_type: shiftType });
  } catch (err) {
    logger.error(`Error hp checkIn: ${err.message}`);
    res.status(500).json({ message: 'Error checking in.' });
  }
};

const checkOut = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const date = todayStr();
    const row = await db('edx_hp_attendance').where({ hp_id, org_id, att_date: date }).first();
    if (!row || !row.check_in) {
      return res.status(400).json({ message: 'No active check-in found for today.' });
    }
    const checkOutTime = nowTime();
    const hours = workingHours(row.check_in, checkOutTime);
    await db('edx_hp_attendance').where({ id: row.id }).update({
      check_out: checkOutTime, working_hours: hours,
      updated_by: hp_id, updated_on: getCurrentDateTime(),
    });
    res.json({ message: 'Checked out.', check_out: checkOutTime, working_hours: hours });
  } catch (err) {
    logger.error(`Error hp checkOut: ${err.message}`);
    res.status(500).json({ message: 'Error checking out.' });
  }
};

// ── Earnings (server-computed) ───────────────────────────────────────────────
const earningsToday = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const date = todayStr();
    const rate = await fetchRate(hp_id, org_id);
    const row = await db('edx_hp_attendance').where({ hp_id, org_id, att_date: date }).first();
    const status = row?.status || null;
    const shift = row?.shift_type || 'live_out';
    const amount = status ? dailyAmount(rate, status, shift) : 0;
    res.json({
      date, status, shift_type: shift,
      check_in: row?.check_in || null, check_out: row?.check_out || null,
      working_hours: row?.working_hours || 0, amount,
    });
  } catch (err) {
    logger.error(`Error hp earningsToday: ${err.message}`);
    res.status(500).json({ message: 'Error fetching today\'s earnings.' });
  }
};

const earningsSummary = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'from and to dates are required.' });

    const rate = await fetchRate(hp_id, org_id);
    const eff = 'COALESCE(att_date, from_date)';
    const rows = await db('edx_hp_attendance')
      .where({ hp_id, org_id })
      .whereRaw(`${eff} >= ?`, [from]).whereRaw(`${eff} <= ?`, [to])
      .select('att_date', 'from_date', 'status', 'shift_type', 'working_hours');

    let total = 0;
    const counts = { present: 0, half_day: 0, absent: 0, leave: 0 };
    const days = rows.map((r) => {
      const amt = dailyAmount(rate, r.status, r.shift_type || 'live_out');
      if (counts[r.status] !== undefined) counts[r.status]++;
      total += amt;
      return { date: r.att_date || r.from_date, status: r.status, shift_type: r.shift_type, amount: amt };
    });
    res.json({ from, to, rate, counts, total_amount: Math.round(total * 100) / 100, days });
  } catch (err) {
    logger.error(`Error hp earningsSummary: ${err.message}`);
    res.status(500).json({ message: 'Error fetching earnings summary.' });
  }
};

// ── Payouts / payslips ─────────────────────────────────────────────────────────
const getPayouts = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const rows = await db('edx_hp_payouts')
      .where({ hp_unique_id: hp_id, org_id })
      .select('id', 'booking_id', 'period_from', 'period_to', 'pay_amount',
              'payment_mode', 'status', 'payment_date', 'created_on')
      .orderBy('id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error hp getPayouts: ${err.message}`);
    res.status(500).json({ message: 'Error fetching payouts.' });
  }
};

// Payslip = payout record + attendance breakdown for the period.
const getPayoutById = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const payout = await db('edx_hp_payouts')
      .where({ id: req.params.id, hp_unique_id: hp_id, org_id })
      .first();
    if (!payout) return res.status(404).json({ message: 'Payslip not found.' });

    let breakdown = [];
    if (payout.period_from && payout.period_to) {
      const rate = await fetchRate(hp_id, org_id);
      const eff = 'COALESCE(att_date, from_date)';
      const rows = await db('edx_hp_attendance')
        .where({ hp_id, org_id })
        .whereRaw(`${eff} >= ?`, [payout.period_from])
        .whereRaw(`${eff} <= ?`, [payout.period_to])
        .select('att_date', 'from_date', 'status', 'shift_type', 'working_hours');
      breakdown = rows.map((r) => ({
        date: r.att_date || r.from_date, status: r.status, shift_type: r.shift_type,
        working_hours: r.working_hours, amount: dailyAmount(rate, r.status, r.shift_type || 'live_out'),
      }));
    }
    res.json({ ...payout, breakdown });
  } catch (err) {
    logger.error(`Error hp getPayoutById: ${err.message}`);
    res.status(500).json({ message: 'Error fetching payslip.' });
  }
};

// ── Support tickets ──────────────────────────────────────────────────────────
// Tags a ticket as caregiver-raised. Used both to write and to filter, so a
// caregiver only ever sees their own tickets.
const hpTicketMarker = (hpId) => JSON.stringify({ source: 'caregiver', hp_id: hpId });

const getSupportCategories = async (req, res) => {
  try {
    // app_type 'hp' categories if present; fall back to all when none tagged.
    let rows = await db('edx_support_category').where({ app_type: 'hp' }).select('id', 'name');
    if (!rows.length) rows = await db('edx_support_category').select('id', 'name');
    res.json(rows);
  } catch (err) {
    logger.error(`Error hp getSupportCategories: ${err.message}`);
    res.status(500).json({ message: 'Error fetching support categories.' });
  }
};

const createSupport = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const { support_type_id, title, description, booking_details } = req.body;
    if (!title || !description) return res.status(400).json({ message: 'title and description are required.' });

    // The table has no string "source" column (most are int FKs), so caregiver
    // tickets are tagged with a JSON marker in conversionlog_details and scoped
    // by user_id = hp_id. support_type_id / booking_details are int → null when absent.
    const [id] = await db('edx_support_requests').insert({
      org_id, user_id: hp_id,
      support_type_id: support_type_id ? parseInt(support_type_id, 10) : null,
      title, description,
      booking_details: booking_details ? parseInt(booking_details, 10) : null,
      conversionlog_details: hpTicketMarker(hp_id),
      created_by: hp_id,
      status: 1, created_on: getCurrentDateTime(),
    });
    res.status(201).json({ message: 'Support ticket created.', id });
  } catch (err) {
    logger.error(`Error hp createSupport: ${err.message}`);
    res.status(500).json({ message: 'Error creating support ticket.' });
  }
};

const getSupport = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const rows = await db('edx_support_requests as s')
      .leftJoin('edx_support_category as c', 'c.id', 's.support_type_id')
      .where({ 's.org_id': org_id, 's.user_id': hp_id })
      .where('s.conversionlog_details', hpTicketMarker(hp_id))
      .select('s.id', 's.support_type_id', 's.title', 's.description', 's.comments',
              's.status', 's.created_on', 's.updated_on', 'c.name as category_name')
      .orderBy('s.id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error hp getSupport: ${err.message}`);
    res.status(500).json({ message: 'Error fetching support tickets.' });
  }
};

// ── Leave ────────────────────────────────────────────────────────────────────
const requestLeave = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const { from_date, to_date, reason } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ message: 'from_date and to_date are required.' });
    const [id] = await db('edx_hp_leave').insert({
      org_id, hp_id, from_date, to_date, reason: reason || null,
      status: 'Pending', created_on: getCurrentDateTime(),
    });
    res.status(201).json({ message: 'Leave request submitted.', id });
  } catch (err) {
    logger.error(`Error hp requestLeave: ${err.message}`);
    res.status(500).json({ message: 'Error submitting leave request.' });
  }
};

const getLeave = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const rows = await db('edx_hp_leave').where({ hp_id, org_id }).orderBy('id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error hp getLeave: ${err.message}`);
    res.status(500).json({ message: 'Error fetching leave.' });
  }
};

// ── Notifications (polling; FCM later) ──────────────────────────────────────────
const getNotifications = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    const rows = await db('edx_hp_notifications')
      .where({ hp_id, org_id }).orderBy('id', 'desc').limit(50);
    res.json(rows);
  } catch (err) {
    logger.error(`Error hp getNotifications: ${err.message}`);
    res.status(500).json({ message: 'Error fetching notifications.' });
  }
};

const markNotificationRead = async (req, res) => {
  try {
    const { hp_id, org_id } = req.hp;
    await db('edx_hp_notifications')
      .where({ id: req.params.id, hp_id, org_id }).update({ read_flag: 1 });
    res.json({ message: 'Marked read.' });
  } catch (err) {
    logger.error(`Error hp markNotificationRead: ${err.message}`);
    res.status(500).json({ message: 'Error updating notification.' });
  }
};

module.exports = {
  getMe, updateMe,
  getBank, upsertBank,
  getBookings, getBookingById,
  getAttendance, checkIn, checkOut,
  earningsToday, earningsSummary,
  getPayouts, getPayoutById,
  getSupportCategories, createSupport, getSupport,
  requestLeave, getLeave,
  getNotifications, markNotificationRead,
};
