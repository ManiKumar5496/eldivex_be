const express = require('express');
const router = express.Router();
const masterServicesController = require('../controllers/client_app/masterServicesController');

// Public — org comes from the token when present, else ?org_id / ?org_code.
router.get('/masterServices', masterServicesController.getAllServices);
router.get('/masterServicesTypes', masterServicesController.getAllServicesTypes);

module.exports = router;
