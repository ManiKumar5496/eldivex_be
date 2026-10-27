const express = require('express');
const router = express.Router();
const hpController = require('../controllers/web_app/hpController');
const upload = require('../middlewares/upload');
const db = require('../config/db');
const auth = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const logger = require('../logger');
const { getOrgId } = require('../utils/orgScope');
const { logAudit } = require('../utils/auditLogger'); // Phase 4.2

// Staff-only, HP Management module. The HP list is also read by the
// Bookings → Assign CG dialog.
const hpModules = [auth, requireStaff, requireModule('HP Modules')];
const hpRead    = [auth, requireStaff, requireModule('HP Modules', 'Bookings')];

const hpFiles = upload.fields([
  { name: "hp_reg_photo", maxCount: 1 },
  { name: "hp_reg_identity_proof_front_image", maxCount: 1 },
  { name: "hp_reg_identity_proof_back_image", maxCount: 1 },
  { name: "hp_reg_education_certificate", maxCount: 1 },
]);

router.post('/createHPProfile', hpModules, hpFiles, hpController.createHPProfile);
router.put('/updateHPProfile',  hpModules, hpFiles, hpController.updateHPProfile);
router.get('/getHPDetails',     hpRead, hpController.getHPDetails);

router.patch('/updateHPStatus', hpModules, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const id = parseInt(req.query.id, 10);
    const status = req.query.status;
    if (!Number.isInteger(id) || status === undefined || status === '') {
      return res.status(400).json({ message: 'id and status are required.' });
    }
    const userId = req.login_data?.id || null;

    const updated = await db('edx_hp_registration')
      .where({ hp_reg_id: id, org_id: orgId })
      .update({
        hp_reg_status: status,
        updated_on: db.fn.now(),
        updated_by: userId
      });
    if (!updated) return res.status(404).json({ message: 'HP not found.' });

    res.status(200).json({ message: 'Status updated successfully.' });

    // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────
    logAudit({
      entityType: 'HP',
      entityId:   id,
      action:     'STATUS_CHANGE',
      changedBy:  userId,
      org_id:     orgId,
      newValues:  { hp_reg_status: status },
    });
  } catch (error) {
    logger.error(`[hpRoutes] updateHPStatus error: ${error.message}`);
    res.status(500).json({ message: 'Failed to update status.' });
  }
});


// ── Phase 2.7 — HP Payout routes ──────────────────────────────────────────────
router.get('/getPendingPayouts',    hpModules, hpController.getPendingPayouts);
router.post('/createPayout',        hpModules, hpController.createPayout);
router.patch('/markPayoutPaid',     hpModules, hpController.markPayoutPaid);
router.get('/getPayoutHistory',     hpModules, hpController.getPayoutHistory);

module.exports = router;
