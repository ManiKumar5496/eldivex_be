const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const validate = require('../middlewares/validateRequest');
const hostelsController = require('../controllers/web_app/hostelsController');
const {
  createHostelSchema,
  updateHostelSchema,
  createStaySchema,
  closeStaySchema,
  createSettlementSchema,
} = require('../validators/hostelValidator');

// ── Hostels ──────────────────────────────────────────────────────────────────
router.get('/getHostels', auth, hostelsController.getHostels);
router.get('/getHostelById/:id', auth, hostelsController.getHostelById);
router.post('/createHostel', auth, validate(createHostelSchema), hostelsController.createHostel);
router.put('/updateHostel/:id', auth, validate(updateHostelSchema), hostelsController.updateHostel);
router.patch('/toggleHostelStatus/:id', auth, hostelsController.toggleHostelStatus);

// ── Stays ──────────────────────────────────────────────────────────────────
router.get('/getHostelStays', auth, hostelsController.getHostelStays);
router.post('/createHostelStay', auth, validate(createStaySchema), hostelsController.createHostelStay);
router.put('/closeHostelStay/:id', auth, validate(closeStaySchema), hostelsController.closeHostelStay);

// ── Settlements ──────────────────────────────────────────────────────────────
router.get('/getHostelSettlement', auth, hostelsController.getHostelSettlement);
router.post('/createHostelSettlement', auth, validate(createSettlementSchema), hostelsController.createHostelSettlement);
router.patch('/markHostelSettlementPaid/:id', auth, hostelsController.markHostelSettlementPaid);

module.exports = router;
