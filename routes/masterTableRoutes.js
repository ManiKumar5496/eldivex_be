
const express = require('express');
const router = express.Router();
const masterTables = require('../controllers/web_app/masterTableController');
const db = require('../config/db');
const upload = require('../middlewares/upload');



    router.post('/createRole', masterTables.createWebRoles);
    router.post('/createCoupon', masterTables.createCoupons);
    router.post('/addAddress', masterTables.saveAddress);
    router.post('/createBanner', upload.fields([
        { name: "banner_photo", maxCount: 1 },  
        ]),masterTables.saveBanner);
    
    router.put('/updateAddress', masterTables.updateAddress);


    router.get('/getAddress', masterTables.getAddress);
    router.get('/getRoles', masterTables.getAllRoles);
    router.get('/getCoupons', masterTables.getAllCoupons);
    router.get('/getBanners', masterTables.getAllBanners);
    router.get('/getAppModules', masterTables.getAppModules);
    router.get('/getlanguages', masterTables.getLangC) 
    router.get('/getbranches', masterTables.getBranches) 

    // ── Phase 2.5 — Services CRUD ───────────────────────────────────────────────
    router.get('/getServices',                 masterTables.getServicesList);
    router.post('/createService',              masterTables.createService);
    router.put('/updateService/:id',           masterTables.updateService);
    router.patch('/toggleServiceStatus',       masterTables.toggleServiceStatus);
    router.post('/createServiceCategory',      masterTables.createServiceCategory);
    router.put('/updateServiceCategory/:id',   masterTables.updateServiceCategory);

    // ── Phase 2.6 — Branch CRUD ─────────────────────────────────────────────────
    router.post('/createBranch',        masterTables.createBranch);
    router.put('/updateBranch/:id',     masterTables.updateBranch);
    router.patch('/toggleBranchStatus', masterTables.toggleBranchStatus);

    router.patch('/disable-banner', async (req, res) => {
        try {
          const id = req.query.id;
          const status = req.query.status;
          const userId = req.login_data.id;
          await db('tw_master_banners')
          .where({ banner_id: id })
          .update({
            banner_status:status,
            updated_on:db.fn.now(),
            updated_by:userId
          });
    
          res.status(200).json({ message: 'Disabled successfully.' });
        } catch (error) {
          res.status(500).json({ details: error.message });
        }
      });

    module.exports = router;