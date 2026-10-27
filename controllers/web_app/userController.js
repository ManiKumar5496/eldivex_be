const getUsers = require('../../models/web_app/userModel');
const db = require('../../config/db'); // your knex instance
const logger = require('../../logger');
const folderMapper = require("../../utils/folderMapper");
require('dotenv').config();
const uploadHandler=require('../../middlewares/uploadHandler')
const { generateToken } = require('../../utils/jwt');
const { invalidateStaffCache } = require('../../middlewares/auth');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getCurrentDateTime } = require("../../utils/dateTime");
const { sendEmail } = require('../../utils/emailService');
const { passwordResetLink } = require('../../utils/emailTemplates');
const { withOrg, getOrgId } = require('../../utils/orgScope');
const { isOrgLoginBlocked, ORG_SUSPENDED_RESPONSE } = require('../../utils/orgStatus');
const { getAcceptanceStatus } = require('./termsController');

/**
 * Authorisation guard for assigning a web role to a user.
 *
 * Prevents privilege escalation: a caller may only assign a role that (a) belongs
 * to the caller's own organisation and (b) grants a subset of the module access
 * the caller's own role already has. An org's Super Admin (all modules) can assign
 * any role in the org; a limited user can never grant a broader role than their own.
 *
 * Returns null when allowed, or an error string describing the rejection.
 */
const parseAccessSet = (accessList) =>
  new Set(String(accessList || '').split(',').map((s) => s.trim()).filter(Boolean));

async function checkRoleAssignment(req, targetRoleId) {
  // No role provided → nothing to escalate (user gets no module access).
  if (!targetRoleId || targetRoleId === 'NA') return null;

  const orgId = getOrgId(req);
  const callerRoleId = req.login_data?.role_id;

  const targetRole = await db('edx_web_emp_roles')
    .where({ id: targetRoleId, org_id: orgId })
    .first('id', 'access_list');
  if (!targetRole) return 'Invalid role for this organisation.';

  const callerRole = await db('edx_web_emp_roles')
    .where({ id: callerRoleId, org_id: orgId })
    .first('id', 'access_list');
  if (!callerRole) return 'You are not permitted to assign roles.';

  const callerAccess = parseAccessSet(callerRole.access_list);
  const targetAccess = parseAccessSet(targetRole.access_list);
  for (const mod of targetAccess) {
    if (!callerAccess.has(mod)) {
      return 'You cannot assign a role with more access than your own.';
    }
  }
  return null;
}


/**
 * Invalidates every JWT issued to a staff user before now (auth rejects tokens
 * with iat < tokens_valid_after). Second precision, truncated, so a token
 * issued right after this call is still accepted. Tolerates the column being
 * absent until migration 20261007_041 has run.
 */
async function revokeSessions(userId) {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  try {
    await db('edx_web_app_users').where({ id: userId }).update({ tokens_valid_after: now });
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    logger.warn('[userController] tokens_valid_after missing — run migration 20261007_041');
  }
  invalidateStaffCache(userId);
}

const getUserDetails = async (req, res) =>  {
  try {
    // org_id comes from the authenticated token, never the client query string,
    // so a forged ?org_id= cannot pull another tenant's users.
    const filters = { ...req.query, org_id: getOrgId(req) };
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
    // org_id comes from the authenticated token, never the client query string,
    // so a forged ?org_id= cannot pull another tenant's employees.
    const filters = { ...req.query, org_id: getOrgId(req) };
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
      phone_number,
      status,
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
    const is_new_user_flag=0;

    // 1️⃣ Fetch existing user (org-scoped — cannot touch another org's client)
    const existingUser = await db('edx_client_app_users')
      .where({ id, org_id: getOrgId(req) })
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
      phone_number,
      status,
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

    // audit field — edx_client_app_users has no updated_by/created_by columns,
    // so only the timestamp is recorded here.
    updatePayload.updated_on = getCurrentDateTime();

    // 4️⃣ Update DB (org-scoped)
    if (Object.keys(updatePayload).length > 0) {
      await db('edx_client_app_users')
        .where({ id, org_id: getOrgId(req) })
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


/**
 * POST /api/login — RETIRED. It issued an admin-capable JWT for any
 * {phone_number, org_id} with no OTP. Clients now use /clientAuth OTP login;
 * staff create clients with /createClientUser.
 */
const loginUsers = async (req, res) =>
  res.status(410).json({
    message: 'This login is no longer supported. Use /clientAuth/requestOtp and /clientAuth/verifyOtp.',
  });

/**
 * POST /api/createClientUser — staff (Users or Bookings module) create or find
 * a client by phone in their own org. org_id comes from the JWT only. Issues
 * no token and never touches user_token.
 */
const createClientUser = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Invalid token for this endpoint' });

    const cc = String(req.body.country_code || '').replace(/[^\d+]/g, '');
    const digits = String(req.body.phone_number || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return res.status(400).json({ message: 'A valid phone number is required.' });
    }
    const phone_number = cc && !digits.startsWith(cc.replace('+', '')) ? `${cc}${digits}` : digits;

    const result = await getUsers.upsertUserToken(phone_number, orgId);
    return res.status(200).json({
      message: result.isNewUser ? 'Client created successfully.' : 'Client already exists.',
      userId: result.userId,
      isNewUser: result.isNewUser,
      org_id: orgId,
    });
  } catch (err) {
    logger.error(`Error createClientUser: ${err.message}`);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'This phone number is already registered.' });
    }
    return res.status(500).json({ message: 'Could not create client.' });
  }
};

const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.Zu3Y5lV5Ep5Sx5bSxp4Wv1vZ3Z1e';

const loginWebUsers = async (req, res) => {

  const { email, password } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  // console.log(email)
  try {
      // Unknown email and wrong password get the same 401 (no enumeration).
      const INVALID = { message: 'Invalid email or password' };
      if (!password) {
          return res.status(400).json({ message: 'Password is required' });
      }
      const [users] = await getUsers.loginUserWeb(email);
      // Compare against a dummy hash for unknown users so response timing
      // doesn't reveal which emails exist.
      const match = await bcrypt.compare(password, users?.user_password || DUMMY_HASH);
      if (!users || !users.user_password || !match) return res.status(401).json(INVALID);

      const role_id=users.user_role
      const userId=users.id
      const user_name=users.user_name
      const branch_access = users.user_branch_access
      const org_id = users.org_id
      if (!org_id || role_id === null || role_id === undefined) {
          return res.status(403).json({ message: 'Your account has no organisation or role assigned. Contact your administrator.' });
      }

      // Org kill-switch: no user of a suspended/cancelled org can log in.
      // No role exemption — the platform owner has a separate /ownerLogin and
      // role 1 "Super Admin" is just a tenant role.
      const org = await db('edx_organizations')
        .where({ id: org_id })
        .select('status', 'org_code')
        .first();
      if (org && isOrgLoginBlocked(org.status)) {
        return res.status(403).json(ORG_SUSPENDED_RESPONSE);
      }
     
      const docUrl = process.env.DOC_FOLDER_URL
      const folderName = folderMapper.fetchFolderName("user_image");

    const  user_image= users.user_image ? `${docUrl}/${folderName}/${users.user_image}` : null
    
      const token = generateToken(users);

      // Terms & Conditions gate: tell the web app whether this user must review
      // and accept the current terms before entering the dashboard.
      const terms = await getAcceptanceStatus(userId);

      // console.log(token)
      return res.status(200).json({
        message: 'Login successful',
        token, role_id, userId, user_name, user_image, branch_access, org_id,
        org_code: org?.org_code ?? null,
        terms_accepted: terms.accepted,
        terms_version:  terms.version,
      });

  } catch (err) {
    console.error('❌ Controller error:', err.message);
    logger.error(`Error login: ${err.message}`);
      res.status(500).json({ message: 'Login failed. Please try again.' });

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

    // Authorisation: prevent assigning a role more privileged than the caller's.
    const roleErr = await checkRoleAssignment(req, user_role);
    if (roleErr) return res.status(403).json({ message: roleErr });

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
      created_by:req.login_data?.id ?? null,
      created_on:getCurrentDateTime()
    }));

    res.status(201).json({ message: 'User created successfully.' });
  } catch (err) {
    logger.error(`Error creating user: ${err.message}`);
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Email already exists.' });
    }
    res.status(500).json({ message: 'Server error.' });
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

    // Authorisation: prevent escalating a user to a role beyond the caller's own.
    const roleErr = await checkRoleAssignment(req, user_role);
    if (roleErr) return res.status(403).json({ message: roleErr });

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
     const updated = await db('edx_web_app_users')
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
      updated_by:req.login_data?.id ?? null,
      updated_on:getCurrentDateTime()

    });

    if (!updated) return res.status(404).json({ message: 'User not found.' });
    res.status(201).json({ message: 'User updated successfully.' });
  } catch (err) {
    logger.error(`Error updating user: ${err.message}`);
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
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

    // Revoke live sessions now, not when their 30-day JWT expires.
    await revokeSessions(id);

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

    // A password reset signs out every existing session of this user.
    await revokeSessions(user.id);

    return res.status(200).json({ message: 'Password reset successful. You can now log in.' });
  } catch (err) {
    logger.error(`Error in resetPassword: ${err.message}`);
    return res.status(500).json({ message: 'An error occurred. Please try again.' });
  }
};

module.exports = {
    loginUsers,
    createClientUser,
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
