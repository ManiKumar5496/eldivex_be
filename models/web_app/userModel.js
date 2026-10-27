const db = require('../../config/db');


// Finds or creates a client user scoped to a specific organisation.
// Never issues or stores a token (staff create clients via /createClientUser;
// clients log in via /clientAuth OTP). org_id is required.
async function upsertUserToken(phone_number, org_id) {
  // Match on the last 10 digits (same rule as clientAuth) so "+919876543210"
  // and a legacy bare "9876543210" resolve to the same client.
  const phone10 = String(phone_number || '').replace(/\D/g, '').slice(-10);
  const existingUser = await db("edx_client_app_users")
    .select("id")
    .where("org_id", org_id)
    .whereRaw("RIGHT(REPLACE(REPLACE(phone_number, '+', ''), ' ', ''), 10) = ?", [phone10])
    .first();

  if (existingUser) {
    return {
      success: true,
      isNewUser: false,
      userId: existingUser.id,
    };
  } else {
    const [newId] = await db("edx_client_app_users").insert({
      phone_number,
      status: 1,
      is_new_user_flag: 1,
      org_id,
      created_on: db.fn.now(),
    });

    return {
      success: true,
      isNewUser: true,
      userId: newId,
    };
  }
}






async function getDetails (filters = {})
{
   const { user_id, phone_number, org_id } = filters;

 let query = db('edx_client_app_users')
   .select('*')
   .where('status','1');
    // console.log(query.toString());
    if (user_id) query.where('edx_client_app_users.id', user_id);
    if (phone_number) query.where('edx_client_app_users.phone_number', phone_number);
    if (org_id) query.where('edx_client_app_users.org_id', org_id);

 // user_token is a legacy session credential — never return it.
 const rows = await query;
 return rows.map(({ user_token, ...rest }) => rest);
};

async function getWebEmpDetailsModel (filters = {})
{
   const { id, user_mobile, user_role, org_id } = filters;

 // Explicit columns — a bare select('*') across the join collides on shared
 // names (id, org_id, status, created_on…) so `id` ends up being the role's id,
 // which then drives edit/terminate against the wrong row. Keep the user row
 // intact and pull only the role fields the UI needs.
 let query = db('edx_web_app_users')
   // Never select user_password / password_reset_* / tokens_valid_after.
   .select(
     'edx_web_app_users.id',
     'edx_web_app_users.user_name',
     'edx_web_app_users.user_gender',
     'edx_web_app_users.user_mobile',
     'edx_web_app_users.user_email',
     'edx_web_app_users.user_role',
     'edx_web_app_users.user_home_branch',
     'edx_web_app_users.user_branch_access',
     'edx_web_app_users.user_image',
     'edx_web_app_users.user_status',
     'edx_web_app_users.user_status as status',
     'edx_web_app_users.org_id',
     'edx_web_app_users.created_by',
     'edx_web_app_users.created_on',
     'edx_web_app_users.updated_by',
     'edx_web_app_users.updated_on',
     'edx_web_emp_roles.role_name',
     'edx_web_emp_roles.access_list',
   )
   .where('user_status','1')
   .leftJoin('edx_web_emp_roles','edx_web_emp_roles.id','edx_web_app_users.user_role')
    // console.log(query.toString());
    if (id) query.where('edx_web_app_users.id', id);
    if (user_mobile) query.where('edx_web_app_users.user_mobile', user_mobile);
    if (user_role) query.where('edx_web_app_users.user_role', user_role);
    if (org_id) query.where('edx_web_app_users.org_id', org_id);


 return query;
};



async function loginUserWeb(email) {
  return db('edx_web_app_users')
  .select('id','user_email','user_role','user_name','user_password','user_image','user_branch_access','org_id')
  .where('user_email',email)
  .andWhere('user_status','1');
}


module.exports = {
 
  
  upsertUserToken,
  getDetails,
  loginUserWeb,
 
  getWebEmpDetailsModel,
 
  
  };