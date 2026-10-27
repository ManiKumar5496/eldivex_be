/**
 * orgProfileRoutes.js — Settings → Organisation Profile
 * Org-admin management of the org's own branding & billing identity.
 * Staff-only; scoping comes from the token. Reads are open to all staff
 * (branding is used app-wide); edits need the Settings module.
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const orgProfile = require('../controllers/web_app/orgProfileController');

router.get('/orgProfile',               auth, requireStaff, orgProfile.getOrgProfile);
router.put('/orgProfile',               auth, requireStaff, requireModule('Settings'), orgProfile.updateOrgProfile);
router.post('/orgProfile/emailPreview', auth, requireStaff, requireModule('Settings'), orgProfile.previewEmails);

module.exports = router;
