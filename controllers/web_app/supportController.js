const supportModel = require('../../models/web_app/supportModel');
const db = require('../../config/db');
const logger = require('../../logger');
const { getCurrentDateTime } = require('../../utils/dateTime');
const { sendEmail } = require('../../utils/emailService');
const { supportTicketCreated } = require('../../utils/emailTemplates');
const { logAudit } = require('../../utils/auditLogger'); // Phase 4.2
const { withOrg, orgQuery, getOrgId } = require('../../utils/orgScope'); // Phase 5

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
      org_id:     req.login_data?.org_id ?? 1,
      newValues:  { id, title, support_type_id, user_id },
    });

    // ── Send ACK email to client (non-blocking) ──────────────────────────────
    setImmediate(async () => {
      try {
        if (user_id && user_id !== 'NA') {
          const user = await db('edx_web_app_users')
            .where({ id: user_id })
            .select('user_email', 'user_name')
            .first();
          if (user && user.user_email && user.user_email !== 'NA') {
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

const getSupportCategory = async (req, res) => {
  try {
    const filters = req.query;
    const data = await supportModel.getSupportCategoryData(filters);
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

module.exports = {
  createSupportTicket,
  getSupportTickets,
  getSupportCategory,
  getSupportStats,
};
