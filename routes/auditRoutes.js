/**
 * auditRoutes.js — Phase 4.2
 *
 * GET /api/getAuditTrail?entity_type=BOOKING&entity_id=42&page=1
 *
 * Pagination: 50 rows per page, newest-first.
 * Staff-only (Settings module); org from the JWT.
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const requireOwner  = require('../middlewares/requireOwner');
const db      = require('../config/db');
const logger  = require('../logger');
const { getOrgId } = require('../utils/orgScope');

router.get('/getAuditTrail', auth, requireStaff, requireModule('Settings'), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Invalid token for this endpoint' });
    const { entity_type, entity_id } = req.query;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 50;
    const offset = (page - 1) * limit;

    let query = db('edx_audit_log')
      .where('org_id', orgId)
      .orderBy('created_on', 'desc');
    if (entity_type) query = query.where({ entity_type });
    if (entity_id)   query = query.where({ entity_id: parseInt(entity_id, 10) || 0 });

    const [rows, countResult] = await Promise.all([
      query.clone().limit(limit).offset(offset),
      query.clone().count('* as total').first(),
    ]);

    res.json({
      data:  rows,
      total: Number(countResult?.total ?? 0),
      page,
      limit,
    });
  } catch (error) {
    logger.error('[auditRoutes] getAuditTrail error:', error);
    res.status(500).json({ message: 'Failed to fetch audit trail.' });
  }
});

/**
 * GET /api/saas/getOwnerAuditTrail — owner only, cross-org.
 * Filters: org_id, entity_type, action, from, to (created_on date range), page.
 */
router.get('/saas/getOwnerAuditTrail', auth, requireOwner, async (req, res) => {
  try {
    const { org_id, entity_type, action, from, to } = req.query;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 50;
    const offset = (page - 1) * limit;

    let query = db('edx_audit_log as a')
      .leftJoin('edx_organizations as o', 'a.org_id', 'o.id')
      .orderBy('a.created_on', 'desc');

    if (org_id)      query = query.where('a.org_id', parseInt(org_id));
    if (entity_type) query = query.where('a.entity_type', entity_type);
    if (action)      query = query.where('a.action', action);
    if (from)        query = query.where('a.created_on', '>=', from);
    if (to)          query = query.where('a.created_on', '<=', `${to} 23:59:59`);

    const [rows, countResult] = await Promise.all([
      query.clone()
        .select('a.*', 'o.name as org_name')
        .limit(limit)
        .offset(offset),
      query.clone().clearSelect().clearOrder().count('* as total').first(),
    ]);

    res.json({
      data:  rows,
      total: Number(countResult?.total ?? 0),
      page,
      limit,
    });
  } catch (error) {
    logger.error('[auditRoutes] getOwnerAuditTrail error:', error);
    res.status(500).json({ message: 'Failed to fetch audit trail.' });
  }
});

module.exports = router;
