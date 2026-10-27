require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ALLOWED_EXTENSIONS } = require('./upload');

/**
 * Writes an uploaded (memory-storage) file to UPLOAD_PATH/<type>/.
 *
 * The stored name is crypto-random — never derived from user input — and keeps
 * only an allow-listed extension, so a crafted name cannot overwrite files or
 * smuggle an executable type. `filename` is accepted for call-site
 * compatibility but no longer used. Returns the stored file name, or null.
 */
function saveFile(file, type, filename) { // eslint-disable-line no-unused-vars
  if (!process.env.UPLOAD_PATH) {
    console.warn('⚠️  UPLOAD_PATH is not set — skipping file save.');
    return null;
  }
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw Object.assign(new Error('Unsupported file type'), { status: 400, expose: true });
  }
  const fullfilename = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  const folderPath = path.join(process.env.UPLOAD_PATH, path.basename(String(type || '')));
  const fullFilePath = path.join(folderPath, fullfilename);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  fs.writeFileSync(fullFilePath, file.buffer);
  return fullfilename;
}

module.exports = {
  saveFile,
};
