const masterServicesModel = require('../../models/client_app/masterServicesModel');
const db = require('../../config/db'); // your knex instance
const logger = require('../../logger');
const folderMapper = require("../../utils/folderMapper");
const jwt = require('jsonwebtoken');
const { resolveOrgId } = require('../../utils/orgCode');
require('dotenv').config();
const uploadHandler=require('../../middlewares/uploadHandler')

// These endpoints are mounted without a fixed auth middleware because they are
// shared by the admin app (admin JWT), the client app (client JWT) and the
// caregiver portal (caregiver JWT) — all of which carry org_id. Resolve the
// caller's org from whichever token is present, falling back to an explicit
// org_id/org_code query param. Without an org we refuse rather than leak every
// tenant's catalogue.
async function resolveRequestOrgId(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_TOKEN_KEY);
      if (decoded.org_id != null) return Number(decoded.org_id);
    } catch (_) { /* fall through to query param */ }
  }
  if (req.query.org_id != null || req.query.org_code != null) {
    return await resolveOrgId(db, req.query.org_id ?? req.query.org_code);
  }
  return null;
}

const getAllServices = async (req, res) =>  {
    try {
      const orgId = await resolveRequestOrgId(req);
      if (!orgId) {
        return res.status(400).json({ error: 'org context is required' });
      }
      const services = await masterServicesModel.getServices({ ...req.query, org_id: orgId });

      res.json(services);
    } catch (err) {
      console.error('❌ Controller error:', err.message);
      logger.error(`An error occurred while fetching Services Category: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while fetching Services Category' });
    }
  };
const getAllServicesTypes = async (req, res) =>  {
    try {
      const orgId = await resolveRequestOrgId(req);
      if (!orgId) {
        return res.status(400).json({ error: 'org context is required' });
      }
      const servicestypes = await masterServicesModel.getServicesTypes({ ...req.query, org_id: orgId });

      res.json(servicestypes);
    } catch (err) {
      console.error('❌ Controller error:An error occurred while fetching Services Category', err.message);
      logger.error(`An error occurred while fetching Services Category types: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while fetching Services Category types' });
    }
  };


  module.exports = {
    getAllServicesTypes,
    getAllServices
  };
