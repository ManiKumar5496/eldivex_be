const express = require('express');
const router  = express.Router();
const userController = require('../controllers/web_app/userController');
const upload  = require('../middlewares/upload');
const auth    = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimiter');
const validate = require('../middlewares/validateRequest');
const { loginWebSchema, createUserSchema, forgotPasswordSchema, resetPasswordSchema } = require('../validators/userValidator');

// ── Auth endpoints — strict rate limit ───────────────────────────────────────
router.post('/loginWeb',       authLimiter, validate(loginWebSchema),       userController.loginWebUsers);
router.post('/login',          authLimiter, userController.loginUsers);
router.post('/forgotPassword', validate(forgotPasswordSchema), userController.forgotPassword);
router.post('/resetPassword',  validate(resetPasswordSchema),  userController.resetPassword);

// ── Employee management ───────────────────────────────────────────────────────
router.post('/createUser', auth, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), validate(createUserSchema), userController.createUserWeb);

router.put('/update-user', auth, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), userController.updateUserWeb);

router.put('/terminate-user', auth, userController.terminateUserWeb);

router.put('/update-user-client', auth, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), userController.updateUserClient);

router.put('/saveUser', auth, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), userController.saveUser);

router.get('/getUserDetails',    auth, userController.getUserDetails);
router.get('/getWebEmpDetails',  auth, userController.getWebEmpDetails);

module.exports = router;
