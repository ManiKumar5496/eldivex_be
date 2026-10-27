const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const validate = require('../middlewares/validateRequest');
const hostelsController = require('../controllers/web_app/hostelsController');
const {
  createHostelSchema,
  updateHostelSchema,
  createStaySchema,
  closeStaySchema,
  createSettlementSchema,
} = require('../validators/hostelValidator');

// Staff-only, HP Management module (hostels, stays, settlements).
const hpModules = [auth, requireStaff, requireModule('HP Modules')];

// ── Hostels ──────────────────────────────────────────────────────────────────
router.get('/getHostels', hpModules, hostelsController.getHostels);
router.get('/getHostelById/:id', hpModules, hostelsController.getHostelById);
router.post('/createHostel', hpModules, validate(createHostelSchema), hostelsController.createHostel);
router.put('/updateHostel/:id', hpModules, validate(updateHostelSchema), hostelsController.updateHostel);
router.patch('/toggleHostelStatus/:id', hpModules, hostelsController.toggleHostelStatus);

// ── Stays ──────────────────────────────────────────────────────────────────
router.get('/getHostelStays', hpModules, hostelsController.getHostelStays);
router.post('/createHostelStay', hpModules, validate(createStaySchema), hostelsController.createHostelStay);
router.put('/closeHostelStay/:id', hpModules, validate(closeStaySchema), hostelsController.closeHostelStay);

// ── Settlements ──────────────────────────────────────────────────────────────
router.get('/getHostelSettlement', hpModules, hostelsController.getHostelSettlement);
router.post('/createHostelSettlement', hpModules, validate(createSettlementSchema), hostelsController.createHostelSettlement);
router.patch('/markHostelSettlementPaid/:id', hpModules, hostelsController.markHostelSettlementPaid);

module.exports = router;
