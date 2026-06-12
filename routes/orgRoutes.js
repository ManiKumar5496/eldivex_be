/**
 * orgRoutes.js — Phase 5.4
 * All routes require owner access (is_owner JWT claim from /ownerLogin).
 */

const express        = require('express');
const router         = express.Router();
const auth           = require('../middlewares/auth');
const requireOwner   = require('../middlewares/requireOwner');
const orgController  = require('../controllers/web_app/orgController');

router.get('/getOrganisations',         auth, requireOwner, orgController.getOrganisations);
router.post('/createOrganisation',      auth, requireOwner, orgController.createOrganisation);
router.put('/updateOrganisation/:id',   auth, requireOwner, orgController.updateOrganisation);
router.get('/getOrgDetails',            auth, requireOwner, orgController.getOrgDetails);

module.exports = router;
