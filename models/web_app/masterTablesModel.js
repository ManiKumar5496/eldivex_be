const db = require('../../config/db');

async function getAddressModel (filters = {})
{
   const { user_id, org_id } = filters;

 let query = db('edx_user_address')
   .select('*')
   .where('status','1');
    // console.log(query.toString());
    if (user_id) query.where('edx_user_address.user_id', user_id);
    if (org_id) query.where('edx_user_address.org_id', org_id);

 return query;
};

async function getcouponsModel(filters = {}) {
  const { coupon_id, coupon_name, checkDuplicate, includeInactive, org_id } = filters;

  let query = db('edx_master_coupons')
    .select(
      'coupon_id',
      'coupon_name',
      'discount_percentage',
      'discount_upper_limit_value'
    );

  // Duplicate checks must see inactive coupons too — the unique key does.
  if (!includeInactive) query = query.where('status', '1');

  // Always org-scoped: no org → no rows (never every tenant's coupons).
  query = query.where('org_id', org_id ?? -1);

  // Filter by ID
  if (coupon_id) {
    query.where('edx_master_coupons.coupon_id', coupon_id);
  }

  // Filter by Name
  if (coupon_name) {
    query.whereRaw('LOWER(edx_master_coupons.coupon_name) = ?', [coupon_name.toLowerCase()]);
  }

  // 🔥 Duplicate validation mode
  if (checkDuplicate) {
    return await query.first(); // return single record
  }

  return await query; // return list
}


async function getbannersModel (filters = {})
{
   const {banner_id, org_id} = filters;

 let query = db('edx_master_banners')
   .select('banner_name',
   'banner_description',
   'banner_photo',
   'banner_id',
   'banner_status');
  //  .where('banner_status','1');
    if (org_id) query = query.where('org_id', org_id);
    if (banner_id) query.where('edx_master_banners.banner_id', banner_id);

 return query;
};

async function getBranchesData (filters = {})
{
   const { br_id, org_id } = filters;

 let query = db('edx_branches')
   .select('br_id','br_name','br_phone','br_email','br_address','br_city','br_state','br_status')
   .where('br_status','1');
    if (org_id) query = query.where('org_id', org_id);
    if (br_id) query.where('edx_branches.br_id', br_id);

 return query;
};


async function getLangM() 
{
  const rows=db('edx_master_languages').select('id','name');
  // console.log(rows.toString());

  return rows;
};



async function getModulesData() 
{
  const rows=db('edx_web_module').select('id','module_name');
  // console.log(rows.toString());

  return rows;
};


async function getRolesModel(filters = {}) {
  const { id, org_id } = filters;

  let data = db('edx_web_emp_roles as r')
    .leftJoin('edx_web_module as m', function () {
      this.on(
        db.raw('FIND_IN_SET(m.id, r.access_list)')
      );
    })
    .select(
      'r.id',
      'r.role_name',
      'r.access_list',
      db.raw('GROUP_CONCAT(m.module_name) AS modules'),
      db.raw('GROUP_CONCAT(m.id) AS module_ids')
    )
    .where('r.status', '1')
    .groupBy('r.id');

    if (id) data.where('r.id', id);
    if (org_id) data.where('r.org_id', org_id);

    return data;

}


module.exports = {
    getAddressModel,
    getLangM,
    getRolesModel,
    getBranchesData,
    getModulesData,
    getcouponsModel,
    getbannersModel
    
    };