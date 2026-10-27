const db = require('../../config/db');


// models/userModel.js
async function getServices (filters = {})
 {
  const { org_id } = filters;
  let query = db('edx_master_services_category')
    .select(
      'id',
      db.raw('name as cat_name'),
      db.raw("'' as cat_icon"),
      'status'
    )
    .where('status', '1');
  if (org_id) query.where('org_id', org_id);

  return query;
};


async function getServicesTypes (filters = {})
{
   const { branch_id,service_category_id,org_id } = filters;

 let query = db('edx_master_services')

   .select('*')
   .where('status','1');
   if (org_id) query.where('edx_master_services.org_id', org_id);
   if (branch_id) query.where('edx_master_services.branch_id', branch_id);
   if (service_category_id) query.where('edx_master_services.service_category_id', service_category_id);

  //  console.log(query.toString());
 return query;
};

module.exports = {
    getServices,
    getServicesTypes
  
  };