const multer = require('multer');
const path = require('path');

// Allow-list: the extension AND the mimetype must both match. Anything else
// (html, svg, js, …) is rejected so /uploads can never serve active content.
const ALLOWED = {
  '.jpg':  ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  '.jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  '.png':  ['image/png'],
  '.webp': ['image/webp'],
  '.pdf':  ['application/pdf'],
};

const isAllowedFile = (file) => {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const mimes = ALLOWED[ext];
  return !!mimes && mimes.includes(String(file.mimetype || '').toLowerCase());
};

const fileFilter = (req, file, cb) => {
  if (isAllowedFile(file)) return cb(null, true);
  const err = new Error('Only .jpg, .jpeg, .png, .webp and .pdf files are allowed');
  err.status = 400;
  err.expose = true;
  cb(err, false);
};

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // Max 5MB per file
});

module.exports = upload;
module.exports.ALLOWED_EXTENSIONS = Object.keys(ALLOWED);
module.exports.isAllowedFile = isAllowedFile;
