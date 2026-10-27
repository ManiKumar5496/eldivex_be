const express = require('express');
const router = express.Router();
const masterTables = require('../controllers/web_app/masterTableController');
const db = require('../config/db');
const upload = require('../middlewares/upload');
const auth = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const logger = require('../logger');
const { getOrgId } = require('../utils/orgScope');

// Lookups every staff screen needs (role access, dropdowns) → any staff.
// Writes are gated by the screen that owns them.
const staff     = [auth, requireStaff];
const settings  = [auth, requireStaff, requireModule('Settings')];
const clientOps = [auth, requireStaff, requireModule('Users', 'Bookings')];

router.post('/createRole',   settings, masterTables.createWebRoles);
router.post('/createCoupon', settings, masterTables.createCoupons);
router.post('/addAddress',   clientOps, masterTables.saveAddress);
router.post('/createBanner', settings, upload.fields([
  { name: "banner_photo", maxCount: 1 },
]), masterTables.saveBanner);

router.put('/updateAddress', clientOps, masterTables.updateAddress);

router.get('/getAddress',    staff, masterTables.getAddress);
router.get('/getRoles',      staff, masterTables.getAllRoles);
router.get('/getCoupons',    staff, masterTables.getAllCoupons);
router.get('/getBanners',    staff, masterTables.getAllBanners);
router.get('/getAppModules', staff, masterTables.getAppModules);
router.get('/getlanguages',  staff, masterTables.getLangC);
router.get('/getbranches',   staff, masterTables.getBranches);

// ── Phase 2.5 — Services CRUD ───────────────────────────────────────────────
router.get('/getServices',                   staff,    masterTables.getServicesList);
router.post('/createService',                settings, masterTables.createService);
router.put('/updateService/:id',             settings, masterTables.updateService);
router.patch('/toggleServiceStatus',         settings, masterTables.toggleServiceStatus);
router.get('/getServiceCategories',          staff,    masterTables.getServiceCategories);
router.post('/createServiceCategory',        settings, masterTables.createServiceCategory);
router.put('/updateServiceCategory/:id',     settings, masterTables.updateServiceCategory);
router.patch('/toggleServiceCategoryStatus', settings, masterTables.toggleServiceCategoryStatus);

// ── Phase 2.6 — Branch CRUD ─────────────────────────────────────────────────
router.post('/createBranch',        settings, masterTables.createBranch);
router.put('/updateBranch/:id',     settings, masterTables.updateBranch);
router.patch('/toggleBranchStatus', settings, masterTables.toggleBranchStatus);

router.patch('/disable-banner', settings, async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    const status = req.query.status;
    if (!Number.isInteger(id) || status === undefined || status === '') {
      return res.status(400).json({ message: 'id and status are required.' });
    }

    const updated = await db('edx_master_banners')
      .where({ banner_id: id, org_id: getOrgId(req) })
      .update({
        banner_status: status,
        updated_on: db.fn.now(),
        updated_by: req.login_data.id,
      });
    if (!updated) return res.status(404).json({ message: 'Banner not found.' });

    res.status(200).json({ message: 'Disabled successfully.' });
  } catch (error) {
    logger.error(`[masterTableRoutes] disable-banner error: ${error.message}`);
    res.status(500).json({ message: 'Failed to update banner.' });
  }
});

module.exports = router;
