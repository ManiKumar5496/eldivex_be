/**
 * get the folder name based on type of document.
 *
 * @param {string} document_type_name - Name of the document type
 * @returns {string} Returns the folder name .
 *
 * 
 */
 function fetchFolderName(document_type_name) {
    folder_map = {
       'user_image' : 'profile',
       'hp_reg_education_certificate' : 'hp_reg_education_certificate',
       'hp_reg_photo':'hp_reg_photo',
'hp_reg_identity_proof_front_image':'hp_reg_identity_proof_front_image',
'hp_reg_identity_proof_back_image':'hp_reg_identity_proof_back_image',
'banner_photo':'client_app_banners'
      
       
       
   };
   try
   {
       return folder_map[document_type_name];
   }
   catch (ex)
   {
       return ""; // No folder name found
   }
   
}

module.exports = {
   fetchFolderName
}