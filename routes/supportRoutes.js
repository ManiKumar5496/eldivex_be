const express = require('express');
const router  = express.Router();
const supportController = require('../controllers/web_app/supportController');
const auth   = require('../middlewares/auth');
const validate = require('../middlewares/validateRequest');
const { createSupportTicketSchema } = require('../validators/supportValidator');
const db = require('../config/db');
const { logAudit } = require('../utils/auditLogger'); // Phase 4.2

router.post('/createSupportTicket', auth, validate(createSupportTicketSchema), supportController.createSupportTicket);
router.get('/getSupportTickets',    auth, supportController.getSupportTickets);
router.get('/getSupportCategory',        supportController.getSupportCategory);  // public — used in forms before login
router.get('/getSupportStats',      auth, supportController.getSupportStats);

router.patch('/updateSupportStatus', auth, async (req, res) => {
  try {
    const { id, status, comments } = req.query;
    const userId = req.login_data?.id || null;

    await db('edx_support_requests')
      .where({ id })
      .where('org_id', req.login_data?.org_id ?? 1)
      .update({
        comments,
        status,
        updated_by: userId,
        updated_on: db.fn.now(),
      });

    res.status(200).json({ message: 'Status updated successfully.' });

    // ── Audit log (Phase 4.2, fire-and-forget) ────────────────────────────
    logAudit({
      entityType: 'SUPPORT_TICKET',
      entityId:   parseInt(id),
      action:     'STATUS_CHANGE',
      changedBy:  userId,
      org_id:     req.login_data?.org_id ?? 1,
      newValues:  { status, comments },
    });
  } catch (error) {
    res.status(500).json({ details: error.message });
  }
});

module.exports = router;
