const db = require('../../config/db');

// Tenant org of the caller. No default org: a missing claim matches nothing.
const orgOf = (login_data) => (login_data && login_data.is_owner !== true ? login_data.org_id ?? -1 : -1);

async function getSupportModel (filters = {}, login_data)
{
   const { user_id,id } = filters;

 let query = db('edx_support_requests')
   .select('*');
    query.where('edx_support_requests.org_id', orgOf(login_data));
    if (user_id) query.where('edx_support_requests.user_id', user_id);
    if (id) query.where('edx_support_requests.id', id);

 return query;
};

const activeCategory = (q) => q.where(function () {
  this.where('status', 1).orWhereNull('status');
});

/**
 * Support categories of ONE org (never every tenant's). orgId is required.
 * appType ('web' | 'client' | 'hp'): categories tagged for that app (or 'all');
 * when the org has none tagged, falls back to the org's other categories.
 */
async function getSupportCategoryData (filters = {}, orgId, appType = null)
{
   const { id } = filters;
   if (orgId == null) return [];

   const base = () => {
     const q = activeCategory(db('edx_support_category').where('org_id', orgId))
       .select('id', 'name', 'app_type', 'status')
       .orderBy('id', 'asc');
     if (id) q.where('id', id);
     return q;
   };

   if (!appType) return base();
   const tagged = await base().whereIn('app_type', [appType, 'all']);
   return tagged.length ? tagged : base();
};

module.exports = {
    getSupportModel,
    getSupportCategoryData
};
