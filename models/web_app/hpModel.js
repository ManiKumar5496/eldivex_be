const db = require('../../config/db');


async function getAllHPDetails (filters = {}, login_data)
{
   const { hp_reg_id } = filters;
   const orgId = login_data && login_data.is_owner !== true ? login_data.org_id ?? -1 : -1;

 let query = db('edx_hp_registration')
   .select('edx_hp_rate.livein_pay',
   'edx_hp_rate.liveout_pay',
   'edx_hp_rate.monthly_livein_pay',
   'edx_hp_rate.monthly_liveout_pay',
   'edx_hp_rate.hp_effect_date',
   'edx_hp_registration.hp_reg_id',
   'edx_hp_registration.hp_reg_photo',
   'edx_hp_registration.hp_reg_first_name',
   'edx_hp_registration.hp_reg_last_name',
   'edx_hp_registration.hp_reg_email',
   'edx_hp_registration.hp_reg_phone_number',
   'edx_hp_registration.hp_reg_gender',
   'edx_hp_registration.hp_reg_city',
   'edx_hp_registration.hp_reg_state',
   'edx_hp_registration.hp_reg_pin_code',
   'edx_hp_registration.hp_reg_languages',
   'edx_hp_registration.hp_reg_branch_id',
   'edx_hp_registration.hp_reg_marital_status',
   'edx_hp_registration.hp_reg_identity_proof_type',
   'edx_hp_registration.hp_reg_identity_proof_number',
   'edx_hp_registration.hp_reg_identity_proof_front_image',
   'edx_hp_registration.hp_reg_identity_proof_back_image',
   'edx_hp_registration.hp_reg_education',
   'edx_hp_registration.hp_reg_education_certificate',
   'edx_hp_registration.hp_reg_phone_number',
   'edx_hp_registration.hp_reg_address',
   'edx_hp_registration.hp_reg_dob',
   'edx_hp_registration.hp_reg_experience',
   'edx_hp_registration.hp_reg_branch_id',
   'edx_hp_registration.hp_reg_status'
   )
   .leftJoin('edx_hp_rate', 'edx_hp_rate.hp_unique_id', 'edx_hp_registration.hp_reg_id');

    // console.log(query.toString());
    query.where('edx_hp_registration.org_id', orgId);
    if (hp_reg_id) query.where('edx_hp_registration.hp_reg_id', hp_reg_id);

 return query;
};

module.exports = { getAllHPDetails }