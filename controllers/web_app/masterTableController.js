const getMasterData = require('../../models/web_app/masterTablesModel');
const db = require('../../config/db'); // your knex instance
const logger = require('../../logger');
const folderMapper = require("../../utils/folderMapper");
require('dotenv').config();
const uploadHandler=require('../../middlewares/uploadHandler')
const { generateToken } = require('../../utils/jwt');
const { getCurrentDateTime } = require("../../utils/dateTime");
const { logAudit } = require('../../utils/auditLogger'); // Phase 4.2
const { withOrg, getOrgId, orgQuery } = require('../../utils/orgScope');
const { guardOrgHandlers } = require('../../utils/requestOrg');


const getLangC = async (req, res) =>  {
    try {
      const Languages = await getMasterData.getLangM();
      // console.log('Fetched Languages:', Languages); // ✅ See what's returned
      res.json(Languages); // Send plain array of Languages
    } catch (err) {
      logger.error(`Error fetching role: ${err.message}`);
      console.error('❌ Controller error:', err.message);
      res.status(500).json({ error: 'An error occurred while fetching Languages' });
    }
  };

  const getBranches = async (req, res) =>  {
    try {
      const filters = { ...req.query, org_id: getOrgId(req) };
      const branches = await getMasterData.getBranchesData(filters);
      // console.log('Fetched branches:', branches); // ✅ See what's returned
      res.json(branches); // Send plain array of branches
    } catch (err) {
      logger.error(`Error fetching branches: ${err.message}`);
      console.error('❌ Controller error:', err.message);
      res.status(500).json({ error: 'An error occurred while fetching branches' });
    }
  };


  const getAppModules = async (req, res) =>  {
    try {
      const modules = await getMasterData.getModulesData();
      // console.log('Fetched modules:', modules); // ✅ See what's returned
      res.json(modules); // Send plain array of modules
    } catch (err) {
      logger.error(`Error fetching modules: ${err.message}`);
      console.error('❌ Controller error:', err.message);
      res.status(500).json({ error: 'An error occurred while fetching modules' });
    }
  };
  
  const getAllRoles = async (req, res) =>  {
    try {
      const filters = { ...req.query, org_id: getOrgId(req) };
      const roles = await getMasterData.getRolesModel(filters);
      // console.log('Fetched roles:', roles); // ✅ See what's returned
      res.json(roles); // Send plain array of roles
    } catch (err) {
      logger.error(`Error fetching role: ${err.message}`);
      console.error('❌ Controller error:', err.message);
      res.status(500).json({ error: 'An error occurred while fetching roles' });
    }
  };
  const getAllCoupons = async (req, res) =>  {
    try {
      const filters = { ...req.query, org_id: getOrgId(req) };
      const coupons = await getMasterData.getcouponsModel(filters);
      
      
      res.json(coupons); // Send plain array
    } catch (err) {
      logger.error(`Error fetching Coupons: ${err.message}`);
      console.error('❌ Controller error:', err.message);
      res.status(500).json({ error: 'An error occurred while fetching coupons' });
    }
  };
  const getAllBanners = async (req, res) =>  {
    try {
      const filters = { ...req.query, org_id: getOrgId(req) };
      const banners = await getMasterData.getbannersModel(filters);
      const docUrl = process.env.DOC_FOLDER_URL
    const folderName = folderMapper.fetchFolderName("banner_photo");

    // Add image path to each user
    const updatedData = banners.map(banner => ({
      ...banner,
      banner_photo: banner.banner_photo ? `${docUrl}/${folderName}/${banner.banner_photo}` : null
    }));
      res.json(updatedData); // Send plain array
    } catch (err) {
      logger.error(`Error fetching banners: ${err.message}`);
      console.error('❌ Controller error:', err.message);
      res.status(500).json({ error: 'An error occurred while fetching banners' });
    }
  };

  const getAddress = async (req, res) =>  {
    try {
      // org_id is taken from the authenticated token, never the client query,
      // so one tenant can never read another tenant's addresses.
      const filters = { ...req.query, org_id: getOrgId(req) };
      const getAddress = await getMasterData.getAddressModel(filters);
  
      res.json(getAddress);
    } catch (err) {
      console.error('❌ Controller error:Error fetching address', err.message);
      logger.error(`Error fetching address: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while fetching address' });
    }
  };
  const createWebRoles = async (req, res) => {
    try {
      const {
        role_name,
        access_list
  
      } = req.body;
      const userId = req.login_data.id;

      const [address_id] = await db('edx_web_emp_roles').insert(withOrg(req, {
        role_name:   role_name   || 'NA',
        access_list: access_list || 'NA',
      }));
      res.status(201).json({ message: 'Role added successfully.' });
    } catch (err) {
      logger.error(`Error adding Role: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error adding role.' });
    }
  };
  const createCoupons = async (req, res) => {
    try {
      const {
        coupon_name,
        discount_percentage,
        discount_upper_limit_value
      } = req.body;
  
      const userId = req.login_data.id;
  
      if (!coupon_name) {
        return res.status(400).json({ message: "Coupon name is required" });
      }
  
      // 🔍 Check duplicate using SAME MODEL
      // Coupon names are unique per org (migration 030), not globally.
      const existingCoupon = await getMasterData.getcouponsModel({
        coupon_name,
        org_id: getOrgId(req),
        includeInactive: true,
        checkDuplicate: true
      });
  
      if (existingCoupon) {
        return res.status(409).json({
          message: "Coupon name already exists"
        });
      }
  
      // Insert
      await db('edx_master_coupons').insert(withOrg(req, {
        coupon_name,
        discount_percentage: discount_percentage || 0,
        discount_upper_limit_value: discount_upper_limit_value || 0,
        created_by: userId,
        created_on: new Date()
      }));
  
      res.status(201).json({ message: 'Coupon added successfully.' });
  
    } catch (err) {
  
      // DB unique constraint error
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: "Coupon name already exists" });
      }
  
      logger.error(`Error adding coupon: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error adding coupon.' });
    }
  };

  const saveAddress = async (req, res) => {
    try {
      const {
      
        user_id,
        address_tag_name,
        country,
        state,
        city,
        address_line1,
        address_line2,
        landmark,
        locality,
        pincode,
  
        
      } = req.body;
      // The client must belong to the caller's org.
      const client = await db('edx_client_app_users').where({ id: user_id, org_id: getOrgId(req) }).first('id');
      if (!client) return res.status(404).json({ message: 'Client not found.' });

      const [address_id ] = await db('edx_user_address').insert(withOrg(req, {
    user_id : user_id,
    address_tag_name : address_tag_name  ? address_tag_name  : 'NA',
    country : country  ? country  : 'NA',
    state : state  ? state  : 'NA',
    city : city  ? city  : 'NA',
    address_line1 : address_line1  ? address_line1  : 'NA',
    address_line2 : address_line2  ? address_line2  : 'NA',
    landmark : landmark  ? landmark  : 'NA',
    locality : locality  ? locality  : 'NA',
    pincode : pincode  ? pincode  : 'NA',
    // created_by:userId,
    created_on: new Date()

  }));
      res.status(201).json({ message: 'Address added successfully.', address_id, id: address_id });
    } catch (err) {
      logger.error(`Error adding address: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error adding address.' });
    }
  };
  const saveBanner = async (req, res) => {
    try {
      const {
      
       
        banner_name,
        banner_description,
       
      } = req.body;
      const userId = req.login_data.id;
      const files = req.files;
    let banner_image_name
    
   const banner_image = banner_name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
  
   
// console.log(files)
   if(files && files['banner_photo'] && files['banner_photo'][0])
   {
     const filename = `${Date.now()}-${banner_image}-${'photo'}`;
     const user_image = files['banner_photo'][0]
     const user_image_type = folderMapper.fetchFolderName("banner_photo");
     banner_image_name = uploadHandler.saveFile(user_image, user_image_type,filename)
   }
  
      const [inserted_id ] = await db('edx_master_banners').insert(withOrg(req, {

    banner_name : banner_name  ? banner_name  : 'NA',
    banner_description : banner_description  ? banner_description  : 'NA',
    banner_photo : banner_image_name  ? banner_image_name  : 'NA',
    created_by:userId,
    created_on: new Date()

  }));
      res.status(201).json({ message: 'Banner added successfully.' });
    } catch (err) {
      logger.error(`Error adding Banner: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error adding Banner.' });
    }
  };

  const updateAddress = async (req, res) => {
    try {
      const {
        booking_id,
        user_id,
        address_tag_name,
        country,
        state,
        city,
        address_line1,
        address_line2,
        landmark,
        locality,
        pincode,
      } = req.body;

      if (!booking_id) {
        return res.status(400).json({ message: 'booking_id is required' });
      }

      // Insert a new address record so other bookings sharing the old address_id are unaffected
      const [newAddressId] = await db('edx_user_address').insert({
        user_id: user_id || null,
        address_tag_name: address_tag_name || 'NA',
        country:          country          || 'NA',
        state:            state            || 'NA',
        city:             city             || 'NA',
        address_line1:    address_line1    || 'NA',
        address_line2:    address_line2    || 'NA',
        landmark:         landmark         || 'NA',
        locality:         locality         || 'NA',
        pincode:          pincode          || 'NA',
        org_id:           getOrgId(req),
      });

      // Point only this booking to the new address record
      await db('edx_bookings')
        .where({ id: booking_id, org_id: getOrgId(req) })
        .update({ address_id: newAddressId });

      res.status(201).json({ message: 'Address updated successfully.', address_id: newAddressId });
    } catch (err) {
      logger.error(`Error update address: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Error update address.' });
    }
  };

  
// ── Phase 2.5 — Service CRUD ──────────────────────────────────────────────────

const createService = async (req, res) => {
  try {
    const { name, description, service_category_id, branch_id, service_type = 1, gender, care_type, service_rate, market_rate, effective_from_date } = req.body;
    if (!name) return res.status(400).json({ message: 'Service name is required.' });

    // Duplicate check scoped to this org — two tenants may use the same service name.
    const existing = await orgQuery(req, 'edx_master_services').where({ name }).first();
    if (existing) return res.status(409).json({ message: 'A service with this name already exists.' });

    const [id] = await db('edx_master_services').insert(withOrg(req, {
      name,
      description:          description          || null,
      service_category_id:  service_category_id  || null,
      branch_id:            branch_id            || null,
      service_type,
      gender:               gender               || 'Any',
      care_type:            care_type            || null,
      service_rate:         service_rate         || null,
      market_rate:          market_rate          || null,
      effective_from_date:  effective_from_date  || null,
      status: 1,
    }));
    res.status(201).json({ message: 'Service created successfully.', id });
    logAudit({ entityType: 'SERVICE', entityId: id, action: 'CREATE', changedBy: req.login_data?.id, org_id: getOrgId(req), newValues: { name, service_category_id, branch_id, service_rate, effective_from_date } });
  } catch (err) {
    logger.error(`Error creating service: ${err.message}`);
    res.status(500).json({ message: 'Error creating service.' });
  }
};

const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, service_category_id, branch_id, service_type, gender, care_type, service_rate, market_rate, effective_from_date, effective_to_date } = req.body;

    // Validate: rate change requires an effective date
    if (service_rate !== undefined) {
      const current = await db('edx_master_services').where({ id, org_id: getOrgId(req) }).select('service_rate').first();
      const rateChanged = current && String(current.service_rate ?? '') !== String(service_rate);
      if (rateChanged) {
        if (!effective_from_date) {
          return res.status(400).json({ message: 'Effective from date is required when changing the rate.' });
        }
        const today = new Date().toISOString().slice(0, 10);
        if (effective_from_date < today) {
          return res.status(400).json({ message: 'Effective from date must be today or a future date.' });
        }
      }
    }

    const payload = {};
    if (name                !== undefined) payload.name                = name;
    if (description         !== undefined) payload.description         = description || null;
    if (service_category_id !== undefined) payload.service_category_id = service_category_id;
    if (branch_id           !== undefined) payload.branch_id           = branch_id;
    if (service_type        !== undefined) payload.service_type        = service_type;
    if (gender              !== undefined) payload.gender              = gender || 'Any';
    if (care_type           !== undefined) payload.care_type           = care_type || null;
    if (service_rate        !== undefined) payload.service_rate        = service_rate || null;
    if (market_rate         !== undefined) payload.market_rate         = market_rate  || null;
    if (effective_from_date !== undefined) payload.effective_from_date = effective_from_date || null;
    if (effective_to_date   !== undefined) payload.effective_to_date   = effective_to_date   || null;

    const updated = await db('edx_master_services').where({ id, org_id: getOrgId(req) }).update(payload);
    if (!updated) return res.status(404).json({ message: 'Service not found.' });
    res.json({ message: 'Service updated successfully.' });
    logAudit({ entityType: 'SERVICE', entityId: parseInt(id), action: 'UPDATE', changedBy: req.login_data?.id, org_id: getOrgId(req), newValues: payload });
  } catch (err) {
    logger.error(`Error updating service: ${err.message}`);
    res.status(500).json({ message: 'Error updating service.' });
  }
};

const toggleServiceStatus = async (req, res) => {
  try {
    const id = req.body?.id ?? req.query.id;
    if (!id) return res.status(400).json({ message: 'id is required.' });
    const svc = await db('edx_master_services').where({ id, org_id: getOrgId(req) }).select('status').first();
    if (!svc) return res.status(404).json({ message: 'Service not found.' });
    const newStatus = svc.status === 1 ? 0 : 1;
    await db('edx_master_services').where({ id, org_id: getOrgId(req) }).update({ status: newStatus });
    res.json({ message: `Service ${newStatus === 1 ? 'enabled' : 'disabled'} successfully.`, status: newStatus });
    logAudit({ entityType: 'SERVICE', entityId: parseInt(id), action: 'STATUS_CHANGE', changedBy: req.login_data?.id, org_id: getOrgId(req), oldValues: { status: svc.status }, newValues: { status: newStatus } });
  } catch (err) {
    logger.error(`Error toggling service status: ${err.message}`);
    res.status(500).json({ message: 'Error toggling service status.' });
  }
};

// Service categories are per-org "products" (e.g. Caregiving, Nursing, Baby
// Care). Every read/write is scoped to the caller's org so one tenant never
// sees or mutates another tenant's catalogue.
const getServiceCategories = async (req, res) => {
  try {
    // Admin management list — include inactive so they can be re-enabled.
    const rows = await orgQuery(req, 'edx_master_services_category')
      .select('id', db.raw('name as cat_name'), 'status')
      .orderBy('id', 'desc');
    res.json(rows);
  } catch (err) {
    logger.error(`Error fetching service categories: ${err.message}`);
    res.status(500).json({ message: 'Error fetching service categories.' });
  }
};

const createServiceCategory = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Category name is required.' });

    // Reject duplicates within the same org (case-insensitive).
    const existing = await orgQuery(req, 'edx_master_services_category')
      .whereRaw('LOWER(name) = ?', [name.toLowerCase()])
      .first();
    if (existing) return res.status(409).json({ message: 'Category already exists.' });

    const [id] = await db('edx_master_services_category').insert(withOrg(req, { name, status: 1 }));
    res.status(201).json({ message: 'Service category created.', id });
  } catch (err) {
    logger.error(`Error creating service category: ${err.message}`);
    res.status(500).json({ message: 'Error creating service category.' });
  }
};

const updateServiceCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Category name is required.' });

    const updated = await orgQuery(req, 'edx_master_services_category')
      .where({ id })
      .update({ name });
    if (!updated) return res.status(404).json({ message: 'Category not found.' });
    res.json({ message: 'Service category updated.' });
  } catch (err) {
    logger.error(`Error updating service category: ${err.message}`);
    res.status(500).json({ message: 'Error updating service category.' });
  }
};

const toggleServiceCategoryStatus = async (req, res) => {
  try {
    const { id, status } = req.query;
    const newStatus = Number(status) === 1 ? 1 : 0;
    const updated = await orgQuery(req, 'edx_master_services_category')
      .where({ id })
      .update({ status: newStatus });
    if (!updated) return res.status(404).json({ message: 'Category not found.' });
    res.json({ message: 'Status updated.' });
  } catch (err) {
    logger.error(`Error toggling service category status: ${err.message}`);
    res.status(500).json({ message: 'Error updating status.' });
  }
};

// ── Phase 2.6 — Branch CRUD ───────────────────────────────────────────────────

const createBranch = async (req, res) => {
  try {
    const { br_name, br_phone, br_email, br_address, br_city, br_state } = req.body;
    if (!br_name) return res.status(400).json({ message: 'Branch name is required.' });
    const [id] = await db('edx_branches').insert(withOrg(req, {
      br_name,
      br_phone:   br_phone   || null,
      br_email:   br_email   || null,
      br_address: br_address || null,
      br_city:    br_city    || null,
      br_state:   br_state   || null,
      br_status:  1,
    }));
    res.status(201).json({ message: 'Branch created successfully.', id });
    logAudit({ entityType: 'BRANCH', entityId: id, action: 'CREATE', changedBy: req.login_data?.id, org_id: getOrgId(req), newValues: { br_name, br_phone, br_email, br_address, br_city, br_state } });
  } catch (err) {
    logger.error(`Error creating branch: ${err.message}`);
    res.status(500).json({ message: 'Error creating branch.' });
  }
};

const updateBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const { br_name, br_phone, br_email, br_address, br_city, br_state } = req.body;
    const payload = {};
    if (br_name    !== undefined) payload.br_name    = br_name;
    if (br_phone   !== undefined) payload.br_phone   = br_phone;
    if (br_email   !== undefined) payload.br_email   = br_email;
    if (br_address !== undefined) payload.br_address = br_address;
    if (br_city    !== undefined) payload.br_city    = br_city;
    if (br_state   !== undefined) payload.br_state   = br_state;
    const updated = await db('edx_branches').where({ br_id: id, org_id: getOrgId(req) }).update(payload);
    if (!updated) return res.status(404).json({ message: 'Branch not found.' });
    res.json({ message: 'Branch updated successfully.' });
    logAudit({ entityType: 'BRANCH', entityId: parseInt(id), action: 'UPDATE', changedBy: req.login_data?.id, org_id: getOrgId(req), newValues: payload });
  } catch (err) {
    logger.error(`Error updating branch: ${err.message}`);
    res.status(500).json({ message: 'Error updating branch.' });
  }
};

const toggleBranchStatus = async (req, res) => {
  try {
    const id = req.body?.id ?? req.query.id;
    if (!id) return res.status(400).json({ message: 'id is required.' });
    const branch = await db('edx_branches').where({ br_id: id, org_id: getOrgId(req) }).select('br_status').first();
    if (!branch) return res.status(404).json({ message: 'Branch not found.' });
    const newStatus = branch.br_status === 1 ? 0 : 1;
    await db('edx_branches').where({ br_id: id, org_id: getOrgId(req) }).update({ br_status: newStatus });
    res.json({ message: `Branch ${newStatus === 1 ? 'enabled' : 'disabled'} successfully.`, status: newStatus });
    logAudit({ entityType: 'BRANCH', entityId: parseInt(id), action: 'STATUS_CHANGE', changedBy: req.login_data?.id, org_id: getOrgId(req), oldValues: { br_status: branch.br_status }, newValues: { br_status: newStatus } });
  } catch (err) {
    logger.error(`Error toggling branch status: ${err.message}`);
    res.status(500).json({ message: 'Error toggling branch status.' });
  }
};

const getServicesList = async (req, res) => {
  try {
    const orgId    = getOrgId(req);
    const branchId = req.query.branch_id;

    let query = db('edx_master_services as s')
      .select(
        's.id', 's.name', 's.description', 's.service_type', 's.gender', 's.care_type',
        's.service_category_id', 's.branch_id', 's.status',
        's.service_rate', 's.effective_from_date', 's.effective_to_date',
        db.raw('c.name as category_name'),
        db.raw('b.br_name as br_name'),
      )
      .leftJoin('edx_master_services_category as c', 's.service_category_id', 'c.id')
      .leftJoin('edx_branches as b', 's.branch_id', 'b.br_id')
      .where('s.org_id', orgId);

    if (branchId) query = query.where('s.branch_id', branchId);

    const services = await query.orderBy('s.id', 'asc');
    res.json(services);
  } catch (err) {
    logger.error(`Error fetching services list: ${err.message}`);
    res.status(500).json({ message: 'Error fetching services list.' });
  }
};

module.exports = guardOrgHandlers({
    getAddress,
    getLangC,
    createWebRoles,
    getAllRoles,
    saveAddress,
    getAppModules,
    getBranches,
    updateAddress,
    createCoupons,
    getAllCoupons,
    saveBanner,
    getAllBanners,
    // Phase 2.5
    getServicesList,
    createService,
    updateService,
    toggleServiceStatus,
    getServiceCategories,
    createServiceCategory,
    updateServiceCategory,
    toggleServiceCategoryStatus,
    // Phase 2.6
    createBranch,
    updateBranch,
    toggleBranchStatus,
  });
