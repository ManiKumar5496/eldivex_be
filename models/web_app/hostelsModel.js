/**
 * hostelsModel.js — Knex query helpers for the Hostel module.
 *
 * Every query is org-scoped: the caller passes req so getOrgId(req) bounds the
 * rows. Branch-level access is layered on top via applyBranchFilter.
 */
const db = require('../../config/db');
const applyBranchFilter = require('../../utils/applyBranchFilter');
const { getOrgId } = require('../../utils/orgScope');

// ── Hostels ────────────────────────────────────────────────────────────────
function getHostelsModel(req, filters = {}) {
  const { branch_id, gender, search } = filters;

  let query = db('edx_hostels as h')
    .leftJoin('edx_branches as b', 'b.br_id', 'h.branch_id')
    .where('h.org_id', getOrgId(req))
    .where('h.status', 1)
    .select('h.*', 'b.br_name as branch_name');

  query = applyBranchFilter(query, req.login_data, 'h.branch_id');

  if (branch_id) query = query.where('h.branch_id', branch_id);
  if (gender)    query = query.where('h.gender', gender);
  if (search)    query = query.whereRaw('h.hostel_name LIKE ?', [`%${search}%`]);

  return query.orderBy('h.hostel_name', 'asc');
}

function getHostelByIdModel(req, hostelId) {
  return db('edx_hostels')
    .where({ id: hostelId, org_id: getOrgId(req) })
    .first();
}

// ── Stays ──────────────────────────────────────────────────────────────────
/**
 * List stays, optionally filtered by hostel / hp / date overlap with a period.
 * A stay overlaps [from,to] when check_in <= to AND (check_out IS NULL OR check_out >= from).
 */
function getHostelStaysModel(req, filters = {}) {
  const { hostel_id, hp_id, from_date, to_date, status } = filters;

  let query = db('edx_hostel_stays as s')
    .leftJoin('edx_hostels as h', 'h.id', 's.hostel_id')
    .leftJoin('edx_hp_registration as hp', 'hp.hp_reg_id', 's.hp_id')
    .where('s.org_id', getOrgId(req))
    .select(
      's.*',
      'h.hostel_name',
      'h.gender as hostel_gender',
      db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''), ' ', COALESCE(hp.hp_reg_last_name,'')) as hp_name"),
      'hp.hp_reg_phone_number',
      'hp.hp_reg_gender'
    );

  if (hostel_id) query = query.where('s.hostel_id', hostel_id);
  if (hp_id)     query = query.where('s.hp_id', hp_id);
  if (status)    query = query.where('s.status', status);
  if (to_date)   query = query.whereRaw('s.check_in_date <= ?', [to_date]);
  if (from_date) query = query.whereRaw('(s.check_out_date IS NULL OR s.check_out_date >= ?)', [from_date]);

  return query.orderBy('s.check_in_date', 'desc');
}

function getStayByIdModel(req, stayId) {
  return db('edx_hostel_stays')
    .where({ id: stayId, org_id: getOrgId(req) })
    .first();
}

/**
 * Count currently-active stays at a hostel (used for capacity gate).
 */
async function countActiveStaysModel(req, hostelId) {
  const row = await db('edx_hostel_stays')
    .where({ hostel_id: hostelId, org_id: getOrgId(req), status: 'active' })
    .count({ c: 'id' })
    .first();
  return Number(row?.c || 0);
}

/**
 * Find an open or date-overlapping stay for a CG (used for overlap gate).
 */
function findOverlappingStayModel(req, hpId, checkIn) {
  return db('edx_hostel_stays')
    .where({ hp_id: hpId, org_id: getOrgId(req) })
    .where('status', 'active')
    .whereRaw('(check_out_date IS NULL OR check_out_date >= ?)', [checkIn])
    .first();
}

module.exports = {
  getHostelsModel,
  getHostelByIdModel,
  getHostelStaysModel,
  getStayByIdModel,
  countActiveStaysModel,
  findOverlappingStayModel,
};
