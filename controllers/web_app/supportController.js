const supportModel = require('../../models/web_app/supportModel');
const db = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { sendEmail } = require('../../utils/emailService');
const { supportTicketCreated } = require('../../utils/emailTemplates');
const { logAudit } = require('../../utils/auditLogger'); // Phase 4.2
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope'); // Phase 5
const { notifyOrgAdmins } = require('../../utils/notify');
const { getClientContact } = require('../../utils/clientContact');
const { guardOrgHandlers, resolveRequestOrgId } = require('../../utils/requestOrg');

const createSupportTicket = async (req, res) => {
  try {
    const {
      user_id,
      support_type_id,
      start_date,
      end_date,
      title,
      description,
      comments,
      conversionlog_details,
      created_by_employee,
      booking_details,
    } = req.body;
    const orgId = getOrgId(req);

    // Category and client must belong to the caller's org.
    if (support_type_id && support_type_id !== 'NA') {
      const cat = await db('edx_support_category').where({ id: support_type_id, org_id: orgId }).first('id');
      if (!cat) return res.status(404).json({ message: 'Support category not found.' });
    }
    if (user_id && user_id !== 'NA') {
      const client = await db('edx_client_app_users').where({ id: user_id, org_id: orgId }).first('id');
      if (!client) return res.status(404).json({ message: 'Client not found.' });
    }

    const [id] = await db('edx_support_requests').insert(withOrg(req, {
      user_id:                user_id                ? user_id                : 'NA',
      support_type_id:        support_type_id        ? support_type_id        : 'NA',
      start_date:             start_date             ? start_date             : null,
      end_date:               end_date               ? end_date               : null,
      title:                  title                  ? title                  : 'NA',
      description:            description            ? description            : 'NA',
      comments:               comments               ? comments               : 'NA',
      conversionlog_details:  conversionlog_details  ? conversionlog_details  : 'NA',
      created_by_employee:    created_by_employee    ? created_by_employee    : 'NA',
      booking_details:        booking_details        ? booking_details        : 'NA',
      created_on:             getCurrentDateTime(),
    }));

    res.status(201).json({ message: 'Support request created successfully.' });

    // ── Audit log (Phase 4.2, fire-and-forget) ──────────────────────────────
    logAudit({
      entityType: 'SUPPORT_TICKET',
      entityId:   id,
      action:     'CREATE',
      changedBy:  req.login_data?.id || null,
      org_id:     orgId,
      newValues:  { id, title, support_type_id, user_id },
    });

    notifyOrgAdmins(orgId, {
      type:  'support',
      title: `New support ticket #${id}`,
      body:  title && title !== 'NA' ? title : 'A new support request was raised.',
      data:  { ticket_id: id, route: 'support' },
    });

    // ── Send ACK email to client (non-blocking) ──────────────────────────────
    setImmediate(async () => {
      try {
        if (user_id && user_id !== 'NA') {
          // Ticket user_id is a CLIENT id — resolve it in edx_client_app_users.
          const user = await getClientContact(user_id, orgId);
          if (user && user.user_email) {
            const tpl = supportTicketCreated({
              clientName: user.user_name || 'Client',
              ticketId:   id,
              title:      title || 'Support Request',
            });
            await sendEmail({ to: user.user_email, ...tpl });
          }
        }
      } catch (emailErr) {
        logger.warn(`[email] Support ticket email failed for ticket #${id}: ${emailErr.message}`);
      }
    });

  } catch (err) {
    logger.error(`Error creating support request: ${err.message}`);
    console.error(err);
    res.status(500).json({ message: 'Error creating support request.' });
  }
};

const getSupportTickets = async (req, res) => {
  try {
    const filters = req.query;
    const data = await supportModel.getSupportModel(filters, req.login_data);
    res.json(data);
  } catch (err) {
    logger.error(`Error fetching support tickets: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching support tickets' });
  }
};

// Public (used before login too): org from a tenant token or ?org_id / ?org_code.
// Without an org we refuse instead of returning every tenant's categories.
const getSupportCategory = async (req, res) => {
  try {
    const orgId = await resolveRequestOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org context is required' });
    const appType = ['web', 'client', 'hp'].includes(req.query.app_type) ? req.query.app_type : null;
    const data = await supportModel.getSupportCategoryData(req.query, orgId, appType);
    res.json(data);
  } catch (err) {
    logger.error(`Error fetching support categories: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching support categories' });
  }
};

/**
 * GET /api/getSupportStats
 * Returns server-side aggregated support ticket statistics.
 * Replaces hardcoded "2.4h" value in the Flutter support module.
 *
 * Response shape:
 * {
 *   open_tickets:        number,
 *   in_progress_tickets: number,
 *   resolved_today:      number,
 *   avg_response_hours:  string   // e.g. "3.2h", "N/A"
 * }
 */
const getSupportStats = async (req, res) => {
  try {
    const orgId = getOrgId(req);

    // Open tickets (status = 1)
    const [{ open_tickets }] = await db('edx_support_requests')
      .where({ status: 1, org_id: orgId })
      .count('id as open_tickets');

    // In-progress tickets (status = 2)
    const [{ in_progress_tickets }] = await db('edx_support_requests')
      .where({ status: 2, org_id: orgId })
      .count('id as in_progress_tickets');

    // Resolved today (status = 3 and updated_on is today)
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const [{ resolved_today }] = await db('edx_support_requests')
      .where({ status: 3, org_id: orgId })
      .whereRaw('DATE(updated_on) = ?', [todayStr])
      .count('id as resolved_today');

    // Average response time (hours) for resolved tickets
    // updated_on and created_on are stored as string columns — parse via STR_TO_DATE
    const [avgRow] = await db('edx_support_requests')
      .where({ status: 3, org_id: orgId })
      .whereNotNull('updated_on')
      .select(
        db.raw(
          `AVG(TIMESTAMPDIFF(MINUTE,
            STR_TO_DATE(created_on, '%Y-%m-%dT%H:%i:%s.%fZ'),
            STR_TO_DATE(updated_on, '%Y-%m-%dT%H:%i:%s.%fZ')
          )) AS avg_minutes`
        )
      );

    let avg_response_hours = 'N/A';
    if (avgRow && avgRow.avg_minutes != null) {
      const hours = (avgRow.avg_minutes / 60).toFixed(1);
      avg_response_hours = `${hours}h`;
    }

    res.json({
      open_tickets:        Number(open_tickets)        || 0,
      in_progress_tickets: Number(in_progress_tickets) || 0,
      resolved_today:      Number(resolved_today)      || 0,
      avg_response_hours,
    });
  } catch (err) {
    logger.error(`Error fetching support stats: ${err.message}`);
    res.status(500).json({ error: 'An error occurred while fetching support stats' });
  }
};

// GET /getSupportClient?user_id=N | ?booking_id=N — the client a ticket is
// for, so the create form can show the name under User Id and fill User Id
// from a Booking ID. Both lookups are limited to the caller's org.
const getSupportClient = async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const bookingId = parseInt(req.query.booking_id, 10);
    let userId = parseInt(req.query.user_id, 10);

    if (Number.isInteger(bookingId)) {
      const booking = await db('edx_bookings')
        .where({ id: bookingId, org_id: orgId })
        .first('user_id');
      if (!booking) return res.status(404).json({ message: 'Booking not found.' });
      userId = booking.user_id;
    } else if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'user_id or booking_id is required.' });
    }

    const client = await db('edx_client_app_users')
      .where({ id: userId, org_id: orgId })
      .first('id', 'user_name', 'phone_number');
    if (!client) return res.status(404).json({ message: 'Client not found.' });

    res.json({
      booking_id:   Number.isInteger(bookingId) ? bookingId : null,
      user_id:      client.id,
      user_name:    client.user_name,
      phone_number: client.phone_number,
    });
  } catch (error) {
    logger.error(`[supportController] getSupportClient error: ${error.message}`);
    res.status(500).json({ message: 'Failed to look up the client.' });
  }
};

module.exports = guardOrgHandlers({
  createSupportTicket,
  getSupportClient,
  getSupportTickets,
  getSupportCategory,
  getSupportStats,
}, ['getSupportCategory']);
