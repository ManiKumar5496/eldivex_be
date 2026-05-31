const db = require('../../config/db');


async function upsertUserToken (phone_number, token) {
  const existingUser = await db("edx_client_app_users")
    .select("id")
    .where("phone_number", phone_number)
    .first();

  if (existingUser) {
    // 🔥 UPDATE TOKEN
    await db("edx_client_app_users")
      .where("id", existingUser.id)
      .update({
        user_token: token,
        updated_on: db.fn.now()
      });

    return {
      success: true,
      isNewUser: false,     // 🔥 Existing user
      userId: existingUser.id
    };
  } else {
    // 🆕 INSERT NEW USER
    const [newId] = await db("edx_client_app_users")
      .insert({
        phone_number,
        user_token: token,
        status: 1,
        is_new_user_flag:1,
        created_on: db.fn.now()
      });

    return {
      success: true,
      isNewUser: true,      // 🆕 New user
      userId: newId
    };
  }
};






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