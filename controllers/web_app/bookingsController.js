const getBookings = require('../../models/web_app/bookingsModel');
const db = require('../../config/db');
const logger = require('../../logger');
require('dotenv').config();
const { getCurrentDateTime, mysqlDateAddDays } = require("../../utils/dateTime");
const withTransaction = require('../../utils/withTransaction');
const { sendEmail } = require('../../utils/emailService');
const { bookingConfirmed, otpDelivery, invoiceGenerated, creditNoteGenerated, cancellationBillingSummary } = require('../../utils/emailTemplates');
const { sendOTP } = require('../../utils/smsService');
const { logAudit } = require('../../utils/auditLogger'); // Phase 4.2
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope'); // Phase 5

// ── Accounts event helpers ────────────────────────────────────────────────────

/**
 * Auto-create a credit note when a booking is put on hold.
 * Credit = hold_days × daily_rate (preliminary — confirmed when hold is lifted).
 */
async function _createHoldCreditNote({ booking_id, from_date, to_date, inv_id, org_id, created_by }) {
  try {
    const booking = await db('edx_bookings').where({ id: booking_id }).first();
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
 * Compute cancellation billing summary for a booking.
 * Returns { days_used, amount_due, total_paid, balance, refundable, owing }
 */
async function _computeCancellationBilling({ booking_id, cancel_date }) {
  try {
    const booking = await db('edx_bookings').where({ id: booking_id }).first();
    if (!booking) return null;

    const startDate  = booking.service_start_date;
    const finalRate  = parseFloat(booking.final_rate) || parseFloat(booking.base_rate) || 0;
    const cancelOn   = cancel_date || mysqlDateAddDays(0);

    const start    = new Date(startDate);
    const end      = new Date(cancelOn);

    // Bail out on un-billable data instead of computing a bogus settlement.
    // An invalid/missing start date would make daysUsed=0 → amount_due=0 →
    // the entire paid amount would be flagged refundable and auto-written-off.
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || finalRate <= 0) {
      logger.warn(`[accounts] Skipping cancellation billing for booking #${booking_id}: invalid start date or rate.`);
      return null;
    }

    const daysUsed = start <= end ? Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1 : 0;
    const amountDue = daysUsed * finalRate;

    const paidRow = await db('edx_receipts')
      .where({ booking_id, status: 'Approved' })
      .sum('total_amount as total_paid')
      .first();
    const totalPaid = Number(paidRow.total_paid) || 0;

    const balance    = amountDue - totalPaid;
    const refundable = balance < 0 ? Math.abs(balance) : 0;
    const owing      = balance > 0 ? balance : 0;

    return { days_used: daysUsed, daily_rate: finalRate, amount_due: amountDue, total_paid: totalPaid, balance, refundable, owing };
  } catch (err) {
    logger.warn(`[accounts] _computeCancellationBilling failed: ${err.message}`);
    return null;
  }
}

/**
 * Log a rate change to edx_rate_history when booking rates are updated.
 */
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
        org_id:     req.login_data?.org_id ?? 1,
        newValues:  { booking_id, branch_id, service_type_id, user_id },
      });

      // ── Send booking confirmation email (non-blocking) ──────────────────────
      setImmediate(async () => {
        try {
          const user = await db('edx_web_app_users')
            .where({ id: user_id })
            .where('org_id', getOrgId(req))
            .select('user_email', 'user_name')
            .first();
          if (user && user.user_email && user.user_email !== 'NA') {
            const serviceRow = await db('edx_service_types')
              .where({ id: service_type_id })
              .select('service_type_name')
              .first();
            const tpl = bookingConfirmed({
              clientName:  user.user_name || 'Client',
              patientName: patient_name  || 'Patient',
              serviceType: serviceRow?.service_type_name || 'Elder Care Service',
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
      const {
        
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
        patient_id
               
      } = req.body;
      const userId = req.login_data.id;
      // console.log(req.body)
      
      // Insert into DB
     await db('edx_patient')
     .where({ id: patient_id, org_id: getOrgId(req) })
     .update({
        
        patient_name: patient_name ? patient_name : 'NA',
        phone_number: phone_number ? phone_number : 'NA',
        email: email ? email : 'NA',
        age:age?age:'NA',
        yob:yob?yob:'NA',
        weight: weight ? weight : 'NA',
        languages: languages ? languages : 'NA',
        relation: relation ? relation : 'NA',
        gender: gender ? gender : 'NA',
        is_stay_alone: is_stay_alone ? is_stay_alone : 'NA',
        updated_by:userId,
        updated_on: getCurrentDateTime()
  
      });
  
  
      res.status(201).json({ message: 'Patient updated successfully.' });
    } catch (err) {
      logger.error(`Error update patient: ${err.message}`);
      console.error(err);
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
        org_id:     req.login_data?.org_id ?? 1,
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
          org_id:        req.login_data?.org_id ?? 1,
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
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
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
        org_id:     req.login_data?.org_id ?? 1,
        newValues:  { status: 'HOLD', from_date, to_date, reason },
      });

      // ── Auto-create hold credit note (fire-and-forget) ──────────────────────
      setImmediate(() => _createHoldCreditNote({
        booking_id,
        from_date,
        to_date,
        inv_id:     inv_id || null,
        org_id:     req.login_data?.org_id ?? 1,
        created_by: userId,
      }));

      // ── Notify client of service hold (fire-and-forget) ─────────────────────
      setImmediate(async () => {
        try {
          const booking = await db('edx_bookings as b')
            .leftJoin('edx_web_app_users as u', 'b.user_id', 'u.id')
            .where('b.id', booking_id)
            .where('b.org_id', getOrgId(req))
            .select('u.user_email', 'u.user_name')
            .first();
          if (booking && booking.user_email && booking.user_email !== 'NA') {
            const booking_data = await db('edx_bookings')
              .where({ id: booking_id, org_id: getOrgId(req) })
              .first();
            const finalRate = parseFloat(booking_data?.final_rate) || 0;
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
  
      // continue logic...
  
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
        error: err.message,
      });
    }
  };
  const markAttendance = async (req, res) => {
    try {
      const { booking_id, inv_id, from_date, att_details, hp_id } = req.body;
      const userId = req.login_data.id;
      const orgId  = getOrgId(req);

      // ── Validation (return 400 for bad input, not 500) ──────────────────────
      const bookingId = parseInt(booking_id, 10);
      const hpId      = parseInt(hp_id, 10);
      const invId     = inv_id ? parseInt(inv_id, 10) : null;

      if (!Number.isInteger(bookingId) || bookingId <= 0) {
        return res.status(400).json({
          message: 'A valid booking_id is required to mark attendance.',
        });
      }
      if (!Number.isInteger(hpId) || hpId <= 0) {
        return res.status(400).json({ message: 'A valid hp_id is required.' });
      }
      if (!from_date) {
        return res.status(400).json({ message: 'from_date is required.' });
      }

      // Ensure the booking exists in this org before inserting — avoids the
      // booking_id FK violation surfacing to the client as an opaque 500.
      const booking = await db('edx_bookings')
        .where({ id: bookingId, org_id: orgId })
        .first('id');
      if (!booking) {
        return res.status(400).json({
          message: `Booking #${bookingId} was not found for this organisation.`,
        });
      }

      await db('edx_hp_attendance').insert(withOrg(req, {
        booking_id:  bookingId,
        inv_id:      invId && invId > 0 ? invId : null,
        from_date:   from_date,
        att_details: att_details || null,
        hp_id:       hpId,
        created_on:  getCurrentDateTime(),
        created_by:  userId,
      }));

      res.status(201).json({ message: 'Attendance marked successfully.' });
    } catch (err) {
      logger.error(`Error marking attendance: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error marking attendance.', error: err.message });
    }
  };
  const getAttendanceList = async (req, res) => {
    try {
      const { hp_id, from_date, to_date } = req.query;
      const orgId = getOrgId(req);

      let q = db('edx_hp_attendance as a')
        .leftJoin('edx_hp_registration as hp', 'a.hp_id', 'hp.hp_reg_id')
        .where('a.org_id', orgId)
        .select(
          'a.id',
          'a.booking_id',
          'a.inv_id',
          'a.from_date',
          'a.att_details',
          'a.hp_id',
          'a.created_on',
          'a.created_by',
          db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''),' ',COALESCE(hp.hp_reg_last_name,'')) as hp_name"),
          'hp.hp_reg_phone_number'
        )
        .orderBy('a.from_date', 'desc');

      if (hp_id)     q = q.where('a.hp_id', hp_id);
      if (from_date) q = q.whereRaw('a.from_date >= ?', [from_date]);
      if (to_date)   q = q.whereRaw('a.from_date <= ?', [to_date]);

      const rows = await q;
      const data = rows.map(r => {
        let d = {};
        try { d = JSON.parse(r.att_details); } catch (_) {}
        return { ...r, att_details: d };
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

      await withTransaction(async (trx) => {
        await trx('edx_service_closed').insert(withOrg(req, {
          booking_id: booking_id || 'NA',
          term_date: term_date || 'NA',
          term_reason: term_reason || 'NA',
          term_remarks: term_remarks || 'NA',
          created_on: getCurrentDateTime(),
          created_by: userId
        }));

        await trx('edx_bookings')
          .where({ id: booking_id, org_id: getOrgId(req) })
          .update({
            status: '6',
            updated_on: db.fn.now(),
            updated_by: userId
          });
      });

      // ── Compute cancellation billing (fire-and-forget) ──────────────────────
      const billingSummary = await _computeCancellationBilling({
        booking_id,
        cancel_date: term_date || null,
      });

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
        org_id:     req.login_data?.org_id ?? 1,
        newValues:  { status: 'CANCELLED', term_reason, booking_status },
      });

      // ── Auto-create cancellation invoice or write-off trigger (fire-and-forget)
      setImmediate(async () => {
        try {
          if (!billingSummary) return;
          const { owing, refundable } = billingSummary;
          const bookingData = await db('edx_bookings as b')
            .leftJoin('edx_web_app_users as u', 'b.user_id', 'u.id')
            .where('b.id', booking_id)
            .select('u.user_email', 'u.user_name', 'u.user_mobile')
            .first();

          // If client owes more → raise cancellation invoice
          if (owing > 0) {
            await db('edx_invoice').insert({
              booking_id,
              inv_raised_amnt: owing,
              inv_start:       term_date || getCurrentDateTime(),
              inv_end:         term_date || getCurrentDateTime(),
              inv_date:        getCurrentDateTime(),
              due_date:        mysqlDateAddDays(7),
              invoice_type:    'Regular',
              org_id:          req.login_data?.org_id ?? 1,
              created_by:      userId,
              created_on:      getCurrentDateTime(),
            });
            logger.info(`[accounts] Cancellation invoice raised for booking #${booking_id}: ₹${owing}`);
          }

          // If client overpaid → auto-create pending write-off (refund trigger)
          if (refundable > 0) {
            await db('edx_write_offs').insert({
              booking_id,
              write_off_amount: refundable,
              reason:          `Refund due to service cancellation — ${term_reason || ''}`,
              status:          'Pending',
              write_off_date:  getCurrentDateTime(),
              org_id:          req.login_data?.org_id ?? 1,
              created_by:      userId,
              created_on:      getCurrentDateTime(),
            });
            logger.info(`[accounts] Refund write-off created for booking #${booking_id}: ₹${refundable}`);
          }

          // Send cancellation billing email
          if (bookingData && bookingData.user_email && bookingData.user_email !== 'NA') {
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

      // Due date = today + payment terms (default 15 days). Use local-date
      // formatting to avoid the UTC off-by-one in timezones ahead of UTC.
      const paymentTermsDays = parseInt(process.env.PAYMENT_TERMS_DAYS || '15');
      const dueDateStr = mysqlDateAddDays(paymentTermsDays);

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

      // ── Send extension invoice email (fire-and-forget) ────────────────────
      setImmediate(async () => {
        try {
          const user = await db('edx_web_app_users')
            .where({ id: booking.user_id })
            .select('user_email', 'user_name')
            .first();
          if (user && user.user_email && user.user_email !== 'NA') {
            const tpl = invoiceGenerated({
              clientName: user.user_name || 'Client',
              bookingId:  booking_id,
              amount:     inv_raised_amnt,
              periodFrom: from_date,
              periodTo:   to_date,
              invoiceId:  `EXT-${booking_id}`,
            });
            await sendEmail({ to: user.user_email, ...tpl });
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
  
      /* 6️⃣ Insert invoice with due_date */
      const invPaymentTermsDays = parseInt(process.env.PAYMENT_TERMS_DAYS || '15');
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
          const user = await db('edx_web_app_users')
            .where({ id: booking.user_id })
            .select('user_email', 'user_name')
            .first();
          if (user && user.user_email && user.user_email !== 'NA') {
            const tpl = invoiceGenerated({
              clientName: user.user_name || 'Client',
              bookingId:  booking_id,
              amount:     invoiceAmount,
              periodFrom: booking.service_start_date || '—',
              periodTo:   booking.service_end_date   || '—',
              invoiceId:  invoice_id,
            });
            await sendEmail({ to: user.user_email, ...tpl });
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

      const otpData = await getBookings.getOTP(bkng_id, hp_unique_id);

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
      .join('edx_bookings as b2', 'bh.booking_id', 'b2.id')
      .where('b2.org_id', getOrgId(req))
      .whereIn('b2.status', ['Active', 'Confirmed', 'In-Progress', 'confirmed', 'active'])
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
      .join('edx_bookings as b3', 'bh.booking_id', 'b3.id')
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
    res.status(500).json({ message: 'Failed to match HPs.', details: err.message });
  }
};

module.exports = {
    createBooking,
    getUserBookings,
    holdBooking,
    markAttendance,
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
  };