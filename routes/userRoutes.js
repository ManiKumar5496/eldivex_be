const express = require('express');
const router  = express.Router();
const userController = require('../controllers/web_app/userController');
const ownerAuthController = require('../controllers/web_app/ownerAuthController');
const upload  = require('../middlewares/upload');
const auth    = require('../middlewares/auth');
const requireStaff  = require('../middlewares/requireStaff');
const requireModule = require('../middlewares/requireModule');
const { authLimiter } = require('../middlewares/rateLimiter');
const validate = require('../middlewares/validateRequest');
const { loginWebSchema, createUserSchema, forgotPasswordSchema, resetPasswordSchema } = require('../validators/userValidator');

// ── Auth endpoints — strict rate limit ───────────────────────────────────────
router.post('/loginWeb',       authLimiter, validate(loginWebSchema),       userController.loginWebUsers);
router.post('/ownerLogin',     authLimiter, ownerAuthController.ownerLogin);
router.post('/login',          authLimiter, userController.loginUsers); // 410 — retired
router.post('/forgotPassword', validate(forgotPasswordSchema), userController.forgotPassword);
router.post('/resetPassword',  validate(resetPasswordSchema),  userController.resetPassword);

// Employee writes → Settings. The employee list is read by every staff shell
// (care-manager pickers in Bookings), and returns no credential columns.
const settings  = [auth, requireStaff, requireModule('Settings')];
const clientOps = [auth, requireStaff, requireModule('Users', 'Bookings')];

// ── Employee management ───────────────────────────────────────────────────────
router.post('/createUser', settings, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), validate(createUserSchema), userController.createUserWeb);

router.put('/update-user', settings, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), userController.updateUserWeb);

router.put('/terminate-user', settings, userController.terminateUserWeb);

router.put('/update-user-client', clientOps, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), userController.updateUserClient);

router.put('/saveUser', clientOps, upload.fields([
  { name: 'user_image', maxCount: 1 },
]), userController.saveUser);

router.get('/getUserDetails',    clientOps, userController.getUserDetails);
router.get('/getWebEmpDetails',  auth, requireStaff, userController.getWebEmpDetails);

// ── Client creation by staff (replaces the retired /login) ───────────────────
router.post('/createClientUser', clientOps, userController.createClientUser);

module.exports = router;
