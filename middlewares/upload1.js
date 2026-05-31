const multer = require('multer');
const path = require('path');
const fs = require('fs');

const getUploadMiddleware = (folderName) => {
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      const dest = `uploads/${folderName}/`;

      // Create folder if it doesn't exist
      fs.mkdirSync(dest, { recursive: true });

      cb(null, dest);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname);
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
      cb(null, uniqueName);
    }
  });

  return multer({
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
      const allowedTypes = /jpeg|jpg|png|gif/;
      const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
      const mime = allowedTypes.test(file.mimetype);
      if (ext && mime) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed!'));
      }
    }
  });
};

module.exports = getUploadMiddleware;
