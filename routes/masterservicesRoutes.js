const express = require('express');
const router = express.Router();
const masterServicesController = require('../controllers/client_app/masterServicesController');
const upload = require('../middlewares/upload');
const db = require('../config/db');

router.get('/masterServices', masterServicesController.getAllServices);
router.get('/masterServicesTypes', masterServicesController.getAllServicesTypes);

module.exports = router;
