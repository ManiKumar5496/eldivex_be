const getBookings = require('../../models/web_app/bookingsModel');
const db = require('../../config/db');
const logger = require('../../logger');
require('dotenv').config();
const { getCurrentDateTime, mysqlDateAddDays } = require("../../utils/dateTime");
const withTransaction = require('../../utils/withTransaction');
const { sendEmail } = require('../../utils/emailService');
const { bookingConfirmed, otpDelivery, invoiceEmail, creditNoteGenerated, cancellationBillingSummary } = require('../../utils/emailTemplates');
const { getOrgBrand } = require('../../utils/orgBrand');
const { sendOTP } = require('../../utils/smsService');
const { logAudit } = require('../../utils/auditLogger'); // Phase 4.2
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope'); // Phase 5
const { notifyOrgAdmins } = require('../../utils/notify');
const { getClientContact } = require('../../utils/clientContact');
const { checkPlanLimit } = require('../../utils/planUsage');
const { ENGAGED_BOOKING_STATUSES } = require('../../utils/bookingStatus');
const { computeCancellationSettlement, parseLocalDate, formatLocalDate } = require('../../utils/accountsCalc');
const { guardOrgHandlers } = require('../../utils/requestOrg');
const crypto = require('crypto');

// ── Accounts event helpers ────────────────────────────────────────────────────

/**
 * Auto-create a credit note when a booking is put on hold.
 * Credit = hold_days × daily_rate (preliminary — confirmed when hold is lifted).
 */
async function _createHoldCreditNote({ booking_id, from_date, to_date, inv_id, org_id, created_by }) {
  try {
    if (org_id == null) return;
    const booking = await db('edx_bookings').where({ id: booking_id, org_id }).first();
    if (!booking) return;

    const finalRate = parseFloat(booking.final_rate) || 0;
    let holdDays = 0;
    if (from_date && to_date) {
      const s = new Date(from_date);
      const e = new Date(to_date);
      holdDays = s <= e ? Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1 : 0;
    }
    const creditAmount = holdDays * finalRate;
    if (creditAmount <= 0) return;

    await db('edx_credit_notes').insert({
      booking_id,
      invoice_id:  inv_id    || null,
      credit_type: 'Hold',
      amount:      creditAmount,
      reason:      `Service on hold from ${from_date} to ${to_date} (${holdDays} day(s) × ₹${finalRate}/day)`,
      status:      'Pending',
      credit_date: from_date || getCurrentDateTime(),
      org_id,
      created_by,
      created_on:  getCurrentDateTime(),
    });

    // Log rate history if rate changed recently (no-op here, but hook is in place)
    logger.info(`[accounts] Hold credit note created for booking #${booking_id} — ₹${creditAmount}`);
  } catch (err) {
    logger.warn(`[accounts] _createHoldCreditNote failed: ${err.message}`);
  }
}

/**
 * Log a rate change to edx_rate_history when booking rates are updated.
 */
/**
 * Returns the label of the first referenced record that does not exist in
 * `orgId` (and, for the address, does not belong to the client), or null when
 * every supplied id is valid. Empty / 'NA' ids are skipped.
 */
async function _findForeignBookingRefs(orgId, { user_id, address_id, branch_id, service_type_id }) {
  const has = (v) => v !== undefined && v !== null && v !== '' && v !== 'NA';
  if (has(user_id)) {
    const client = await db('edx_client_app_users').where({ id: user_id, org_id: orgId }).first('id');
    if (!client) return 'Client';
  }
  if (has(address_id)) {
    const q = db('edx_user_address').where({ id: address_id, org_id: orgId });
    if (has(user_id)) q.where('user_id', user_id);
    if (!(await q.first('id'))) return 'Address';
  }
  if (has(branch_id)) {
    const branch = await db('edx_branches').where({ br_id: branch_id, org_id: orgId }).first('br_id');
    if (!branch) return 'Branch';
  }
  if (has(service_type_id)) {
    const service = await db('edx_master_services').where({ id: service_type_id, org_id: orgId }).first('id');
    if (!service) return 'Service';
  }
  return null;
}

async function _logRateChange({ booking_id, old_rate, new_rate, effective_date, changed_by, org_id, reason }) {
  try {
    if (old_rate === new_rate) return;
    await db('edx_rate_history').insert({
      booking_id,
      old_rate:       parseFloat(old_rate)  || 0,
      new_rate:       parseFloat(new_rate)  || 0,
      effective_date: effective_date || getCurrentDateTime(),
      reason:         reason || 'Rate updated via booking update',
      org_id,
      changed_by,
      changed_on: getCurrentDateTime(),
    });
    logger.info(`[accounts] Rate change logged for booking #${booking_id}: ${old_rate} → ${new_rate}`);
  } catch (err) {
    logger.warn(`[accounts] _logRateChange failed: ${err.message}`);
  }
}


const createBooking = async (req, res) => {
    try {
      const {
        branch_id ,
        user_id,
        service_start_date,
        service_end_date,
        service_start_time,
        service_end_time,
        patient_name,
        phone_number,
        email,
        age,
        yob,
        weight,
        languages,
        relation,
        gender,
        is_stay_alone,
        address_id,
        service_type_id,
        base_rate,
        base_discount_percentage,
        patient_conditions_others,
        spl_care_requirements,
        placement_time,
      } = req.body;
      const userId = req.login_data.id;

      // A booking must carry a usable positive rate, otherwise the invoice
      // raised at OTP verification would be ₹0. base_rate is stored as the
      // string 'NA' when omitted, so parseFloat would yield NaN.
      const parsedBaseRate = parseFloat(base_rate);
      if (!Number.isFinite(parsedBaseRate) || parsedBaseRate <= 0) {
        return res.status(400).json({
          message: 'A valid base_rate (greater than 0) is required to create a booking.',
        });
      }

      // Every referenced id must belong to the caller's org (and the address to
      // the client) — otherwise a booking could point at another tenant's data.
      const orgId = getOrgId(req);
      const notFound = await _findForeignBookingRefs(orgId, { user_id, address_id, branch_id, service_type_id });
      if (notFound) return res.status(404).json({ message: `${notFound} not found.` });

      const limit = await checkPlanLimit(orgId, 'booking');
      if (limit) return res.status(403).json(limit);

      let booking_id;
      await withTransaction(async (trx) => {
        const [patient_id] = await trx('edx_patient').insert(withOrg(req, {
          user_id: user_id || 'NA',
          patient_name: patient_name || 'NA',
          phone_number: phone_number || 'NA',
          email: email || 'NA',
          age: age || 'NA',
          yob: yob || 'NA',
          weight: weight || 'NA',
          languages: languages || 'NA',
          relation: relation || 'NA',
          gender: gender || 'NA',
          is_stay_alone: is_stay_alone || 'NA',
          created_by: userId,
          created_on: getCurrentDateTime()
        }));

        [booking_id] = await trx('edx_bookings').insert(withOrg(req, {
          user_id: user_id || 'NA',
          service_type_id: service_type_id || 'NA',
          branch_id: branch_id || 'NA',
          patient_id: patient_id || 'NA',
          service_start_date: service_start_date || 'NA',
          service_end_date: service_end_date || 'NA',
          service_start_time: service_start_time || 'NA',
          service_end_time: service_end_time || 'NA',
          address_id: address_id || 'NA',
          base_rate: parsedBaseRate,
          base_discount_percentage: base_discount_percentage ?? null,
          patient_conditions_others: patient_conditions_others || null,
          spl_care_requirements: spl_care_requirements || null,
          placement_time: placement_time || null,
          created_by: userId,
          created_on: getCurrentDateTime()
        }));
      });

      res.status(201).json({ booking_id, message: 'Booking created successfully.' });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
      logAudit({
        entityType: 'BOOKING',
        entityId:   booking_id,
        action:     'CREATE',
        changedBy:  userId,
        org_id:     orgId,
        newValues:  { booking_id, branch_id, service_type_id, user_id },
      });

      notifyOrgAdmins(orgId, {
        type:  'booking',
        title: `New booking created — #${booking_id}`,
        body:  `Booking for ${patient_name || 'patient'} from ${service_start_date || '—'} to ${service_end_date || '—'}.`,
        data:  { booking_id, route: 'bookings' },
      });

      // ── Send booking confirmation email (non-blocking) ──────────────────────
      setImmediate(async () => {
        try {
          // bookings.user_id is a CLIENT id → edx_client_app_users.
          const user = await getClientContact(user_id, orgId);
          if (user && user.user_email) {
            const serviceRow = await db('edx_master_services')
              .where({ id: service_type_id, org_id: orgId })
              .select('name')
              .first();
            const tpl = bookingConfirmed({
              clientName:  user.user_name || 'Client',
              patientName: patient_name  || 'Patient',
              serviceType: serviceRow?.name || 'Elder Care Service',
              startDate:   service_start_date || '—',
              endDate:     service_end_date   || '—',
              bookingId:   booking_id,
            });
            await sendEmail({ to: user.user_email, ...tpl });
          }
        } catch (emailErr) {
          logger.warn(`[email] Booking confirmed email failed for booking #${booking_id}: ${emailErr.message}`);
        }
      });

    } catch (err) {
      logger.error(`Error creating Booking: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error creating Booking.' });
    }
  };

  const updatePatient = async (req, res) => {
    try {
      const { patient_id } = req.body;
      const userId = req.login_data.id;
      if (!patient_id) return res.status(400).json({ message: 'patient_id is required.' });

      // Only fields with a value are written; omitted or blank fields keep
      // their stored value (previously they were overwritten with 'NA').
      const editable = ['patient_name', 'phone_number', 'email', 'age', 'yob', 'weight',
        'languages', 'relation', 'gender', 'is_stay_alone'];
      const payload = {};
      for (const k of editable) {
        const v = req.body[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') payload[k] = v;
      }
      if (!Object.keys(payload).length) return res.status(400).json({ message: 'No patient fields supplied.' });
      payload.updated_by = userId;
      payload.updated_on = getCurrentDateTime();

      const updated = await db('edx_patient')
        .where({ id: patient_id, org_id: getOrgId(req) })
        .update(payload);
      if (!updated) return res.status(404).json({ message: 'Patient not found.' });

      res.status(201).json({ message: 'Patient updated successfully.' });
    } catch (err) {
      logger.error(`Error update patient: ${err.message}`);
      res.status(500).json({ message: 'Error update Booking.' });
    }
  };


  const updateBooking = async (req, res) => {
    try {
  
      const bookingId = req.body.booking_id || req.body.id;
      
  
      if (!bookingId) {
        return res.status(400).json({ message: "booking_id is required" });
      }
  
      // 1️⃣ get existing booking
      const existingBooking = await db('edx_bookings')
        .where({ id: bookingId, org_id: getOrgId(req) })
        .first();

      if (!existingBooking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      const {
        service_type_id,
        branch_id,
        user_id,
        patient_id,
        hp_manager,
        coupon_discount_id,
        coupon_discount_applied_value,
        address_id,
        patient_conditions_others,
        spl_care_requirements,
        original_booking_date,
        updated_booking_date,
        base_rate,
        base_unit,
        base_discount_percentage,
        final_rate,
        quantity,
        service_start_date,
        service_end_date,
        service_start_time,
        service_end_time,
        placement_time,
        hold_start_date,
        hold_end_date,
        spl_instructions,
        landmark,
        pending_internal_action,
        lead_potential,
        followup_date,
        created_through_newwebapp,
        status
      } = req.body;

      // 2️⃣ Build dynamic payload
      const updatePayload = {};

      const fields = {
        service_type_id,
        branch_id,
        user_id,
        patient_id,
        hp_manager,
        coupon_discount_id,
        coupon_discount_applied_value,
        address_id,
        patient_conditions_others,
        spl_care_requirements,
        original_booking_date,
        updated_booking_date,
        base_rate,
        base_unit,
        base_discount_percentage,
        final_rate,
        quantity,
        service_start_date,
        service_end_date,
        service_start_time,
        service_end_time,
        placement_time,
        hold_start_date,
        hold_end_date,
        spl_instructions,
        landmark,
        pending_internal_action,
        lead_potential,
        followup_date,
        created_through_newwebapp,
        status
      };

      // Decimal/numeric columns — MySQL DECIMAL rejects empty string ''.
      // Convert '' → null so the update never sends an invalid value.
      const decimalFields = new Set([
        'base_rate', 'final_rate', 'coupon_discount_applied_value',
        'base_discount_percentage', 'quantity',
      ]);
      // DATE columns — MySQL DATE rejects empty string ''.
      const dateFields = new Set([
        'followup_date', 'hold_start_date', 'hold_end_date',
        'service_start_date', 'service_end_date',
      ]);

      // update only provided values
      Object.keys(fields).forEach(key => {
        if (fields[key] !== undefined) {
          const val = fields[key];
          updatePayload[key] = ((decimalFields.has(key) || dateFields.has(key)) && val === '') ? null : val;
        }
      });

      // Rate fields, when supplied, must be valid positive numbers so the
      // invoice raised at OTP verification is never ₹0.
      for (const rateField of ['base_rate', 'final_rate']) {
        if (updatePayload[rateField] !== undefined && updatePayload[rateField] !== null) {
          const parsed = parseFloat(updatePayload[rateField]);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return res.status(400).json({
              message: `${rateField} must be a number greater than 0.`,
            });
          }
        }
      }

      // audit fields
      updatePayload.updated_on = getCurrentDateTime();
      updatePayload.updated_by = req.login_data?.id || null;

      // 3️⃣ perform update
      if (Object.keys(updatePayload).length > 0) {
        await db('edx_bookings')
          .where({ id: bookingId, org_id: getOrgId(req) })
          .update(updatePayload);
      }

      res.status(200).json({
        message: "Booking updated successfully",
        updated_fields: Object.keys(updatePayload)
      });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
      logAudit({
        entityType: 'BOOKING',
        entityId:   bookingId,
        action:     'UPDATE',
        changedBy:  req.login_data?.id,
        org_id:     getOrgId(req),
        oldValues:  { status: existingBooking.status },
        newValues:  updatePayload,
      });

      // ── Log rate change if final_rate changed (fire-and-forget) ─────────────
      // Compare numerically: existing final_rate is a DECIMAL string ("1500.00")
      // while the incoming value may be a number or "1500", so a raw !== compare
      // would log a spurious change on every save.
      if (
        final_rate !== undefined &&
        (parseFloat(existingBooking.final_rate) || 0) !== (parseFloat(final_rate) || 0)
      ) {
        setImmediate(() => _logRateChange({
          booking_id:    bookingId,
          old_rate:      existingBooking.final_rate,
          new_rate:      final_rate,
          effective_date: updatePayload.service_start_date || getCurrentDateTime(),
          changed_by:    req.login_data?.id,
          org_id:        getOrgId(req),
          reason:        'Rate updated via booking edit',
        }));
      }

    } catch (err) {
      logger.error(`Error update Booking: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: "Error update Booking." });
    }
  };
  const updateHPBooking = async (req, res) => {
    try {
  
      const bookingId = req.body.booking_id || req.body.id;
      const hp_unique_id = req.body.hp_unique_id || req.body.hp_id;
  
      if (!bookingId) {
        return res.status(400).json({ message: "booking_id is required" });
      }
  
      // 1️⃣ get existing booking
      const existingBooking = await db('edx_booking_hp')
        .where({ bkng_id: bookingId, hp_unique_id: hp_unique_id, org_id: getOrgId(req) })
        .first();
  
      if (!existingBooking) {
        return res.status(404).json({ message: "Booking not found" });
      }
  
      const {
        interview_date,
        interview_time,
        interview_expirydate,
        reporting_date_planned,
        end_date_planned,
        reporting_date_requested_by_client,
        in_time,
        out_time,
        reporting_date_actual,
        end_date_actual,
        status
      } = req.body;

      // 2️⃣ Build dynamic payload
      const updatePayload = {};

      const fields = {
        interview_date,
        interview_time,
        interview_expirydate,
        reporting_date_planned,
        end_date_planned,
        reporting_date_requested_by_client,
        in_time,
        out_time,
        reporting_date_actual,
        end_date_actual,
        status 
      };
  
      // update only provided values
      Object.keys(fields).forEach(key => {
        if (fields[key] !== undefined) {
          updatePayload[key] = fields[key];
        }
      });
      // ✅ Generate OTP when status = 3
if (status == 3) {
  const otp = String(crypto.randomInt(100000, 1000000));
  updatePayload.otp = otp;

  // ── Send OTP to HP via email (non-blocking) ─────────────────────────────
  setImmediate(async () => {
    try {
      const hp = await db('edx_hp_registration')
        .where({ hp_reg_id: hp_unique_id, org_id: getOrgId(req) })
        .select('hp_reg_email', 'hp_reg_first_name', 'hp_reg_last_name', 'hp_reg_phone_number')
        .first();

      const patientRow = await db('edx_bookings')
        .leftJoin('edx_patient', 'edx_bookings.patient_id', 'edx_patient.id')
        .where({ 'edx_bookings.id': bookingId, 'edx_bookings.org_id': getOrgId(req) })
        .select('edx_patient.patient_name')
        .first();

      const hpName = [hp?.hp_reg_first_name, hp?.hp_reg_last_name].filter(Boolean).join(' ') || 'Caregiver';

      // Send OTP email
      if (hp && hp.hp_reg_email && hp.hp_reg_email !== 'NA') {
        const tpl = otpDelivery({
          hpName,
          otp,
          patientName: patientRow?.patient_name || 'Patient',
          bookingId,
        });
        await sendEmail({ to: hp.hp_reg_email, ...tpl });
      }

      // Send OTP SMS
      if (hp && hp.hp_reg_phone_number && hp.hp_reg_phone_number !== 'NA') {
        await sendOTP(hp.hp_reg_phone_number, otp);
      }
    } catch (emailErr) {
      logger.warn(`[email/sms] OTP delivery failed for booking #${bookingId}: ${emailErr.message}`);
    }
  });
}
else if (status == 1 || status == 2 || status == 3 ) {
  await db('edx_hp_registration')
      .where({ hp_reg_id: hp_unique_id })
      .where('org_id', getOrgId(req))
      .update({
        hp_reg_status:6,
        updated_on:db.fn.now(),
        updated_by:req.login_data?.id || null
      });
}
else if (status == 4) {
  await db('edx_hp_registration')
      .where({ hp_reg_id: hp_unique_id })
      .where('org_id', getOrgId(req))
      .update({
        hp_reg_status:5,
        updated_on:db.fn.now(),
        updated_by:req.login_data?.id || null
      });
}
else if (status == 5) {
  await db('edx_hp_registration')
      .where({ hp_reg_id: hp_unique_id })
      .where('org_id', getOrgId(req))
      .update({
        hp_reg_status:1,
        updated_on:db.fn.now(),
        updated_by:req.login_data?.id || null
      });
}
      // audit fields
      updatePayload.updated_on = getCurrentDateTime();
      updatePayload.updated_by = req.login_data?.id || null;
  
      // 3️⃣ perform update
      if (Object.keys(updatePayload).length > 0) {
        await db('edx_booking_hp')
          .where({ bkng_id: bookingId, hp_unique_id: hp_unique_id, org_id: getOrgId(req) })
          .update(updatePayload);
      }

      res.status(200).json({
        message: "Booking HP updated successfully",
        updated_fields: Object.keys(updatePayload)
      });
  
    } catch (err) {
      logger.error(`Error update Booking HP: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: "Error update Booking HP." });
    }
  };
  const holdBooking = async (req, res) => {
    try {
      const {
        booking_id,
        inv_id,
        from_date,
        to_date,
        reason,
        hp_id,
      
        
      } = req.body;
      const userId = req.login_data.id;
      const orgId = getOrgId(req);

      const holdTarget = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first('id', 'user_id', 'final_rate');
      if (!holdTarget) return res.status(404).json({ message: 'Booking not found.' });

      await withTransaction(async (trx) => {
        await trx('edx_hold_booking').insert(withOrg(req, {
          booking_id: booking_id || 'NA',
          inv_id: inv_id || 'NA',
          from_date: from_date || 'NA',
          to_date: to_date || 'NA',
          reason: reason || 'NA',
          hp_id: hp_id || 'NA',
          created_on: getCurrentDateTime(),
          created_by: userId
        }));

        await trx('edx_bookings')
          .where({ id: booking_id, org_id: getOrgId(req) })
          .update({
            status: '5',
            updated_on: db.fn.now(),
            updated_by: userId
          });
      });

      res.status(201).json({ message: 'Hold Booking created successfully.' });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
      logAudit({
        entityType: 'BOOKING',
        entityId:   booking_id,
        action:     'STATUS_CHANGE',
        changedBy:  userId,
        org_id:     getOrgId(req),
        newValues:  { status: 'HOLD', from_date, to_date, reason },
      });

      // ── Auto-create hold credit note (fire-and-forget) ──────────────────────
      setImmediate(() => _createHoldCreditNote({
        booking_id,
        from_date,
        to_date,
        inv_id:     inv_id || null,
        org_id:     getOrgId(req),
        created_by: userId,
      }));

      // ── Notify client of service hold (fire-and-forget) ─────────────────────
      setImmediate(async () => {
        try {
          // bookings.user_id is a CLIENT id → edx_client_app_users.
          const booking = await getClientContact(holdTarget.user_id, orgId);
          if (booking && booking.user_email) {
            const finalRate = parseFloat(holdTarget.final_rate) || 0;
            let holdDays = 0;
            if (from_date && to_date) {
              const s = new Date(from_date);
              const e = new Date(to_date);
              holdDays = s <= e ? Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1 : 0;
            }
            const creditAmount = holdDays * finalRate;
            const tpl = creditNoteGenerated({
              clientName:  booking.user_name || 'Client',
              creditType:  'Hold',
              amount:      creditAmount,
              bookingId:   booking_id,
              noteId:      0,
              reason:      reason || 'Service on hold',
            });
            await sendEmail({ to: booking.user_email, ...tpl });
          }
        } catch (emailErr) {
          logger.warn(`[email] Hold credit note email failed for booking #${booking_id}: ${emailErr.message}`);
        }
      });

    } catch (err) {
      logger.error(`Error creating Hold Booking: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error creating Booking Hold.' });
    }
  };
  const assignHPToBooking = async (req, res) => {
    try {
  
      if (!req.body) {
        return res.status(400).json({
          message: "Request body is missing",
        });
      }
  
      const { booking_id, hp_id } = req.body;
      const userId = req.login_data?.id;
  
      if (!booking_id || !hp_id) {
        return res.status(400).json({
          message: "booking_id and hp_id are required",
        });
      }
  
      const orgId = getOrgId(req);
      const [targetBooking, targetHp] = await Promise.all([
        db('edx_bookings').where({ id: booking_id, org_id: orgId }).first('id'),
        db('edx_hp_registration').where({ hp_reg_id: hp_id, org_id: orgId }).first('hp_reg_id'),
      ]);
      if (!targetBooking) return res.status(404).json({ status: false, message: 'Booking not found.' });
      if (!targetHp) return res.status(404).json({ status: false, message: 'HP not found.' });

      await withTransaction(async (trx) => {
        await trx('edx_booking_hp').insert(withOrg(req, {
          bkng_id: Number(booking_id),
          hp_unique_id: Number(hp_id),
          created_on: getCurrentDateTime(),
          created_by: userId,
        }));

        await trx('edx_bookings')
          .where({ id: booking_id, org_id: getOrgId(req) })
          .update({
            status: '2',
            updated_on: db.fn.now(),
            updated_by: userId
          });
      });

      res.status(201).json({
        status: true,
        message: 'HP assigned successfully',
      });
  
    } catch (err) {
      logger.error(`assignHPToBooking Error: ${err.message}`);
      console.error(err);
  
      res.status(500).json({
        status: false,
        message: "Internal server error",
      });
    }
  };
  // ── Attendance helpers ──────────────────────────────────────────────────────
  const ATT_STATUSES = ['present', 'absent', 'half_day', 'leave'];
  const ATT_SHIFTS   = ['live_in', 'live_out'];

  const _attMinutes = (hhmm) => {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
    if (!m) return null;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };

  // Working hours are computed server-side (never trust the client). An out-time
  // at or before the in-time is treated as an overnight (live-in) shift.
  const _attWorkingHours = (checkIn, checkOut) => {
    const a = _attMinutes(checkIn), b = _attMinutes(checkOut);
    if (a === null || b === null) return 0;
    let diff = b - a;
    if (diff <= 0) diff += 24 * 60;
    return Math.round((diff / 60) * 100) / 100;
  };

  /**
   * Validates one attendance record and returns either { error } or
   * { row, bookingId }. Accepts explicit fields or a legacy att_details blob,
   * and dual-writes att_details for backward compatibility.
   */
  const _buildAttendanceRow = (rec, orgId) => {
    const bookingId = parseInt(rec.booking_id, 10);
    const hpId      = parseInt(rec.hp_id, 10);
    const invRaw    = rec.inv_id ? parseInt(rec.inv_id, 10) : null;
    const invId     = invRaw && invRaw > 0 ? invRaw : null;

    let det = {};
    if (rec.att_details) {
      try { det = typeof rec.att_details === 'string' ? JSON.parse(rec.att_details) : rec.att_details; }
      catch (_) { det = {}; }
    }

    const status    = (rec.status     || det.status     || '').toString().trim();
    const shiftType = (rec.shift_type || det.shift_type || 'live_out').toString().trim();
    const checkIn   = (rec.check_in   || det.check_in   || null) || null;
    const checkOut  = (rec.check_out  || det.check_out  || null) || null;
    const notes     = (rec.notes ?? det.notes ?? '').toString();
    const rawDate   = rec.att_date || rec.from_date || '';
    const attDate   = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : null;

    if (!Number.isInteger(bookingId) || bookingId <= 0) return { error: 'A valid booking_id is required.' };
    if (!Number.isInteger(hpId) || hpId <= 0)           return { error: 'A valid hp_id is required.' };
    if (!attDate)                                       return { error: 'A valid date (YYYY-MM-DD) is required.' };
    if (!ATT_STATUSES.includes(status))                 return { error: `status must be one of: ${ATT_STATUSES.join(', ')}.` };
    if (!ATT_SHIFTS.includes(shiftType))                return { error: `shift_type must be one of: ${ATT_SHIFTS.join(', ')}.` };

    const workingHours = _attWorkingHours(checkIn, checkOut);

    const row = {
      booking_id:    bookingId,
      inv_id:        invId,
      hp_id:         hpId,
      att_date:      attDate,
      from_date:     attDate,             // keep legacy column populated
      status,
      shift_type:    shiftType,
      check_in:      checkIn,
      check_out:     checkOut,
      working_hours: workingHours,
      notes:         notes || null,
      att_details:   JSON.stringify({     // dual-write for backward compatibility
        check_in: checkIn, check_out: checkOut, status,
        shift_type: shiftType, working_hours: workingHours, notes,
      }),
      org_id:        orgId,
    };
    return { row, bookingId };
  };

  // Idempotent write keyed on (org_id, hp_id, att_date): insert or update.
  const _upsertAttendance = (qb, row, userId, now) =>
    qb('edx_hp_attendance')
      .insert({ ...row, created_by: userId, created_on: now, updated_by: userId, updated_on: now })
      .onConflict(['org_id', 'hp_id', 'att_date'])
      .merge({
        booking_id: row.booking_id, inv_id: row.inv_id, status: row.status,
        shift_type: row.shift_type, check_in: row.check_in, check_out: row.check_out,
        working_hours: row.working_hours, notes: row.notes, from_date: row.from_date,
        att_details: row.att_details, updated_by: userId, updated_on: now,
      });

  const markAttendance = async (req, res) => {
    try {
      const userId = req.login_data.id;
      const orgId  = getOrgId(req);
      const now    = getCurrentDateTime();

      const built = _buildAttendanceRow(req.body, orgId);
      if (built.error) return res.status(400).json({ message: built.error });

      // Ensure the booking exists in this org — avoids the FK violation
      // surfacing to the client as an opaque 500.
      const booking = await db('edx_bookings')
        .where({ id: built.bookingId, org_id: orgId })
        .first('id');
      if (!booking) {
        return res.status(400).json({
          message: `Booking #${built.bookingId} was not found for this organisation.`,
        });
      }

      await _upsertAttendance(db, built.row, userId, now);

      res.status(201).json({ message: 'Attendance marked successfully.' });
    } catch (err) {
      logger.error(`Error marking attendance: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error marking attendance.' });
    }
  };

  /**
   * Batch attendance: accepts { records: [...] } and upserts them in a single
   * transaction. Per-record validation failures are returned in `failed[]`
   * without aborting the valid rows.
   */
  const markAttendanceBatch = async (req, res) => {
    try {
      const userId  = req.login_data.id;
      const orgId   = getOrgId(req);
      const now     = getCurrentDateTime();
      const records = Array.isArray(req.body?.records) ? req.body.records : null;

      if (!records || records.length === 0) {
        return res.status(400).json({ message: 'records[] is required and must be non-empty.' });
      }
      if (records.length > 500) {
        return res.status(400).json({ message: 'Too many records in one batch (max 500).' });
      }

      const built  = [];
      const failed = [];
      records.forEach((rec, index) => {
        const b = _buildAttendanceRow(rec, orgId);
        if (b.error) failed.push({ index, hp_id: rec.hp_id ?? null, error: b.error });
        else         built.push({ index, ...b });
      });

      // Verify every referenced booking exists in this org (one query).
      const bookingIds = [...new Set(built.map(b => b.bookingId))];
      const existing = bookingIds.length
        ? (await db('edx_bookings').whereIn('id', bookingIds).where('org_id', orgId).select('id'))
            .map(r => r.id)
        : [];
      const existingSet = new Set(existing);

      const toUpsert = [];
      for (const b of built) {
        if (existingSet.has(b.bookingId)) toUpsert.push(b.row);
        else failed.push({ index: b.index, hp_id: b.row.hp_id, error: `Booking #${b.bookingId} not found.` });
      }

      let saved = 0;
      if (toUpsert.length) {
        await withTransaction(async (trx) => {
          for (const row of toUpsert) {
            await _upsertAttendance(trx, row, userId, now);
            saved++;
          }
        });
      }

      res.status(saved === 0 && failed.length ? 400 : 200).json({
        message: `Attendance saved for ${saved} HP(s)` + (failed.length ? `, ${failed.length} failed.` : '.'),
        saved,
        failed,
      });
    } catch (err) {
      logger.error(`Error markAttendanceBatch: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error saving attendance batch.' });
    }
  };
  const getAttendanceList = async (req, res) => {
    try {
      const { hp_id, from_date, to_date } = req.query;
      const orgId = getOrgId(req);

      // COALESCE(att_date, from_date) lets legacy rows (pre-normalisation) and
      // new rows both filter/sort on a single effective date.
      const effDate = "COALESCE(a.att_date, a.from_date)";

      let q = db('edx_hp_attendance as a')
        .leftJoin('edx_hp_registration as hp', 'a.hp_id', 'hp.hp_reg_id')
        .where('a.org_id', orgId)
        .select(
          'a.id',
          'a.booking_id',
          'a.inv_id',
          'a.from_date',
          'a.att_date',
          'a.status',
          'a.shift_type',
          'a.check_in',
          'a.check_out',
          'a.working_hours',
          'a.notes',
          'a.att_details',
          'a.hp_id',
          'a.created_on',
          'a.created_by',
          'a.updated_on',
          db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''),' ',COALESCE(hp.hp_reg_last_name,'')) as hp_name"),
          'hp.hp_reg_phone_number'
        )
        .orderByRaw(`${effDate} desc`);

      if (hp_id)     q = q.where('a.hp_id', hp_id);
      if (from_date) q = q.whereRaw(`${effDate} >= ?`, [from_date]);
      if (to_date)   q = q.whereRaw(`${effDate} <= ?`, [to_date]);

      const rows = await q;
      const data = rows.map(r => {
        // Legacy rows only carry att_details JSON; fall back to it when the
        // first-class columns are still null.
        let d = {};
        try { d = JSON.parse(r.att_details) || {}; } catch (_) {}
        return {
          ...r,
          att_date:      r.att_date      ?? r.from_date ?? null,
          status:        r.status        ?? d.status ?? null,
          shift_type:    r.shift_type    ?? d.shift_type ?? null,
          check_in:      r.check_in      ?? d.check_in ?? null,
          check_out:     r.check_out     ?? d.check_out ?? null,
          working_hours: r.working_hours ?? d.working_hours ?? 0,
          notes:         r.notes         ?? d.notes ?? null,
          att_details:   d,
        };
      });

      res.json(data);
    } catch (err) {
      logger.error(`Error getAttendanceList: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error fetching attendance list.' });
    }
  };

  const cancelUserService = async (req, res) => {
    try {
      const {
        booking_id,
    
        term_date,
        term_reason,
        term_remarks,
        booking_status
      
        
      } = req.body;
      const userId = req.login_data.id;
      const orgId = getOrgId(req);

      const cancelTarget = await db('edx_bookings').where({ id: booking_id, org_id: orgId }).first('id', 'user_id');
      if (!cancelTarget) return res.status(404).json({ message: 'Booking not found.' });

      const cancelDate = parseLocalDate(term_date) ? term_date : formatLocalDate(new Date());

      // Cancel and settle once, in one transaction with the booking locked.
      // Settlement is against what was already INVOICED (the booking was
      // invoiced for its whole period up front): used days over the invoices
      // → invoice the difference; invoices over the used days → a Pending
      // 'Cancellation' credit note (normal maker-checker approval). Money the
      // client overpaid shows as credit and goes back through createRefund.
      let billingSummary;
      try {
        billingSummary = await withTransaction(async (trx) => {
          const booking = await trx('edx_bookings').where({ id: booking_id, org_id: orgId }).forUpdate().first();
          if (!booking || ['3', '6'].includes(String(booking.status))) {
            throw Object.assign(new Error('Booking is already cancelled.'), { status: 409 });
          }

          // Computed from the booking as it was before cancelling.
          const summary = await computeCancellationSettlement(trx, { booking, orgId, cancelDate });

          await trx('edx_service_closed').insert(withOrg(req, {
            booking_id: booking_id || 'NA',
            term_date: term_date || 'NA',
            term_reason: term_reason || 'NA',
            term_remarks: term_remarks || 'NA',
            created_on: getCurrentDateTime(),
            created_by: userId
          }));

          await trx('edx_bookings')
            .where({ id: booking_id, org_id: orgId })
            .update({
              status: '6',
              updated_on: db.fn.now(),
              updated_by: userId
            });

          if (summary && summary.invoice_amount > 0) {
            await trx('edx_invoice').insert({
              booking_id,
              inv_raised_amnt: summary.invoice_amount,
              inv_start:       cancelDate,
              inv_end:         cancelDate,
              inv_date:        getCurrentDateTime(),
              due_date:        mysqlDateAddDays(7),
              invoice_type:    'Regular',
              org_id:          orgId,
              created_by:      userId,
              created_on:      getCurrentDateTime(),
            });
          }
          if (summary && summary.credit_note_amount > 0) {
            await trx('edx_credit_notes').insert({
              booking_id,
              invoice_id:  null,
              credit_type: 'Cancellation',
              amount:      summary.credit_note_amount,
              reason:      `Unused days after cancellation${term_reason && term_reason !== 'NA' ? ` — ${term_reason}` : ''}`,
              status:      'Pending',
              credit_date: getCurrentDateTime(),
              org_id:      orgId,
              created_by:  userId,
              created_on:  getCurrentDateTime(),
            });
          }
          return summary;
        });
      } catch (cancelErr) {
        if (cancelErr.status === 409) return res.status(409).json({ message: cancelErr.message });
        throw cancelErr;
      }

      res.status(201).json({
        message:          'Service cancelled successfully.',
        billing_summary:  billingSummary,  // included so frontend can show modal
      });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
      logAudit({
        entityType: 'BOOKING',
        entityId:   booking_id,
        action:     'STATUS_CHANGE',
        changedBy:  userId,
        org_id:     getOrgId(req),
        newValues:  { status: 'CANCELLED', term_reason, booking_status },
      });

      notifyOrgAdmins(getOrgId(req), {
        type:  'booking',
        title: `Booking #${booking_id} cancelled`,
        body:  `Service closed${term_reason && term_reason !== 'NA' ? ` — ${term_reason}` : ''}${term_date && term_date !== 'NA' ? ` (effective ${term_date})` : ''}.`,
        data:  { booking_id, route: 'bookings' },
      });

      // ── Cancellation billing email (fire-and-forget; settlement is already
      //    committed above) ─────────────────────────────────────────────────
      setImmediate(async () => {
        try {
          if (!billingSummary) return;
          const { owing, refundable } = billingSummary;
          // bookings.user_id is a CLIENT id → edx_client_app_users.
          const bookingData = await getClientContact(cancelTarget.user_id, orgId);

          // Send cancellation billing email
          if (bookingData && bookingData.user_email) {
            const tpl = cancellationBillingSummary({
              clientName:  bookingData.user_name || 'Client',
              bookingId:   booking_id,
              cancelDate:  term_date || '—',
              reason:      term_reason || '—',
              daysUsed:    billingSummary.days_used,
              dailyRate:   billingSummary.daily_rate,
              amountDue:   billingSummary.amount_due,
              totalPaid:   billingSummary.total_paid,
              owing,
              refundable,
            });
            await sendEmail({ to: bookingData.user_email, ...tpl });
          }
        } catch (asyncErr) {
          logger.warn(`[accounts] Cancellation billing async failed: ${asyncErr.message}`);
        }
      });

    } catch (err) {
      logger.error(`Error cancelling service: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error cancelling service.' });
    }
  };

  const extendBooking = async (req, res) => {
    try {
      const {
        booking_id,
        from_date,
        to_date,
        from_time,
        to_time,
        hp_id,
        hp_unique_id
      } = req.body;

      if (!booking_id || !from_date || !to_date) {
        return res.status(400).json({ message: 'booking_id, from_date, and to_date are required.' });
      }

      const userId = req.login_data.id;

      // Fetch booking to auto-calculate invoice amount from final_rate
      const booking = await db('edx_bookings')
        .where({ id: booking_id, org_id: getOrgId(req) })
        .first();
      if (!booking) {
        return res.status(404).json({ message: 'Booking not found.' });
      }

      const start = new Date(from_date);
      const end = new Date(to_date);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ message: 'Invalid from_date or to_date.' });
      }
      const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
      if (!(totalDays > 0)) {
        return res.status(400).json({ message: 'to_date must be on or after from_date.' });
      }
      const finalRate = parseFloat(booking.final_rate) || parseFloat(booking.base_rate) || 0;
      const inv_raised_amnt = totalDays * finalRate;

      // Due date = today + the org's payment terms (Settings → Organisation
      // Profile), falling back to env/15 days. Use local-date formatting to
      // avoid the UTC off-by-one in timezones ahead of UTC.
      const orgTerms = await getOrgBrand(db, getOrgId(req));
      const paymentTermsDays = Number(orgTerms?.payment_terms_days)
        || parseInt(process.env.PAYMENT_TERMS_DAYS || '15');
      const dueDateStr = mysqlDateAddDays(paymentTermsDays);

      let ext_invoice_id;
      await withTransaction(async (trx) => {
        const [invoice_id] = await trx('edx_invoice').insert(withOrg(req, {
          booking_id: booking_id,
          inv_raised_amnt: inv_raised_amnt,
          inv_start: from_date,
          inv_end: to_date,
          inv_date: db.fn.now(),
          due_date: dueDateStr,
          invoice_type: 'Regular',
          created_by: userId,
          created_on: getCurrentDateTime()
        }));
        ext_invoice_id = invoice_id;

        await trx('edx_extension_booking').insert(withOrg(req, {
          booking_id: booking_id,
          inv_id: invoice_id,
          from_date: from_date,
          to_date: to_date,
          from_time: from_time || 'NA',
          to_time: to_time || 'NA',
          hp_id: hp_id || 'NA',
          created_on: getCurrentDateTime(),
          created_by: userId
        }));

        await trx('edx_bookings')
          .where({ id: booking_id, org_id: getOrgId(req) })
          .update({
            service_end_date: to_date,
            service_start_time: from_time || db.raw('service_start_time'),
            service_end_time: to_time || db.raw('service_end_time'),
            updated_on: db.fn.now(),
            updated_by: userId
          });

        if (hp_unique_id) {
          await trx('edx_booking_hp')
            .where({ bkng_id: booking_id, hp_unique_id: hp_unique_id, org_id: getOrgId(req) })
            .update({
              end_date_planned: to_date,
              in_time: from_time || db.raw('in_time'),
              out_time: to_time || db.raw('out_time'),
              updated_on: db.fn.now(),
              updated_by: userId
            });
        }
      });

      res.status(201).json({
        message: 'Service extended successfully.',
        total_days: totalDays,
        inv_raised_amnt,
        due_date: dueDateStr,
      });

      notifyOrgAdmins(getOrgId(req), {
        type:  'booking',
        title: `Booking #${booking_id} extended to ${to_date}`,
        body:  `Extension invoice INV-${ext_invoice_id} raised for ₹${Number(inv_raised_amnt).toLocaleString('en-IN')} (${totalDays} days, due ${dueDateStr}).`,
        data:  { booking_id, invoice_id: ext_invoice_id, route: 'bookings' },
      });

      // ── Send extension invoice email (fire-and-forget) ────────────────────
      setImmediate(async () => {
        try {
          const [user, org, meta] = await Promise.all([
            getClientContact(booking.user_id, getOrgId(req)), // client id → edx_client_app_users
            getOrgBrand(db, getOrgId(req)),
            db('edx_bookings as b')
              .where({ 'b.id': booking_id, 'b.org_id': getOrgId(req) })
              .leftJoin('edx_patient as p', 'b.patient_id', 'p.id')
              .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
              .first('p.patient_name', 'ms.name as service_name'),
          ]);
          if (user && user.user_email) {
            const tpl = invoiceEmail({
              org,
              clientName:  user.user_name || 'Client',
              invoiceId:   ext_invoice_id || `EXT-${booking_id}`,
              bookingId:   booking_id,
              patientName: meta?.patient_name,
              serviceName: `Service extension — ${meta?.service_name || 'care services'}`,
              amount:      inv_raised_amnt,
              periodFrom:  from_date,
              periodTo:    to_date,
              dueDate:     dueDateStr,
            });
            await sendEmail({ to: user.user_email, fromName: org?.name, ...tpl });
          }
        } catch (emailErr) {
          logger.warn(`[email] Extension invoice email failed for booking #${booking_id}: ${emailErr.message}`);
        }
      });

    } catch (err) {
      logger.error(`Error extending booking: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error extending service.' });
    }
  };
  const finalBookingSave = async (req, res) => {
    const trx = await db.transaction();
  
    try {
  
      const {
        booking_id,
        otp,
        hp_unique_id
      } = req.body;
  
      const userId = req.login_data.id;
  
      /* 1️⃣ Verify OTP */
      // forUpdate() locks the row for this transaction so two concurrent
      // verifications with the same OTP can't both pass the otp_verified check
      // and each raise an invoice (duplicate-invoice race).
      const hpBooking = await trx('edx_booking_hp')
        .where({
          bkng_id: booking_id,
          hp_unique_id: hp_unique_id,
          otp: otp,
          org_id: getOrgId(req)
        })
        .forUpdate()
        .first();
  
      if (!hpBooking) {
        await trx.rollback();
        return res.status(400).json({ message: "Invalid OTP" });
      }
  
      if (hpBooking.otp_verified === 1) {
        await trx.rollback();
        return res.status(400).json({ message: "OTP already verified" });
      }
  
      /* 2️⃣ Mark OTP verified */
      await trx('edx_booking_hp')
        .where({
          bkng_id: booking_id,
          hp_unique_id: hp_unique_id,
          org_id: getOrgId(req)
        })
        .update({
          otp_verified: 1,
          otp_verification_datetime: db.fn.now(),
          updated_by: userId
        });

      /* 3️⃣ Get booking details */
      const booking = await trx('edx_bookings')
        .where({ id: booking_id, org_id: getOrgId(req) })
        .first();
  
      if (!booking) {
        await trx.rollback();
        return res.status(404).json({ message: "Booking not found" });
      }
  
      const startDate = booking.service_start_date;
      const endDate = booking.service_end_date;
      // final_rate is only persisted when the booking is explicitly edited;
      // on a freshly created booking it is NULL, so fall back to base_rate.
      const finalRate = parseFloat(booking.final_rate) || parseFloat(booking.base_rate) || 0;

      // Refuse to raise a ₹0 invoice — the booking has no usable rate set.
      if (!(finalRate > 0)) {
        await trx.rollback();
        return res.status(400).json({
          message: "Cannot raise invoice: booking has no valid rate. Set the booking rate before verifying OTP.",
        });
      }

      /* 4️⃣ Calculate total days */
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Guard against 'NA'/invalid dates that would make the invoice amount NaN.
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        await trx.rollback();
        return res.status(400).json({
          message: "Cannot raise invoice: booking has invalid service dates.",
        });
      }

      const diffTime = end - start;
      const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

      if (!(totalDays > 0)) {
        await trx.rollback();
        return res.status(400).json({
          message: "Cannot raise invoice: service end date must be on or after the start date.",
        });
      }

      /* 5️⃣ Calculate invoice */
      const invoiceAmount = totalDays * finalRate;
  
      /* 6️⃣ Insert invoice with due_date (org payment terms, env fallback) */
      const invOrgTerms = await getOrgBrand(db, getOrgId(req));
      const invPaymentTermsDays = Number(invOrgTerms?.payment_terms_days)
        || parseInt(process.env.PAYMENT_TERMS_DAYS || '15');
      const invDueDateStr = mysqlDateAddDays(invPaymentTermsDays);

      const [invoice_id] = await trx('edx_invoice').insert(withOrg(req, {
        booking_id:      booking_id,
        inv_raised_amnt: invoiceAmount,
        inv_start:       startDate,
        inv_end:         endDate,
        due_date:        invDueDateStr,
        invoice_type:    'Regular',
        created_by:      userId,
        created_on:      getCurrentDateTime(),
        inv_date:        db.fn.now()
      }));
  
      /* 7️⃣ Update booking hp */
      await trx('edx_booking_hp')
        .where({
          bkng_id: booking_id,
          hp_unique_id: hp_unique_id,
          org_id: getOrgId(req)
        })
        .update({
          service_start_date: startDate,
          service_end_date: endDate,
          updated_on: db.fn.now(),
          updated_by: userId,
          status:4
        });

      /* 8️⃣ Update HP status */
      await trx('edx_hp_registration')
        .where({ hp_reg_id: hp_unique_id, org_id: getOrgId(req) })
        .update({
          hp_reg_status: 5,
          updated_on: db.fn.now(),
          updated_by: userId
        });
  
      // update booking status
      await trx('edx_bookings')
        .where({ id: booking_id, org_id: getOrgId(req) })
        .update({
          status: "4",
          updated_on: db.fn.now(),
          updated_by: userId
        });
      /* 9️⃣ Commit transaction */
      await trx.commit();

      res.status(200).json({
        message: "OTP verified & invoice generated successfully",
        invoice_id: invoice_id,
        total_days: totalDays,
        invoice_amount: invoiceAmount
      });

      // ── Send invoice email to client (non-blocking) ─────────────────────────
      setImmediate(async () => {
        try {
          const [user, org, meta] = await Promise.all([
            getClientContact(booking.user_id, getOrgId(req)), // client id → edx_client_app_users
            getOrgBrand(db, getOrgId(req)),
            db('edx_bookings as b')
              .where({ 'b.id': booking_id, 'b.org_id': getOrgId(req) })
              .leftJoin('edx_patient as p', 'b.patient_id', 'p.id')
              .leftJoin('edx_master_services as ms', 'b.service_type_id', 'ms.id')
              .first('p.patient_name', 'ms.name as service_name'),
          ]);
          if (user && user.user_email) {
            const tpl = invoiceEmail({
              org,
              clientName:  user.user_name || 'Client',
              invoiceId:   invoice_id,
              bookingId:   booking_id,
              patientName: meta?.patient_name,
              serviceName: meta?.service_name,
              amount:      invoiceAmount,
              periodFrom:  booking.service_start_date || '—',
              periodTo:    booking.service_end_date   || '—',
              dueDate:     invDueDateStr,
            });
            await sendEmail({ to: user.user_email, fromName: org?.name, ...tpl });
          }
        } catch (emailErr) {
          logger.warn(`[email] Invoice email failed for booking #${booking_id}: ${emailErr.message}`);
        }
      });
  
    } catch (err) {
  
      await trx.rollback();
  
      logger.error(`Error ${err.message}`);
      console.error(err);
  
      res.status(500).json({
        message: "Invoice generation failed"
      });
    }
  };

  const getUserBookings = async (req, res) =>  {
    try {
      const filters = req.query;
      const getUserBookingsModel = await getBookings.getUserBookingsModel(filters, req.login_data);
  
      res.json(getUserBookingsModel);
    } catch (err) {
      console.error('❌ Controller error:Error fetching user Bookings ', err.message);
      logger.error(`Error user Bookings: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while user Bookings' });
    }
  };
  const getHPByBooking = async (req, res) =>  {
    try {
      const filters = req.query;
      const getHPByBookingModel = await getBookings.getHPByBookingModel(filters, req.login_data);
  
      res.json(getHPByBookingModel);
    } catch (err) {
      console.error('❌ Controller error:Error fetching user Bookings ', err.message);
      logger.error(`Error user Bookings: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while user Bookings' });
    }
  };
  const getBookingOTP = async (req, res) =>  {
    try {
      const { bkng_id, hp_unique_id } = req.query;

      if (!bkng_id || !hp_unique_id) {
          return res.status(400).json({
              status: false,
              message: "bkng_id and hp_unique_id are required"
          });
      }

      const otpData = await getBookings.getOTP(bkng_id, hp_unique_id, getOrgId(req));

      if (!otpData) {
          return res.status(404).json({
              status: false,
              message: "No OTP found for given booking"
          });
      }

      return res.status(200).json({
          status: true,
          message: "OTP fetched successfully",
          data: otpData
      });

  } catch (error) {
      console.error("getBookingOTP Error:", error);
      return res.status(500).json({
          status: false,
          message: "Server error"
      });
  }
  };

  
// ── Phase 4.4 — HP Matching & Scoring ────────────────────────────────────────

/**
 * GET /api/matchHP?booking_id=X
 *
 * Scores all approved, available HPs against a booking on a 100-point scale:
 *   +25  City match      (HP branch = booking branch)
 *   +30  Language match  (any overlap between HP languages and booking languages)
 *   +20  Experience      (hp_reg_experience >= 2)
 *   +15  Gender match    (HP gender = patient gender preference)
 *   +10  Client history  (HP previously served the same client/user)
 *
 * Returns top 10 HPs sorted by score DESC.
 */
const getMatchedHPs = async (req, res) => {
  try {
    const { booking_id } = req.query;
    if (!booking_id) return res.status(400).json({ message: 'booking_id is required.' });

    // 1. Fetch booking + patient info
    const booking = await db('edx_bookings as b')
      .leftJoin('edx_patient as p', 'b.patient_id', 'p.id')
      .select(
        'b.id', 'b.branch_id', 'b.user_id',
        'b.service_start_date', 'b.service_end_date',
        'p.languages as req_languages',
        'p.gender    as req_gender',
      )
      .where('b.id', booking_id)
      .where('b.org_id', getOrgId(req))
      .first();

    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    const reqLanguages = (booking.req_languages || '')
      .split(',').map(l => l.trim().toLowerCase()).filter(Boolean);
    // req_gender comes from p.gender which can be an integer — wrap in String()
    const reqGender  = String(booking.req_gender  || '').toLowerCase();
    const branchId   = booking.branch_id;
    const userId     = booking.user_id;

    // 2. Fetch all approved HPs not currently on a conflicting active booking
    //    (A conflict = they have a booking that overlaps the requested date range
    //     with status Active/Confirmed/In-Progress)
    const conflictingHpIds = (await db('edx_booking_hp as bh')
      .join('edx_bookings as b2', 'bh.bkng_id', 'b2.id')
      .where('b2.org_id', getOrgId(req))
      .where('bh.org_id', getOrgId(req))
      .whereIn('b2.status', ENGAGED_BOOKING_STATUSES)
      .where(function () {
        this
          .where('b2.service_start_date', '<=', booking.service_end_date)
          .where('b2.service_end_date',   '>=', booking.service_start_date);
      })
      .select('bh.hp_unique_id'))
      .map(r => r.hp_unique_id);

    let hpQuery = db('edx_hp_registration as hp')
      .where('hp.hp_reg_status', 2) // Approved
      .where('hp.org_id', getOrgId(req))
      .select(
        'hp.hp_reg_id',
        db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''), ' ', COALESCE(hp.hp_reg_last_name,'')) as name"),
        'hp.hp_reg_branch_id',
        'hp.hp_reg_languages',
        'hp.hp_reg_gender',
        'hp.hp_reg_experience',
        'hp.hp_reg_city',
      );

    if (conflictingHpIds.length > 0) {
      hpQuery = hpQuery.whereNotIn('hp.hp_reg_id', conflictingHpIds);
    }

    const hps = await hpQuery;

    // 3. Fetch client-history: HP → user booking pairs
    const historyRows = await db('edx_booking_hp as bh')
      .join('edx_bookings as b3', 'bh.bkng_id', 'b3.id')
      .where('b3.user_id', userId)
      .where('b3.org_id', getOrgId(req))
      .select('bh.hp_unique_id');
    const historySet = new Set(historyRows.map(r => r.hp_unique_id));

    // 4. Score each HP
    const scored = hps.map(hp => {
      let score = 0;

      // City / branch match
      if (Number(hp.hp_reg_branch_id) === Number(branchId)) score += 25;

      // Language match (any overlap)
      const hpLangs = (hp.hp_reg_languages || '')
        .split(',').map(l => l.trim().toLowerCase()).filter(Boolean);
      if (reqLanguages.some(l => hpLangs.includes(l))) score += 30;

      // Experience >= 2 years
      const exp = parseFloat(hp.hp_reg_experience) || 0;
      if (exp >= 2) score += 20;

      // Gender match
      const hpGender = (hp.hp_reg_gender || '').toLowerCase();
      if (reqGender && hpGender === reqGender) score += 15;

      // Client history
      if (historySet.has(hp.hp_reg_id)) score += 10;

      return {
        hp_reg_id:  hp.hp_reg_id,
        name:       (hp.name || '').trim() || `HP #${hp.hp_reg_id}`,
        branch_id:  hp.hp_reg_branch_id,
        city:       hp.hp_reg_city,
        languages:  hp.hp_reg_languages,
        gender:     hp.hp_reg_gender,
        experience: hp.hp_reg_experience,
        score,
        score_pct:  score, // already on 100-pt scale
      };
    });

    // 5. Sort by score DESC, return top 10
    scored.sort((a, b) => b.score - a.score);

    res.json({
      booking_id: parseInt(booking_id),
      total_available: hps.length,
      matches: scored.slice(0, 10),
    });
  } catch (err) {
    logger.error(`[matchHP] error: ${err.message}`);
    res.status(500).json({ message: 'Failed to match HPs.' });
  }
};

module.exports = guardOrgHandlers({
    createBooking,
    getUserBookings,
    holdBooking,
    markAttendance,
    markAttendanceBatch,
    extendBooking,
    cancelUserService,
    updateBooking,
    updatePatient,
    getBookingOTP,
    assignHPToBooking,
    getHPByBooking,
    updateHPBooking,
    finalBookingSave,
    getMatchedHPs,  // Phase 4.4
    getAttendanceList,
  });