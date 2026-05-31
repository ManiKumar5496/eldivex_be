const masterServicesModel = require('../../models/client_app/masterServicesModel');
const db = require('../../config/db'); // your knex instance
const logger = require('../../logger');
const folderMapper = require("../../utils/folderMapper");
require('dotenv').config();
const uploadHandler=require('../../middlewares/uploadHandler')


const getAllServices = async (req, res) =>  {
    try {
      const filters = req.query;
      // console.log(filters)
      const services = await masterServicesModel.getServices(filters);
  
      res.json(services);
    } catch (err) {
      console.error('❌ Controller error:', err.message);
      logger.error(`An error occurred while fetching Services Category: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while fetching Services Category' });
    }
  };
const getAllServicesTypes = async (req, res) =>  {
    try {
      const filters = req.query;
      // console.log(filters)
      const servicestypes = await masterServicesModel.getServicesTypes(filters);
  
      res.json(servicestypes);
    } catch (err) {
      console.error('❌ Controller error:An error occurred while fetching Services Category', err.message);
      logger.error(`An error occurred while fetching Services Category types: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while fetching Services Category types' });
    }
  };


  module.exports = {
    getAllServicesTypes,
    getAllServices
  };