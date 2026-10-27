const express = require('express');
const router  = express.Router();
const supportController = require('../controllers/web_app/supportController');
const auth   = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const validate = require('../middlewares/validateRequest');
const { createSupportTicketSchema } = require('../validators/supportValidator');
const db = require('../config/db');
const logger = require('../logger');
const { getOrgId } = require('../utils/orgScope');
const { logAudit } = require('../utils/auditLogger'); // Phase 4.2
const { notifyOrgAdmins } = require('../utils/notify');

// Staff-only: Support Ticket module, or Bookings (tickets are raised from bookings).
const support = [auth, requireStaff, requireModule('Support Ticket', 'Bookings')];

router.post('/createSupportTicket', support, validate(createSupportTicketSchema), supportController.createSupportTicket);
router.get('/getSupportTickets',    support, supportController.getSupportTickets);
router.get('/getSupportCategory',   supportController.getSupportCategory);  // public — used in forms before login
router.get('/getSupportStats',      support, supportController.getSupportStats);

router.patch('/updateSupportStatus', support, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { status, comments } = req.query;
    const id = parseInt(req.query.id, 10);
    if (!Number.isInteger(id) || status === undefined || status === '') {
      return res.status(400).json({ message: 'id and status are required.' });
    }
    const userId = req.login_data?.id || null;

    const updated = await db('edx_support_requests')
      .where({ id, org_id: orgId })
      .update({
        comments,
        status,
        updated_by: userId,
        updated_on: db.fn.now(),
      });
    if (!updated) return res.status(404).json({ message: 'Ticket not found.' });

    res.status(200).json({ message: 'Status updated successfully.' });

    // ── Audit log (Phase 4.2, fire-and-forget) ────────────────────────────
    logAudit({
      entityType: 'SUPPORT_TICKET',
      entityId:   id,
      action:     'STATUS_CHANGE',
      changedBy:  userId,
      org_id:     orgId,
      newValues:  { status, comments },
    });

    notifyOrgAdmins(orgId, {
      type:  'support',
      title: `Ticket #${id} ${String(status) === '1' ? 'reopened' : 'closed'}`,
      body:  comments && comments !== 'NA' ? comments : 'Support ticket status updated.',
      data:  { ticket_id: id, route: 'support' },
    });
  } catch (error) {
    logger.error(`[supportRoutes] updateSupportStatus error: ${error.message}`);
    res.status(500).json({ message: 'Failed to update ticket status.' });
  }
});

module.exports = router;
