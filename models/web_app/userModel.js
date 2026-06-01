const db = require('../../config/db');


// Finds or creates a client user scoped to a specific organisation.
// Token is NOT stored here — the controller generates it after getting the userId,
// then calls a separate update. org_id is required.
async function upsertUserToken(phone_number, org_id) {
  const existingUser = await db("edx_client_app_users")
    .select("id")
    .where("phone_number", phone_number)
    .andWhere("org_id", org_id)
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
   const { user_id,phone_number } = filters;

 let query = db('edx_client_app_users')   
   .select('*')
   .where('status','1');
    // console.log(query.toString());
    if (user_id) query.where('edx_client_app_users.id', user_id);
    if (phone_number) query.where('edx_client_app_users.phone_number', phone_number);
    

 return query;
};

async function getWebEmpDetailsModel (filters = {})
{
   const { id,user_mobile,user_role } = filters;

 let query = db('edx_web_app_users')   
   .select('*')
   .where('user_status','1')
   .leftJoin('edx_web_emp_roles','edx_web_emp_roles.id','edx_web_app_users.user_role')
    // console.log(query.toString());
    if (id) query.where('edx_web_app_users.id', id);
    if (user_mobile) query.where('edx_web_app_users.user_mobile', user_mobile);
    if (user_role) query.where('edx_web_app_users.user_role', user_role);
    

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