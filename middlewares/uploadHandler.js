
require('dotenv').config();
const fs = require('fs');
const path = require('path');
// console.log(path)

function saveFile(file, type, filename) {
    if (!process.env.UPLOAD_PATH) {
      console.warn('⚠️  UPLOAD_PATH is not set — skipping file save for:', filename);
      return null;
    }
    const ext = path.extname(file.originalname);
    const fullfilename = `${filename}${ext}`;
    const folderPath = path.join(process.env.UPLOAD_PATH, type);
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