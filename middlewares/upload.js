const multer = require('multer');

// File types allowed
const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];

const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only .jpg, .jpeg, .png files are allowed'), false);
  }
};

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  // fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // Max 2MB per image
});

module.exports = upload;
