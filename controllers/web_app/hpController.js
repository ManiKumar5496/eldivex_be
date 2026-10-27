const hpModel = require('../../models/web_app/hpModel');
const db = require('../../config/db');
const logger = require('../../logger');
const folderMapper = require("../../utils/folderMapper");
require('dotenv').config();
const uploadHandler = require('../../middlewares/uploadHandler');
const { getCurrentDateTime } = require("../../utils/dateTime");
const withTransaction = require('../../utils/withTransaction');
const docUrl = process.env.DOC_FOLDER_URL;
const { logAudit } = require('../../utils/auditLogger'); // Phase 4.2
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope'); // Phase 5
const { checkPlanLimit } = require('../../utils/planUsage');
const { guardOrgHandlers } = require('../../utils/requestOrg');

const getHPDetails = async (req, res) =>  {
    try {
      const filters = req.query;

      const getData = await hpModel.getAllHPDetails(filters, req.login_data);
    //   console.log(getData)
      
         
      const folderName = folderMapper.fetchFolderName("hp_reg_photo");
      const folderName1 = folderMapper.fetchFolderName("hp_reg_identity_proof_front_image");
      const folderName2 = folderMapper.fetchFolderName("hp_reg_identity_proof_back_image");
      const folderName3 = folderMapper.fetchFolderName("hp_reg_education_certificate");
      
  
      // Add image path to each user
      const updatedList = getData.map(data => ({
        ...data,
        hp_reg_photo: `${docUrl}/${folderName}/${data.hp_reg_photo}` ? `${docUrl}/${folderName}/${data.hp_reg_photo}` : data.hp_reg_photo,
        hp_reg_identity_proof_front_image: `${docUrl}/${folderName1}/${data.hp_reg_identity_proof_front_image}` ? `${docUrl}/${folderName1}/${data.hp_reg_identity_proof_front_image}` : data.mobl_id_proof_certificate_front,
        hp_reg_identity_proof_back_image:  `${docUrl}/${folderName2}/${data.hp_reg_identity_proof_back_image}` ? `${docUrl}/${folderName2}/${data.hp_reg_identity_proof_back_image}` : data.mobl_id_proof_certificate_back,
        hp_reg_education_certificate: `${docUrl}/${folderName3}/${data.hp_reg_education_certificate}` ? `${docUrl}/${folderName3}/${data.hp_reg_education_certificate}` : data.mobl_education_certificate,
       
  
      }));
      res.json(updatedList);
  
    } catch (err) {
      console.error('❌ Controller error:', err.message);
      logger.error(`❌ Controller error: ${err.message}`);
      res.status(500).json({ error: 'An error occurred while fetching Data' });
    }
  };
const createHPProfile = async (req, res) => {
    try {
      const {
        hp_reg_first_name,
        hp_reg_last_name,
        hp_reg_email,
        hp_reg_phone_number,
        hp_reg_address,
        hp_reg_dob,
        hp_reg_gender,
        hp_reg_city,
        hp_reg_state,
        hp_reg_pin_code,
        hp_reg_emergency_contact_phone,
        hp_reg_languages,
        hp_reg_branch_id,
        hp_reg_marital_status,
        hp_reg_experience,
        hp_reg_father_name,
        hp_reg_father_occupation,
        hp_reg_mother_name,
        hp_reg_identity_proof_type,
        hp_reg_identity_proof_number,
        hp_reg_education,

        //hp_rate table data
        livein_pay,
        liveout_pay,
        monthly_livein_pay,
        monthly_liveout_pay,
        hp_effect_date



        
      } = req.body;
      const userId = req.login_data?.id || null;
      // console.log(req.body)
      const files = req.files;

      const limit = await checkPlanLimit(getOrgId(req), 'hp');
      if (limit) return res.status(403).json(limit);

      let hp_reg_photo_name
      let hp_reg_identity_proof_front_image_name
      let hp_reg_identity_proof_back_image_name
      let hp_reg_education_certificate_name
    
     const hpname = hp_reg_first_name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
    
      //moving photo to folder
      if(files && files['hp_reg_photo'] && files['hp_reg_photo'][0])
       {
         const filename = `${Date.now()}-${hpname}-${'photo'}`;
         const hp_reg_photo = files['hp_reg_photo'][0]
         const hp_reg_photo_type = folderMapper.fetchFolderName("hp_reg_photo");
         hp_reg_photo_name = uploadHandler.saveFile(hp_reg_photo, hp_reg_photo_type,filename)
       }

       //moving front image to folder
       if(files && files['hp_reg_identity_proof_front_image'] && files['hp_reg_identity_proof_front_image'][0])
       {
         const filename = `${Date.now()}-${hpname}-${'id-front'}`;
         const hp_reg_identity_proof_front_image = files['hp_reg_identity_proof_front_image'][0]
         const hp_reg_identity_proof_front_image_type = folderMapper.fetchFolderName("hp_reg_identity_proof_front_image");
         hp_reg_identity_proof_front_image_name = uploadHandler.saveFile(hp_reg_identity_proof_front_image, hp_reg_identity_proof_front_image_type,filename)
       }
       
       //moving back image to folder
       if(files && files['hp_reg_identity_proof_back_image'] && files['hp_reg_identity_proof_back_image'][0])
       {
         const filename = `${Date.now()}-${hpname}-${'id-back'}`;
         const hp_reg_identity_proof_back_image = files['hp_reg_identity_proof_back_image'][0]
         const hp_reg_identity_proof_back_image_type = folderMapper.fetchFolderName("hp_reg_identity_proof_back_image");
         hp_reg_identity_proof_back_image_name = uploadHandler.saveFile(hp_reg_identity_proof_back_image, hp_reg_identity_proof_back_image_type,filename)
       }
       
       //moving certificate to folder
       if(files && files['hp_reg_education_certificate'] && files['hp_reg_education_certificate'][0])
       {
         const filename = `${Date.now()}-${hpname}-${'certificate'}`;
         const hp_reg_education_certificate = files['hp_reg_education_certificate'][0]
         const hp_reg_education_certificate_type = folderMapper.fetchFolderName("hp_reg_education_certificate");
         hp_reg_education_certificate_name = uploadHandler.saveFile(hp_reg_education_certificate, hp_reg_education_certificate_type,filename)
       }
      // Insert into DB — wrapped in a transaction so both records succeed or fail together
      let hp_reg_id;
      await withTransaction(async (trx) => {
      [hp_reg_id] = await trx('edx_hp_registration').insert(withOrg(req, {
        hp_reg_first_name: hp_reg_first_name ? hp_reg_first_name : 'NA',
        hp_reg_last_name: hp_reg_last_name ? hp_reg_last_name : 'NA',
        hp_reg_email: hp_reg_email ? hp_reg_email : 'NA',
        hp_reg_phone_number: hp_reg_phone_number ? hp_reg_phone_number : 'NA',
        hp_reg_address: hp_reg_address ? hp_reg_address : 'NA',
        hp_reg_dob:hp_reg_dob?hp_reg_dob:'NA',
        hp_reg_gender:hp_reg_gender?hp_reg_gender:'NA',
        hp_reg_city:hp_reg_city?hp_reg_city:'NA',
        hp_reg_state:hp_reg_state?hp_reg_state:'NA',
        hp_reg_pin_code:hp_reg_pin_code?hp_reg_pin_code:'NA',
        hp_reg_emergency_contact_phone:hp_reg_emergency_contact_phone?hp_reg_emergency_contact_phone:'NA',
        hp_reg_languages:hp_reg_languages?hp_reg_languages:'NA',
        hp_reg_branch_id:hp_reg_branch_id?hp_reg_branch_id:'NA',
        hp_reg_marital_status:hp_reg_marital_status?hp_reg_marital_status:'NA',
        hp_reg_experience:hp_reg_experience?hp_reg_experience:'NA',
        hp_reg_father_name:hp_reg_father_name?hp_reg_father_name:'NA',
        hp_reg_father_occupation:hp_reg_father_occupation?hp_reg_father_occupation:'NA',
        hp_reg_mother_name:hp_reg_mother_name?hp_reg_mother_name:'NA',
        hp_reg_identity_proof_type:hp_reg_identity_proof_type?hp_reg_identity_proof_type:'NA',
        hp_reg_identity_proof_number:hp_reg_identity_proof_number?hp_reg_identity_proof_number:'NA',
        hp_reg_education:hp_reg_education?hp_reg_education:'NA',
        hp_reg_photo:hp_reg_photo_name?hp_reg_photo_name:'NA',
        hp_reg_identity_proof_front_image:hp_reg_identity_proof_front_image_name?hp_reg_identity_proof_front_image_name:'NA',
        hp_reg_identity_proof_back_image:hp_reg_identity_proof_back_image_name?hp_reg_identity_proof_back_image_name:'NA',
        hp_reg_education_certificate:hp_reg_education_certificate_name?hp_reg_education_certificate_name:'NA',
        created_by: userId,
        created_on: getCurrentDateTime()
      }));

      // insert hp monthly payment details
      await trx('edx_hp_rate').insert(withOrg(req, {
        hp_unique_id: hp_reg_id,
        livein_pay: livein_pay || 'NA',
        liveout_pay: liveout_pay || 'NA',
        monthly_livein_pay: monthly_livein_pay || 'NA',
        monthly_liveout_pay: monthly_liveout_pay || 'NA',
        hp_effect_date: hp_effect_date || 'NA',
        created_by: userId,
        created_on: getCurrentDateTime()
      }));
      }); // end withTransaction

      res.status(201).json({ message: 'HP Profile created successfully.' });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
      logAudit({
        entityType: 'HP',
        entityId:   hp_reg_id,
        action:     'CREATE',
        changedBy:  userId,
        org_id:     getOrgId(req),
        newValues:  { hp_reg_id, name: `${hp_reg_first_name} ${hp_reg_last_name}` },
      });

    } catch (err) {
      logger.error(`Error creating profile: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  };
  const updateHPProfile = async (req, res) => {
    try {
      const {
        hp_reg_id,
        hp_reg_first_name,
        hp_reg_last_name,
        hp_reg_email,
        hp_reg_phone_number,
        hp_reg_address,
        hp_reg_dob,
        hp_reg_gender,
        hp_reg_city,
        hp_reg_state,
        hp_reg_pin_code,
        hp_reg_emergency_contact_phone,
        hp_reg_languages,
        hp_reg_branch_id,
        hp_reg_marital_status,
        hp_reg_experience,
        hp_reg_father_name,
        hp_reg_father_occupation,
        hp_reg_mother_name,
        hp_reg_identity_proof_type,
        hp_reg_identity_proof_number,
        hp_reg_education,

        //hp_rate table data
        livein_pay,
        liveout_pay,
        monthly_livein_pay,
        monthly_liveout_pay,
        hp_effect_date
      } = req.body;
      
      const userId = req.login_data?.id || null;
      const files = req.files;
      
      // Fetch existing record to preserve current file names.
      // Org-scoped so one org can never read/target another org's HP record.
      const existingRecord = await db('edx_hp_registration')
        .where({ hp_reg_id: hp_reg_id, org_id: getOrgId(req) })
        .first();

      if (!existingRecord) {
        return res.status(404).json({ message: 'HP Profile not found.' });
      }

      // Initialize file names with existing values
      let hp_reg_photo_name = existingRecord.hp_reg_photo;
      let hp_reg_identity_proof_front_image_name = existingRecord.hp_reg_identity_proof_front_image;
      let hp_reg_identity_proof_back_image_name = existingRecord.hp_reg_identity_proof_back_image;
      let hp_reg_education_certificate_name = existingRecord.hp_reg_education_certificate;
    
      const hpname = hp_reg_first_name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
    
      // Update photo if new file is uploaded
      if (files && files['hp_reg_photo'] && files['hp_reg_photo'][0]) {
        const filename = `${Date.now()}-${hpname}-photo`;
        const hp_reg_photo = files['hp_reg_photo'][0];
        const hp_reg_photo_type = folderMapper.fetchFolderName("hp_reg_photo");
        hp_reg_photo_name = uploadHandler.saveFile(hp_reg_photo, hp_reg_photo_type, filename);
      }

      // Update front image if new file is uploaded
      if (files && files['hp_reg_identity_proof_front_image'] && files['hp_reg_identity_proof_front_image'][0]) {
        const filename = `${Date.now()}-${hpname}-id-front`;
        const hp_reg_identity_proof_front_image = files['hp_reg_identity_proof_front_image'][0];
        const hp_reg_identity_proof_front_image_type = folderMapper.fetchFolderName("hp_reg_identity_proof_front_image");
        hp_reg_identity_proof_front_image_name = uploadHandler.saveFile(hp_reg_identity_proof_front_image, hp_reg_identity_proof_front_image_type, filename);
      }
       
      // Update back image if new file is uploaded
      if (files && files['hp_reg_identity_proof_back_image'] && files['hp_reg_identity_proof_back_image'][0]) {
        const filename = `${Date.now()}-${hpname}-id-back`;
        const hp_reg_identity_proof_back_image = files['hp_reg_identity_proof_back_image'][0];
        const hp_reg_identity_proof_back_image_type = folderMapper.fetchFolderName("hp_reg_identity_proof_back_image");
        hp_reg_identity_proof_back_image_name = uploadHandler.saveFile(hp_reg_identity_proof_back_image, hp_reg_identity_proof_back_image_type, filename);
      }
       
      // Update certificate if new file is uploaded
      if (files && files['hp_reg_education_certificate'] && files['hp_reg_education_certificate'][0]) {
        const filename = `${Date.now()}-${hpname}-certificate`;
        const hp_reg_education_certificate = files['hp_reg_education_certificate'][0];
        const hp_reg_education_certificate_type = folderMapper.fetchFolderName("hp_reg_education_certificate");
        hp_reg_education_certificate_name = uploadHandler.saveFile(hp_reg_education_certificate, hp_reg_education_certificate_type, filename);
      }

      // Update record in DB
      await db('edx_hp_registration')
        .where({ hp_reg_id: hp_reg_id, org_id: getOrgId(req) })
        .update({
          hp_reg_first_name: hp_reg_first_name || 'NA',
          hp_reg_last_name: hp_reg_last_name || 'NA',
          hp_reg_email: hp_reg_email || 'NA',
          hp_reg_phone_number: hp_reg_phone_number || 'NA',
          hp_reg_address: hp_reg_address || 'NA',
          hp_reg_dob: hp_reg_dob || 'NA',
          hp_reg_gender: hp_reg_gender || 'NA',
          hp_reg_city: hp_reg_city || 'NA',
          hp_reg_state: hp_reg_state || 'NA',
          hp_reg_pin_code: hp_reg_pin_code || 'NA',
          hp_reg_emergency_contact_phone: hp_reg_emergency_contact_phone || 'NA',
          hp_reg_languages: hp_reg_languages || 'NA',
          hp_reg_branch_id: hp_reg_branch_id || 'NA',
          hp_reg_marital_status: hp_reg_marital_status || 'NA',
          hp_reg_experience: hp_reg_experience || 'NA',
          hp_reg_father_name: hp_reg_father_name || 'NA',
          hp_reg_father_occupation: hp_reg_father_occupation || 'NA',
          hp_reg_mother_name: hp_reg_mother_name || 'NA',
          hp_reg_identity_proof_type: hp_reg_identity_proof_type || 'NA',
          hp_reg_identity_proof_number: hp_reg_identity_proof_number || 'NA',
          hp_reg_education: hp_reg_education || 'NA',
          hp_reg_photo: hp_reg_photo_name,
          hp_reg_identity_proof_front_image: hp_reg_identity_proof_front_image_name,
          hp_reg_identity_proof_back_image: hp_reg_identity_proof_back_image_name,
          hp_reg_education_certificate: hp_reg_education_certificate_name,
          updated_by: userId,
          updated_on: getCurrentDateTime()
        });

      // Insert hp rate details
      await db('edx_hp_rate').insert(withOrg(req, {
        hp_unique_id: hp_reg_id,
        livein_pay: livein_pay || 'NA',
        liveout_pay: liveout_pay || 'NA',
        monthly_livein_pay: monthly_livein_pay || 'NA',
        monthly_liveout_pay: monthly_liveout_pay || 'NA',
        hp_effect_date: hp_effect_date || 'NA',
        created_by: userId,
        created_on: getCurrentDateTime()
      }));
  
      res.status(200).json({ message: 'HP Profile updated successfully.' });

      // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
      logAudit({
        entityType: 'HP',
        entityId:   hp_reg_id,
        action:     'UPDATE',
        changedBy:  userId,
        org_id:     getOrgId(req),
        newValues:  { hp_reg_id, name: `${hp_reg_first_name} ${hp_reg_last_name}` },
      });

    } catch (err) {
      logger.error(`Error updating profile: ${err.message}`);
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
};

// ── Phase 2.7 — HP Payout Tracking ───────────────────────────────────────────

/**
 * GET /api/getPendingPayouts
 * Returns all payout records with status='Pending', enriched with HP and booking info.
 */
const getPendingPayouts = async (req, res) => {
  try {
    const data = await db('edx_hp_payouts as p')
      .leftJoin('edx_hp_registration as hp', 'p.hp_unique_id', 'hp.hp_reg_id')
      .leftJoin('edx_bookings as b',          'p.booking_id',   'b.id')
      .where('p.status', 'Pending')
      .where('p.org_id', getOrgId(req))
      .select(
        'p.id',
        'p.hp_unique_id',
        'p.booking_id',
        'p.period_from',
        'p.period_to',
        'p.pay_amount',
        'p.payment_mode',
        'p.status',
        'p.created_on',
        db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''), ' ', COALESCE(hp.hp_reg_last_name,'')) as hp_name"),
        'hp.hp_reg_phone_number',
        'hp.hp_reg_branch_id'
      );

    res.json(data);
  } catch (err) {
    logger.error(`Error getPendingPayouts: ${err.message}`);
    res.status(500).json({ error: 'Error fetching pending payouts.' });
  }
};

/**
 * POST /api/createPayout
 * Body: { hp_unique_id, booking_id, period_from, period_to, pay_amount, payment_mode }
 */
const createPayout = async (req, res) => {
  try {
    const { hp_unique_id, booking_id, period_from, period_to, pay_amount, gross_pay, hostel_deduction, payment_mode = 'Cash' } = req.body;

    if (!hp_unique_id || pay_amount == null) {
      return res.status(400).json({ message: 'hp_unique_id and pay_amount are required.' });
    }

    const [id] = await db('edx_hp_payouts').insert(withOrg(req, {
      hp_unique_id,
      booking_id:   booking_id   || null,
      period_from:  period_from  || null,
      period_to:    period_to    || null,
      pay_amount:   Number(pay_amount),
      gross_pay:    gross_pay != null ? Number(gross_pay) : null,
      hostel_deduction: hostel_deduction != null ? Number(hostel_deduction) : 0,
      payment_mode,
      status:       'Pending',
      created_by:   req.login_data.id,
      created_on:   getCurrentDateTime(),
    }));

    res.status(201).json({ message: 'Payout record created.', id });
  } catch (err) {
    logger.error(`Error createPayout: ${err.message}`);
    res.status(500).json({ error: 'Error creating payout.' });
  }
};

/**
 * PATCH /api/markPayoutPaid
 * Body: { id, payment_date? }
 */
const markPayoutPaid = async (req, res) => {
  try {
    const { id, payment_date } = req.body;
    if (!id) return res.status(400).json({ message: 'id is required.' });

    const updated = await db('edx_hp_payouts')
      .where({ id, org_id: getOrgId(req) })
      .update({
        status:       'Paid',
        payment_date: payment_date || getCurrentDateTime(),
        updated_by:   req.login_data.id,
        updated_on:   getCurrentDateTime(),
      });

    if (!updated) return res.status(404).json({ message: 'Payout not found.' });
    res.json({ message: 'Payout marked as paid.' });
  } catch (err) {
    logger.error(`Error markPayoutPaid: ${err.message}`);
    res.status(500).json({ error: 'Error marking payout as paid.' });
  }
};

/**
 * GET /api/getPayoutHistory?hp_unique_id=&from_date=&to_date=
 */
const getPayoutHistory = async (req, res) => {
  try {
    const { hp_unique_id, from_date, to_date } = req.query;

    let query = db('edx_hp_payouts as p')
      .leftJoin('edx_hp_registration as hp', 'p.hp_unique_id', 'hp.hp_reg_id')
      .where('p.status', 'Paid')
      .where('p.org_id', getOrgId(req))
      .select(
        'p.*',
        db.raw("CONCAT(COALESCE(hp.hp_reg_first_name,''), ' ', COALESCE(hp.hp_reg_last_name,'')) as hp_name"),
        'hp.hp_reg_phone_number'
      )
      .orderBy('p.payment_date', 'desc');

    if (hp_unique_id) query = query.where('p.hp_unique_id', hp_unique_id);
    if (from_date)    query = query.whereRaw('p.payment_date >= ?', [from_date]);
    if (to_date)      query = query.whereRaw('p.payment_date <= ?', [to_date]);

    const data = await query;
    res.json(data);
  } catch (err) {
    logger.error(`Error getPayoutHistory: ${err.message}`);
    res.status(500).json({ error: 'Error fetching payout history.' });
  }
};

module.exports = guardOrgHandlers({
    createHPProfile,
    getHPDetails,
    updateHPProfile,
    getPendingPayouts,
    createPayout,
    markPayoutPaid,
    getPayoutHistory,
  });