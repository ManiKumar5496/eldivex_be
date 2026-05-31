const express = require('express');
const router = express.Router();
const hpController = require('../controllers/web_app/hpController');
const upload = require('../middlewares/upload');
const db = require('../config/db');
const auth = require('../middlewares/auth');
const { logAudit } = require('../utils/auditLogger'); // Phase 4.2

router.post('/createHPProfile', auth, upload.fields([
    { name: "hp_reg_photo", maxCount: 1 },  
    { name: "hp_reg_identity_proof_front_image", maxCount: 1 },  
    { name: "hp_reg_identity_proof_back_image", maxCount: 1 },  
    { name: "hp_reg_education_certificate", maxCount: 1 },  
    ]),hpController.createHPProfile);
    router.put('/updateHPProfile', upload.fields([
        { name: "hp_reg_photo", maxCount: 1 },  
        { name: "hp_reg_identity_proof_front_image", maxCount: 1 },  
        { name: "hp_reg_identity_proof_back_image", maxCount: 1 },  
        { name: "hp_reg_education_certificate", maxCount: 1 },  
        ]),hpController.updateHPProfile);
router.get('/getHPDetails', auth, hpController.getHPDetails);
router.patch('/updateHPStatus', auth, async (req, res) => {
    try {
      const id = req.query.id;
      const status = req.query.status;
      const userId = req.login_data?.id || null;
      await db('edx_hp_registration')
      .where({ hp_reg_id: id })
      .where('org_id', req.login_data?.org_id ?? 1)
      .update({
        hp_reg_status: status,
        updated_on: db.fn.now(),
        updated_by: userId
      });
      res.status(200).json({ message: 'Status updated successfully.' });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────
      logAudit({
        entityType: 'HP',
        entityId:   parseInt(id),
        action:     'STATUS_CHANGE',
        changedBy:  userId,
        org_id:     req.login_data?.org_id ?? 1,
        newValues:  { hp_reg_status: status },
      });
    } catch (error) {
      res.status(500).json({ details: error.message });
    }
  });


// ── Phase 2.7 — HP Payout routes ──────────────────────────────────────────────
router.get('/getPendingPayouts',    auth, hpController.getPendingPayouts);
router.post('/createPayout',        auth, hpController.createPayout);
router.patch('/markPayoutPaid',     auth, hpController.markPayoutPaid);
router.get('/getPayoutHistory',     auth, hpController.getPayoutHistory);

module.exports = router;