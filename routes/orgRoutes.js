/**
 * orgRoutes.js — Phase 5.4
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const orgController = require('../controllers/web_app/orgController');

router.get('/getOrganisations',         auth, orgController.getOrganisations);
router.post('/createOrganisation',      auth, orgController.createOrganisation);
router.put('/updateOrganisation/:id',   auth, orgController.updateOrganisation);
router.get('/getOrgDetails',            auth, orgController.getOrgDetails);

module.exports = router;
