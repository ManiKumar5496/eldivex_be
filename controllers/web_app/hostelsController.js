/**
 * hostelsController.js — Hostel module CRUD + stay assignment + monthly settlement.
 *
 * Org isolation: every read/write is scoped to getOrgId(req); ids are resolved by
 * {id, org_id} so a tenant can never touch another tenant's rows.
 *
 * Cross-entity gates on stay assignment:
 *   - gender   : CG gender must equal hostel gender
 *   - capacity : active stays must be below hostel capacity
 *   - overlap  : CG must not already have an open/overlapping stay
 */
const hostelsModel = require('../../models/web_app/hostelsModel');
const db = require('../../config/db');
const logger = require('../../logger');
require('dotenv').config();
const { getCurrentDateTime, toMysqlDate } = require('../../utils/dateTime');
const { logAudit } = require('../../utils/auditLogger');
const { withOrg, getOrgId } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a gender value to 'male' | 'female'. CG records store gender as an
 * integer (1=Male, 2=Female, 3=Other), while hostels store the label
 * ('Male'/'Female'); this reconciles both representations.
 */
function normalizeGender(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'male' || s === 'm') return 'male';
  if (s === '2' || s === 'female' || s === 'f') return 'female';
  return s;
}

/** Whole nights between two YYYY-MM-DD dates (>= 0). */
function nightsBetween(checkIn, checkOut) {
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  if (isNaN(a) || isNaN(b)) return 0;
  const ms = b.setHours(0, 0, 0, 0) - a.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Nights of a stay that fall within [periodFrom, periodTo]. An open stay (no
 * check-out) is billed up to periodTo.
 */
function nightsInPeriod(stay, periodFrom, periodTo) {
  const inDate = toMysqlDate(stay.check_in_date);
  const start = inDate > periodFrom ? inDate : periodFrom;
  const rawOut = stay.check_out_date ? toMysqlDate(stay.check_out_date) : periodTo;
  const end = rawOut < periodTo ? rawOut : periodTo;
  if (end < start) return 0;
  return nightsBetween(start, end);
}

// ── Hostels CRUD ───────────────────────────────────────────────────────────

const getHostels = async (req, res) => {
  try {
    const { branch_id, gender, search } = req.query;
    const data = await hostelsModel.getHostelsModel(req, { branch_id, gender, search });
    res.status(200).json(data || []);
  } catch (err) {
    logger.error(`Error getHostels: ${err.message}`);
    res.status(500).json({ message: 'Error fetching hostels.' });
  }
};

const getHostelById = async (req, res) => {
  try {
    const hostel = await hostelsModel.getHostelByIdModel(req, req.params.id);
    if (!hostel) return res.status(404).json({ message: 'Hostel not found.' });
    res.status(200).json(hostel);
  } catch (err) {
    logger.error(`Error getHostelById: ${err.message}`);
    res.status(500).json({ message: 'Error fetching hostel.' });
  }
};

const createHostel = async (req, res) => {
  try {
    const userId = req.login_data.id;
    const {
      hostel_name, address, city, state, pincode, gender,
      rate_per_day, capacity, contact_person_name, contact_phone,
      contact_email, branch_id,
    } = req.body;

    const [id] = await db('edx_hostels').insert(withOrg(req, {
      hostel_name,
      address: address || null,
      city: city || null,
      state: state || null,
      pincode: pincode || null,
      gender,
      rate_per_day: Number(rate_per_day),
      capacity: capacity || null,
      contact_person_name: contact_person_name || null,
      contact_phone: contact_phone || null,
      contact_email: contact_email || null,
      branch_id: branch_id || null,
      status: 1,
      created_by: userId,
      created_on: getCurrentDateTime(),
    }));

    res.status(201).json({ message: 'Hostel created successfully.', id });

    logAudit({
      entityType: 'HOSTEL',
      entityId: id,
      action: 'CREATE',
      changedBy: userId,
      org_id: getOrgId(req),
      newValues: { hostel_name, gender, rate_per_day, capacity },
    });
  } catch (err) {
    logger.error(`Error createHostel: ${err.message}`);
    res.status(500).json({ message: 'Error creating hostel.' });
  }
};

const updateHostel = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.login_data.id;

    const existing = await hostelsModel.getHostelByIdModel(req, id);
    if (!existing) return res.status(404).json({ message: 'Hostel not found.' });

    const fields = [
      'hostel_name', 'address', 'city', 'state', 'pincode', 'gender',
      'capacity', 'contact_person_name', 'contact_phone', 'contact_email', 'branch_id',
    ];
    const updateData = { updated_by: userId, updated_on: getCurrentDateTime() };
    for (const f of fields) {
      if (req.body[f] !== undefined) updateData[f] = req.body[f];
    }
    if (req.body.rate_per_day !== undefined) {
      updateData.rate_per_day = Number(req.body.rate_per_day);
    }

    await db('edx_hostels')
      .where({ id, org_id: getOrgId(req) })
      .update(updateData);

    res.status(200).json({ message: 'Hostel updated successfully.' });

    logAudit({
      entityType: 'HOSTEL',
      entityId: id,
      action: 'UPDATE',
      changedBy: userId,
      org_id: getOrgId(req),
      newValues: updateData,
    });
  } catch (err) {
    logger.error(`Error updateHostel: ${err.message}`);
    res.status(500).json({ message: 'Error updating hostel.' });
  }
};

const toggleHostelStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.login_data.id;
    const { status } = req.body;

    const updated = await db('edx_hostels')
      .where({ id, org_id: getOrgId(req) })
      .update({
        status: status ? 1 : 0,
        updated_by: userId,
        updated_on: getCurrentDateTime(),
      });

    if (!updated) return res.status(404).json({ message: 'Hostel not found.' });
    res.status(200).json({ message: 'Hostel status updated.' });
  } catch (err) {
    logger.error(`Error toggleHostelStatus: ${err.message}`);
    res.status(500).json({ message: 'Error updating status.' });
  }
};

// ── Stays ──────────────────────────────────────────────────────────────────

const getHostelStays = async (req, res) => {
  try {
    const { hostel_id, hp_id, from_date, to_date, status } = req.query;
    const data = await hostelsModel.getHostelStaysModel(req, {
      hostel_id, hp_id, from_date, to_date, status,
    });
    res.status(200).json(data || []);
  } catch (err) {
    logger.error(`Error getHostelStays: ${err.message}`);
    res.status(500).json({ message: 'Error fetching hostel stays.' });
  }
};

const createHostelStay = async (req, res) => {
  try {
    const userId = req.login_data.id;
    const { hostel_id, hp_id, check_in_date, check_out_date } = req.body;
    const checkIn = toMysqlDate(check_in_date);

    // Org-scoped loads — both rows must belong to the caller's org.
    const hostel = await hostelsModel.getHostelByIdModel(req, hostel_id);
    if (!hostel) return res.status(404).json({ message: 'Hostel not found.' });

    const cg = await db('edx_hp_registration')
      .where({ hp_reg_id: hp_id, org_id: getOrgId(req) })
      .first();
    if (!cg) return res.status(404).json({ message: 'Caregiver not found.' });

    // Gender gate
    if (normalizeGender(cg.hp_reg_gender) !== normalizeGender(hostel.gender)) {
      return res.status(400).json({
        message: `This is a ${hostel.gender} hostel; the selected caregiver's gender does not match.`,
      });
    }

    // Capacity gate
    if (hostel.capacity) {
      const active = await hostelsModel.countActiveStaysModel(req, hostel_id);
      if (active >= hostel.capacity) {
        return res.status(400).json({ message: 'Hostel is at full capacity.' });
      }
    }

    // Overlap gate
    const overlap = await hostelsModel.findOverlappingStayModel(req, hp_id, checkIn);
    if (overlap) {
      return res.status(400).json({
        message: 'This caregiver already has an active/overlapping hostel stay.',
      });
    }

    const [id] = await db('edx_hostel_stays').insert(withOrg(req, {
      hostel_id,
      hp_id,
      check_in_date: checkIn,
      check_out_date: check_out_date ? toMysqlDate(check_out_date) : null,
      rate_per_day: Number(hostel.rate_per_day), // snapshot
      status: 'active',
      branch_id: hostel.branch_id || null,
      created_by: userId,
      created_on: getCurrentDateTime(),
    }));

    res.status(201).json({ message: 'Caregiver assigned to hostel.', id });

    logAudit({
      entityType: 'HOSTEL_STAY',
      entityId: id,
      action: 'CREATE',
      changedBy: userId,
      org_id: getOrgId(req),
      newValues: { hostel_id, hp_id, check_in_date: checkIn },
    });
  } catch (err) {
    logger.error(`Error createHostelStay: ${err.message}`);
    res.status(500).json({ message: 'Error assigning caregiver to hostel.' });
  }
};

const closeHostelStay = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.login_data.id;
    const { check_out_date } = req.body;

    const stay = await hostelsModel.getStayByIdModel(req, id);
    if (!stay) return res.status(404).json({ message: 'Stay not found.' });

    const checkOut = toMysqlDate(check_out_date);
    if (checkOut < toMysqlDate(stay.check_in_date)) {
      return res.status(400).json({ message: 'Check-out cannot precede check-in.' });
    }

    await db('edx_hostel_stays')
      .where({ id, org_id: getOrgId(req) })
      .update({
        check_out_date: checkOut,
        status: 'closed',
        updated_by: userId,
        updated_on: getCurrentDateTime(),
      });

    res.status(200).json({ message: 'Stay closed.' });
  } catch (err) {
    logger.error(`Error closeHostelStay: ${err.message}`);
    res.status(500).json({ message: 'Error closing stay.' });
  }
};

// ── Monthly settlement (reconciliation) ──────────────────────────────────────

/**
 * GET /getHostelSettlement?hostel_id=&period_from=&period_to=
 * Computes (does not persist) the amount owed to a hostel for the period, with a
 * per-CG breakdown. Drives both the hostel payment and reconciliation against the
 * deductions applied to CG payouts.
 */
const getHostelSettlement = async (req, res) => {
  try {
    const { hostel_id, period_from, period_to } = req.query;
    if (!hostel_id || !period_from || !period_to) {
      return res.status(400).json({ message: 'hostel_id, period_from and period_to are required.' });
    }
    const from = toMysqlDate(period_from);
    const to = toMysqlDate(period_to);

    const hostel = await hostelsModel.getHostelByIdModel(req, hostel_id);
    if (!hostel) return res.status(404).json({ message: 'Hostel not found.' });

    const stays = await hostelsModel.getHostelStaysModel(req, {
      hostel_id, from_date: from, to_date: to,
    });

    // Roll up per CG.
    const byCg = new Map();
    let totalAmount = 0;
    let totalNights = 0;

    for (const s of stays) {
      const nights = nightsInPeriod(s, from, to);
      if (nights <= 0) continue;
      const amount = nights * Number(s.rate_per_day);
      totalAmount += amount;
      totalNights += nights;

      const prev = byCg.get(s.hp_id) || {
        hp_id: s.hp_id,
        hp_name: s.hp_name,
        phone: s.hp_reg_phone_number,
        nights: 0,
        rate_per_day: Number(s.rate_per_day),
        amount: 0,
      };
      prev.nights += nights;
      prev.amount += amount;
      byCg.set(s.hp_id, prev);
    }

    const lines = Array.from(byCg.values());

    res.status(200).json({
      hostel_id: Number(hostel_id),
      hostel_name: hostel.hostel_name,
      gender: hostel.gender,
      rate_per_day: Number(hostel.rate_per_day),
      period_from: from,
      period_to: to,
      total_amount: totalAmount,
      total_nights: totalNights,
      cg_count: lines.length,
      lines,
    });
  } catch (err) {
    logger.error(`Error getHostelSettlement: ${err.message}`);
    res.status(500).json({ message: 'Error computing settlement.' });
  }
};

/**
 * POST /createHostelSettlement — persists a settlement record (status Pending).
 * Body: { hostel_id, period_from, period_to, payment_mode? }
 */
const createHostelSettlement = async (req, res) => {
  try {
    const userId = req.login_data.id;
    const { hostel_id, period_from, period_to, payment_mode } = req.body;
    const from = toMysqlDate(period_from);
    const to = toMysqlDate(period_to);

    const hostel = await hostelsModel.getHostelByIdModel(req, hostel_id);
    if (!hostel) return res.status(404).json({ message: 'Hostel not found.' });

    const stays = await hostelsModel.getHostelStaysModel(req, {
      hostel_id, from_date: from, to_date: to,
    });

    const cgSet = new Set();
    let totalAmount = 0;
    let totalNights = 0;
    for (const s of stays) {
      const nights = nightsInPeriod(s, from, to);
      if (nights <= 0) continue;
      totalAmount += nights * Number(s.rate_per_day);
      totalNights += nights;
      cgSet.add(s.hp_id);
    }

    const [id] = await db('edx_hostel_settlements').insert(withOrg(req, {
      hostel_id,
      period_from: from,
      period_to: to,
      total_amount: totalAmount,
      total_nights: totalNights,
      cg_count: cgSet.size,
      status: 'Pending',
      payment_mode: payment_mode || null,
      created_by: userId,
      created_on: getCurrentDateTime(),
    }));

    res.status(201).json({ message: 'Settlement created.', id, total_amount: totalAmount });

    logAudit({
      entityType: 'HOSTEL_SETTLEMENT',
      entityId: id,
      action: 'CREATE',
      changedBy: userId,
      org_id: getOrgId(req),
      newValues: { hostel_id, period_from: from, period_to: to, total_amount: totalAmount },
    });
  } catch (err) {
    logger.error(`Error createHostelSettlement: ${err.message}`);
    res.status(500).json({ message: 'Error creating settlement.' });
  }
};

const markHostelSettlementPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.login_data.id;
    const { payment_mode } = req.body;

    const updated = await db('edx_hostel_settlements')
      .where({ id, org_id: getOrgId(req) })
      .update({
        status: 'Paid',
        paid_on: getCurrentDateTime(),
        payment_mode: payment_mode || null,
        updated_by: userId,
        updated_on: getCurrentDateTime(),
      });

    if (!updated) return res.status(404).json({ message: 'Settlement not found.' });
    res.status(200).json({ message: 'Settlement marked as paid.' });
  } catch (err) {
    logger.error(`Error markHostelSettlementPaid: ${err.message}`);
    res.status(500).json({ message: 'Error updating settlement.' });
  }
};

module.exports = guardOrgHandlers({
  getHostels,
  getHostelById,
  createHostel,
  updateHostel,
  toggleHostelStatus,
  getHostelStays,
  createHostelStay,
  closeHostelStay,
  getHostelSettlement,
  createHostelSettlement,
  markHostelSettlementPaid,
});
