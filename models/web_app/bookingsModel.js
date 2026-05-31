const db = require('../../config/db');
const applyBranchFilter = require('../../utils/applyBranchFilter');

// async function getUserBookingsModel(filters = {} , login_data) {
//   const { user_id, id } = filters;

//   let query = db('edx_bookings')
//     .select(
//       'edx_bookings.*',
//       db.raw(`
//         CASE 
//           WHEN edx_bookings.status = 1 THEN 'Booking Submitted'
//           WHEN edx_bookings.status = 2 THEN 'HP Assigned'
//           WHEN edx_bookings.status = 3 THEN 'Booking Cancelled'
//           WHEN edx_bookings.status = 4 THEN 'Service Started'
//           WHEN edx_bookings.status = 5 THEN 'service on hold'
//           WHEN edx_bookings.status = 6 THEN 'Service cancelled'
//           WHEN edx_bookings.status = 7 THEN 'Service Suspended'
//           ELSE 'Unknown'
//         END AS status
//       `),

//       // user fields
//       'edx_client_app_users.user_name as user_name',
//       'edx_client_app_users.phone_number as user_mobile',
//       'edx_client_app_users.user_email as user_email',

//       // address fields
//       'edx_user_address.address_tag_name',
//       'edx_user_address.city',
//       'edx_user_address.state',
//       'edx_user_address.country',
//       'edx_user_address.address_line1',
//       'edx_user_address.address_line2',
//       'edx_user_address.landmark',
//       'edx_user_address.locality',
//       'edx_user_address.pincode',

//       // patient fields
//       'edx_patient.patient_name as patient_name',
//       'edx_patient.age as patient_age',
//       'edx_patient.gender as patient_gender',
//       'edx_patient.phone_number as patient_phone_number',
//       'edx_patient.email as patient_email',
//       'edx_patient.yob as patient_yob',
//       'edx_patient.weight as patient_weight',

//       // care manager fields
//       'edx_web_app_users.user_name as caremanager_name',
//       'edx_web_app_users.user_mobile as caremanager_mobile',


    
//         // service type  fields
//         'edx_master_services.name as service_name',
//         db.raw(`
//         CASE 
//           WHEN edx_master_services.service_type = 1 THEN 'Normal Service'
//           WHEN edx_master_services.service_type = 2 THEN 'Premium Service'
//           ELSE 'Unknown'
//         END AS service_type_name
//       `)
//     )
//     .leftJoin(
//       'edx_client_app_users',
//       'edx_client_app_users.id',
//       'edx_bookings.user_id'
//     )
//     .leftJoin(
//       'edx_user_address',
//       'edx_user_address.id',
//       'edx_bookings.address_id'
//     )
//     .leftJoin(
//       'edx_patient',
//       'edx_patient.id',
//       'edx_bookings.patient_id'
//     )
//     .leftJoin(
//       'edx_web_app_users',
//       'edx_web_app_users.id',
//       'edx_bookings.hp_manager'
//     )
//     .leftJoin(
//       'edx_master_services',
//       'edx_master_services.id',
//       'edx_bookings.service_type_id'
//     )
//     // .where('edx_bookings.status', '1');

//     query = applyBranchFilter(query, login_data, 'edx_bookings.branch_id');
//     if (user_id && user_id !== 'NULL') query.where('edx_bookings.user_id', user_id);
//   if (id) query.where('edx_bookings.id', id);
// //  console.log(query.toString());
// //  console.log(login_data);
//   return query;
// }
async function getUserBookingsModel(filters = {}, login_data) {
  const { user_id, id } = filters;

  let query = db('edx_bookings')
    .select(
      'edx_bookings.*',
      db.raw(`
        CASE 
          WHEN edx_bookings.status = 1 THEN 'Booking Submitted'
          WHEN edx_bookings.status = 2 THEN 'HP Assigned'
          WHEN edx_bookings.status = 3 THEN 'Booking Cancelled'
          WHEN edx_bookings.status = 4 THEN 'Service Started'
          WHEN edx_bookings.status = 5 THEN 'service on hold'
          WHEN edx_bookings.status = 6 THEN 'Service cancelled'
          WHEN edx_bookings.status = 7 THEN 'Service Suspended'
          ELSE 'Unknown'
        END AS status
      `),

      // user fields
      'edx_client_app_users.user_name as user_name',
      'edx_client_app_users.phone_number as user_mobile',
      'edx_client_app_users.user_email as user_email',

      // address fields
      'edx_user_address.address_tag_name',
      'edx_user_address.city',
      'edx_user_address.state',
      'edx_user_address.country',
      'edx_user_address.address_line1',
      'edx_user_address.address_line2',
      'edx_user_address.landmark',
      'edx_user_address.locality',
      'edx_user_address.pincode',

      // patient fields
      'edx_patient.patient_name as patient_name',
      'edx_patient.age as patient_age',
      'edx_patient.gender as patient_gender',
      'edx_patient.phone_number as patient_phone_number',
      'edx_patient.email as patient_email',
      'edx_patient.yob as patient_yob',
      'edx_patient.weight as patient_weight',

      // care manager fields
      'edx_web_app_users.user_name as caremanager_name',
      'edx_web_app_users.user_mobile as caremanager_mobile',

      // branch fields
      'edx_branches.br_name as branch_name',
      'edx_branches.br_city as branch_city',

      // service type fields
      'edx_master_services.name as service_name',
      db.raw(`
        CASE 
          WHEN edx_master_services.service_type = 1 THEN 'Normal Service'
          WHEN edx_master_services.service_type = 2 THEN 'Premium Service'
          ELSE 'Unknown'
        END AS service_type_name
      `),
      // ✅ Single extension status field
db.raw(`
CASE 
  WHEN DATE(edx_bookings.service_end_date) = CURDATE() THEN 1
  WHEN DATE(edx_bookings.service_end_date) = DATE_ADD(CURDATE(), INTERVAL 1 DAY) THEN 2
  WHEN DATE(edx_bookings.service_end_date) = DATE_ADD(CURDATE(), INTERVAL 2 DAY) THEN 3
  ELSE 0
END AS extension_status
`),

      // ✅ Only open status flags for hold (id=4) and cancel (id=6) tickets
      db.raw(`
        CASE WHEN hold_ticket.id IS NOT NULL THEN 1 ELSE 0 END AS hold_ticket_open
      `),
      db.raw(`
        CASE WHEN cancel_ticket.id IS NOT NULL THEN 1 ELSE 0 END AS cancellation_ticket_open
      `)
    )
    .leftJoin('edx_client_app_users', 'edx_client_app_users.id', 'edx_bookings.user_id')
    .leftJoin('edx_user_address', 'edx_user_address.id', 'edx_bookings.address_id')
    .leftJoin('edx_patient', 'edx_patient.id', 'edx_bookings.patient_id')
    .leftJoin('edx_web_app_users', 'edx_web_app_users.id', 'edx_bookings.hp_manager')
    .leftJoin('edx_master_services', 'edx_master_services.id', 'edx_bookings.service_type_id')
    .leftJoin('edx_branches', 'edx_branches.br_id', 'edx_bookings.branch_id')

    // ✅ Hold ticket - support_type_id = 4, status = 1 (open)
    .leftJoin('edx_support_requests as hold_ticket', function () {
      this.on('hold_ticket.booking_details', '=', 'edx_bookings.id')
          .andOnVal('hold_ticket.support_type_id', '=', 4)
          .andOnVal('hold_ticket.status', '=', 1);
    })

    // ✅ Cancel ticket - support_type_id = 6, status = 1 (open)
    .leftJoin('edx_support_requests as cancel_ticket', function () {
      this.on('cancel_ticket.booking_details', '=', 'edx_bookings.id')
          .andOnVal('cancel_ticket.support_type_id', '=', 6)
          .andOnVal('cancel_ticket.status', '=', 1);
    });

  query = applyBranchFilter(query, login_data, 'edx_bookings.branch_id');
  query.where('edx_bookings.org_id', login_data?.org_id ?? 1);
  if (user_id && user_id !== 'NULL') query.where('edx_bookings.user_id', user_id);
  if (id) query.where('edx_bookings.id', id);

  return query;
}
async function getHPByBookingModel(filters = {} , login_data) {
  const { bkng_id, hp_unique_id } = filters;

  let query = db('edx_booking_hp')
  .select(
    'edx_booking_hp.*',
    'edx_hp_registration.*'   // or select specific columns instead of *
  )
  .join(
    'edx_hp_registration',
    'edx_booking_hp.hp_unique_id',
    '=',
    'edx_hp_registration.hp_reg_id'
  );

  query.where('edx_booking_hp.org_id', login_data?.org_id ?? 1);
  if (bkng_id && bkng_id !== 'NULL') query.where('edx_booking_hp.bkng_id', bkng_id);
  if (hp_unique_id) query.where('edx_booking_hp.id', hp_unique_id);
  console.log(query.toString());
  return query;
}




  async function getOTP (bkng_id, hp_unique_id) {

      const result = await db('edx_booking_hp')
          .select('otp', 'bkng_id', 'hp_unique_id')
          .where({ bkng_id, hp_unique_id })
          .whereIn('status', [3, 4])   // 3 = Finalized (OTP active), 4 = Active HP (OTP used)
          .first();

      return result || null;
  }





module.exports = {
 
    getUserBookingsModel,
    getOTP,
    getHPByBookingModel
    
   
   
    
    };

