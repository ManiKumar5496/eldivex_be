const db = require('../../config/db');

async function getSupportModel (filters = {}, login_data)
{
   const { user_id,id } = filters;
   const orgId = login_data?.org_id ?? 1;

 let query = db('edx_support_requests')

   .select('*')
//    .where('status','1');
    // console.log(query.toString());
    query.where('edx_support_requests.org_id', orgId);
    if (user_id) query.where('edx_support_requests.user_id', user_id);
    if (id) query.where('edx_support_requests.id', id);

 return query;
};

async function getSupportCategoryData (filters = {})
{
   const { id } = filters;

 let query = db('edx_support_category')
   
   .select('*')
//    .where('status','1');
    // console.log(query.toString());
    if (id) query.where('edx_support_category.id', id);

 return query;
};

module.exports = {
 
    getSupportModel,
    getSupportCategoryData
   
    
    };

