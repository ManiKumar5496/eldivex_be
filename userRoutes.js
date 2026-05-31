const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const upload = require('../../middlewares/upload');
const auth=require('../../middlewares/auth')
const db = require('../../config/db');


router.post('/users',auth, upload.fields([
  { name: "user_image", maxCount: 1 },

  ]),userController.createUser);
router.put('/update-user',auth,upload.fields([
  { name: "user_image", maxCount: 1 },

  ]),userController.updateUser);

router.get('/allusers',auth, userController.getAllUsers);
router.post('/login', userController.loginUsers);
router.patch('/user-status',auth, async (req, res) => {
    try {
      const id = req.query.id;
      const status = req.query.status;
      const userId = req.user.id;
      await db('tr_users')
      .where({ user_id: id })
      .update({
        user_status:status,
        updated_at:db.fn.now(),
        updated_by:userId
      });

      res.status(200).json({ message: 'Disabled successfully.' });
    } catch (error) {
      res.status(500).json({ details: error.message });
    }
  });
module.exports = router;
