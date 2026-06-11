const getUsers = require('../../models/web_app/userModel');
const db = require('../../config/db'); // your knex instance
const logger = require('../../logger');
const folderMapper = require("../../utils/folderMapper");
require('dotenv').config();
const uploadHandler=require('../../middlewares/uploadHandler')
const { generateToken } = require('../../utils/jwt');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getCurrentDateTime } = require("../../utils/dateTime");
const { sendEmail } = require('../../utils/emailService');
const { passwordResetLink } = require('../../utils/emailTemplates');
const { withOrg, getOrgId } = require('../../utils/orgScope');


const getUserDetails = async (req, res) =>  {
  try {
    const filters = req.query;
    // console.log(filters)
    const getDetails = await getUsers.getDetails(filters);

    res.json(getDetails);
  } catch (err) {
    console.error('❌ Controller error:Error fetching user details', err.message);
    logger.error(`Error fetching user: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching user details' });
  }
};
const getWebEmpDetails = async (req, res) =>  {
  try {
    const filters = req.query;
    // console.log(filters)
    const getData = await getUsers.getWebEmpDetailsModel(filters);
  
    const docUrl = process.env.DOC_FOLDER_URL
    const folderName = folderMapper.fetchFolderName("user_image");

    // Add image path to each user
    const updatedUsers = getData.map(user => ({
      ...user,
      user_image: user.user_image ? `${docUrl}/${folderName}/${user.user_image}` : null
    }));
    res.json(updatedUsers);
  } catch (err) {
    console.error('❌ Controller error:Error fetching Employee Details', err.message);
    logger.error(`Error fetching employee details: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching employee details' });
  }
};








const saveUser = async (req, res) => {
  try {
    const {
      id,
      device_id,
      user_token,
      phone_number,
      status,
      created_by,
      user_name,
      user_location,
      user_email,
      user_gender,
    
      user_service_city,
      user_source,
      enquired_for,
      lead_potential,
      enquired_for_other
    } = req.body;

    const files = req.files;
    const userId = req.login_data?.id || null;
    const is_new_user_flag=0;

    // 1️⃣ Fetch existing user
    const existingUser = await db('edx_client_app_users')
      .where({ id })
      .first();

    if (!existingUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    let user_image_name = existingUser.user_image;

    // 2️⃣ Handle image upload
    if (files && files['user_image'] && files['user_image'][0]) {
      const username = (user_name || existingUser.user_name || 'user')
        .replace(/\s+/g, '_')
        .replace(/[^\w\-]/g, '');

      const filename = `${Date.now()}-${username}-photo`;

      const user_image = files['user_image'][0];
      const folder = folderMapper.fetchFolderName("user_image");

      user_image_name = uploadHandler.saveFile(user_image, folder, filename);
    }

    // 3️⃣ Dynamic update payload
    const updatePayload = {};

    const fields = {
      device_id,
      user_token,
      phone_number,
      status,
      created_by,
      user_name,
      user_location,
      user_email,
      user_gender,
      is_new_user_flag,
      user_service_city,
      user_source,
      enquired_for,
      lead_potential,
      enquired_for_other
    };

    // Only update provided values
    Object.keys(fields).forEach(key => {
      if (fields[key] !== undefined) {
        updatePayload[key] = fields[key];
      }
    });

    // image update only if changed
    if (user_image_name !== existingUser.user_image) {
      updatePayload.user_image = user_image_name;
    }

    // audit fields
    updatePayload.updated_by = userId;
    updatePayload.updated_on = getCurrentDateTime();

    // 4️⃣ Update DB
    if (Object.keys(updatePayload).length > 0) {
      await db('edx_client_app_users')
        .where({ id })
        .update(updatePayload);
    }

    res.status(200).json({
      message: 'User updated successfully',
      updated_fields: Object.keys(updatePayload)
    });

  } catch (err) {
    logger.error(`Error updating user: ${err.message}`);
    console.error(err);
    res.status(500).json({ message: 'Error updating user.' });
  }
};


const loginUsers = async (req, res) => {
  const { phone_number, org_id } = req.body;

  if (!phone_number) return res.status(400).json({ message: "Phone number is required" });
  if (!org_id) return res.status(400).json({ message: "Organization ID is required" });

  const parsedOrgId = parseInt(org_id, 10);
  if (isNaN(parsedOrgId)) return res.status(400).json({ message: "Organization ID must be a number" });

  try {
    // 1. Validate org exists and is active
    const org = await db('edx_organizations')
      .select('id', 'name', 'status')
      .where({ id: parsedOrgId })
      .first();

    if (!org) return res.status(404).json({ message: "Organization not found" });
    if (org.status !== 'active' && org.status !== 'trial') {
      return res.status(403).json({
        code: 'ORG_SUSPENDED',
        message: 'Your organisation account has been suspended. Please contact support.',
      });
    }

    // 2. Find or create client user scoped to this org
    const result = await getUsers.upsertUserToken(phone_number, parsedOrgId);

    // 3. Generate JWT with the real user id and org scope
    const token = generateToken({
      id: result.userId,
      user_role: null,
      user_branch_access: null,
      org_id: parsedOrgId,
    });

    // 4. Persist the token on the user record
    await db('edx_client_app_users')
      .where({ id: result.userId })
      .update({ user_token: token, updated_on: db.fn.now() });

    return res.status(200).json({
      message: "Login successful",
      token,
      isNewUser: result.isNewUser,
      userId: result.userId,
      org_id: parsedOrgId,
      phone_number,
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const loginWebUsers = async (req, res) => {

  const { email, password } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  // console.log(email)
  try {
      const [users] = await getUsers.loginUserWeb(email);
      if (!users) return res.status(404).json({ message: 'User not found' });
      const role_id=users.user_role
      const userId=users.id
      const user_name=users.user_name
      const branch_access = users.user_branch_access
      const org_id = users.org_id ?? 1

      // Org kill-switch: non-owner users of a suspended/cancelled org cannot log in
      if (role_id !== 1 && role_id !== '1') {
        const org = await db('edx_organizations')
          .where({ id: org_id })
          .select('status')
          .first();
        if (org && ['suspended', 'cancelled'].includes(org.status)) {
          return res.status(403).json({
            code: 'ORG_SUSPENDED',
            message: 'Your organisation account has been suspended. Please contact support.',
          });
        }
      }
     
      const docUrl = process.env.DOC_FOLDER_URL
      const folderName = folderMapper.fetchFolderName("user_image");

    const  user_image= users.user_image ? `${docUrl}/${folderName}/${users.user_image}` : null
    
      // console.log(users)
      // If password is provided, verify it
      if (password) {
          if (!users.user_password) {
              return res.status(400).json({ message: 'Password login not enabled for this user' });
          }

          const match = await bcrypt.compare(password, users.user_password);
          // console.log(match)
          if (!match) return res.status(401).json({ message: 'Invalid password' });
      }

      // If password is not provided, allow password-less login
      // (you can add extra validation like OTP here)
      const token = generateToken(users);
      // console.log(token)
      return res.status(200).json({ message: 'Login successful', token, role_id, userId, user_name, user_image, branch_access, org_id });

  } catch (err) {
    console.error('❌ Controller error:', err.message);
    logger.error(`Error login: ${err.message}`);
      res.status(500).json({ error: err });

  }
  
};
const createUserWeb = async (req, res) => {
  try {
    const {
      user_name,
      user_gender,
      user_mobile,
      user_email,
      user_password,
      user_role,
      user_home_branch,
      user_branch_access,
      userId
    } = req.body;
    // console.log(req.body)
    const files = req.files;
    // console.log(files);
    let user_image_name
  
   const username = user_name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
  
    // Hash the password
    const hashedPassword = await bcrypt.hash(user_password, 10);

  

    if(files && files['user_image'] && files['user_image'][0])
     {
       const filename = `${Date.now()}-${username}-${'photo'}`;
       const user_image = files['user_image'][0]
       const user_image_type = folderMapper.fetchFolderName("user_image");
       user_image_name = uploadHandler.saveFile(user_image, user_image_type,filename)
     }

   
    // Insert into DB
    const [user_id] = await db('edx_web_app_users').insert(withOrg(req, {
      user_name: user_name ? user_name : 'NA',
      user_gender: user_gender ? user_gender : 'NA',
      user_mobile: user_mobile ? user_mobile : 'NA',
      user_email: user_email ? user_email : 'NA',
      user_password: hashedPassword,
      user_role: user_role ? user_role : 'NA',
      user_home_branch:user_home_branch?user_home_branch:'NA',
      user_branch_access:user_branch_access?user_branch_access:'NA',
      user_image: user_image_name,
      created_by:userId,
      created_on:getCurrentDateTime()
    }));

    res.status(201).json({ message: 'User created successfully.' });
  } catch (err) {
    logger.error(`Error creating user: ${err.message}`);
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Email already exists.' });
    }
    res.status(500).json({ message: err.message || 'Server error.' });
  }
};
const updateUserWeb = async (req, res) => {
  try {
    const {
      user_name,
      user_gender,
      user_mobile,
      user_email,
      
      user_role,
      user_home_branch,
      user_branch_access,
      userId,
      id
    } = req.body;
    // console.log(req.body)
    const files = req.files;
    let user_image_name
    
   const username = user_name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
  
   
// console.log(files)
   if(files && files['user_image'] && files['user_image'][0])
   {
     const filename = `${Date.now()}-${username}-${'photo'}`;
     const user_image = files['user_image'][0]
     const user_image_type = folderMapper.fetchFolderName("user_image");
     user_image_name = uploadHandler.saveFile(user_image, user_image_type,filename)
   }

  
    // update into DB
     await db('edx_web_app_users')
     .where({ id: id })
     .andWhere('org_id', getOrgId(req))
    .update({
      user_name: user_name ? user_name : 'NA',
      user_gender: user_gender ? user_gender : 'NA',
      user_mobile: user_mobile ? user_mobile : 'NA',
      user_email: user_email ? user_email : 'NA',

      user_role: user_role ? user_role : 'NA',
      user_home_branch:user_home_branch?user_home_branch:'NA',
      user_branch_access:user_branch_access?user_branch_access:'NA',
      user_image: user_image_name,
      updated_by:userId,
      updated_on:getCurrentDateTime()

    });

    res.status(201).json({ message: 'User updated successfully.' });
  } catch (err) {
    logger.error(`Error updating user: ${err.message}`);
    console.error(err);
    res.status(500).json({ message: err.message || 'Server error.' });
  }
};
const terminateUserWeb = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: 'User ID is required.' });

    const updated = await db('edx_web_app_users')
      .where({ id })
      .andWhere('org_id', getOrgId(req))
      .update({ user_status: 0, updated_on: getCurrentDateTime() });

    if (!updated) return res.status(404).json({ message: 'User not found.' });

    res.status(200).json({ message: 'User terminated successfully.' });
  } catch (err) {
    logger.error(`Error terminating user: ${err.message}`);
    res.status(500).json({ message: 'Server error.' });
  }
};
const updateUserClient = async (req, res) => {
  try {
    const {
      user_name,
      user_gender,
      phone_number,
      user_location,
      user_email,
      user_id,
    } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({ message: 'User ID is required.' });
    }

    // Check if user exists (scoped to this org)
    const existingUser = await db('edx_client_app_users')
      .where({ id: user_id })
      .andWhere('org_id', getOrgId(req))
      .first();

    if (!existingUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const files = req.files;
    let user_image_name = existingUser.user_image; // Preserve existing image if no new upload

    // Handle image upload
    if (files?.user_image?.[0]) {
      const sanitizedUsername = user_name
        ? user_name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '')
        : 'user';
      
      const filename = `${Date.now()}-${sanitizedUsername}-photo`;
      const user_image = files.user_image[0];
      const user_image_type = folderMapper.fetchFolderName('user_image');
      
      user_image_name = uploadHandler.saveFile(
        user_image,
        user_image_type,
        filename
      );

    }

    // Prepare update data - only include fields that are provided
    const updateData = {
      updated_on: getCurrentDateTime(),
    };

    if (user_name !== undefined) updateData.user_name = user_name || 'NA';
    if (user_gender !== undefined) updateData.user_gender = user_gender || 'NA';
    if (user_location !== undefined) updateData.user_location = user_location || 'NA';
    if (user_email !== undefined) updateData.user_email = user_email || 'NA';
    if (phone_number !== undefined) updateData.phone_number = phone_number || 'NA';
    if (user_image_name) updateData.user_image = user_image_name;

    // Update database (scoped to this org)
    await db('edx_client_app_users')
      .where({ id: user_id })
      .andWhere('org_id', getOrgId(req))
      .update(updateData);

    logger.info(`User ${user_id} updated successfully by user`);

    res.status(200).json({
      message: 'User updated successfully.',
      data: { user_id, updated_fields: Object.keys(updateData) },
    });

  } catch (err) {
    logger.error(`Error updating user: ${err.message}`, {
      stack: err.stack,
      user_id: req.body.user_id,
    });
    
    res.status(500).json({
      message: 'An error occurred while updating the user.',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};


/**
 * POST /api/forgotPassword
 * Generates a 15-min password reset token and emails a reset link.
 * Always returns 200 — never reveals whether the email exists.
 */
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    const user = await db('edx_web_app_users')
      .where({ user_email: email })
      .select('id', 'user_name')
      .first();

    if (user) {
      // Generate cryptographically secure random token
      const rawToken   = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt  = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await db('edx_web_app_users')
        .where({ id: user.id })
        .update({
          password_reset_token:   hashedToken,
          password_reset_expires: expiresAt,
          updated_on:             getCurrentDateTime(),
        });

      const appBase  = process.env.APP_BASE_URL || 'http://localhost:3000';
      const resetUrl = `${appBase}/reset-password?token=${rawToken}`;

      const tpl = passwordResetLink({ resetUrl });
      sendEmail({ to: email, ...tpl }).catch(err =>
        logger.warn(`[email] Password reset email failed for ${email}: ${err.message}`)
      );
    }

    // Always return 200 to avoid revealing if email exists
    return res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    logger.error(`Error in forgotPassword: ${err.message}`);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
};

/**
 * POST /api/resetPassword
 * Validates the reset token and sets a new password.
 */
const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await db('edx_web_app_users')
      .where({ password_reset_token: hashedToken })
      .whereRaw('password_reset_expires > NOW()')
      .select('id')
      .first();

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset link. Please request a new one.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await db('edx_web_app_users')
      .where({ id: user.id })
      .update({
        user_password:          hashed,
        password_reset_token:   null,
        password_reset_expires: null,
        updated_on:             getCurrentDateTime(),
      });

    return res.status(200).json({ message: 'Password reset successful. You can now log in.' });
  } catch (err) {
    logger.error(`Error in resetPassword: ${err.message}`);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
};

module.exports = {
    loginUsers,
    saveUser,
    getUserDetails,
    loginWebUsers,
    createUserWeb,
    updateUserWeb,
    terminateUserWeb,
    updateUserClient,
    getWebEmpDetails,
    forgotPassword,
    resetPassword,
  };
