const axios = require("axios");
const { query } = require("../db");

/**
 * One time setup (not run on every deploy): register a webhook subscription
 * pointed at BASE_URL + /webhooks/calendly for the "invitee.created" event,
 * using your Calendly Personal Access Token. See:
 * https://developer.calendly.com/api-docs — Webhook Subscriptions.
 */
async function registerWebhook() {
  const res = await axios.post(
    "https://api.calendly.com/webhook_subscriptions",
    {
      url: `${process.env.BASE_URL}/webhooks/calendly`,
      events: ["invitee.created"],
      scope: "user"
    },
    { headers: { Authorization: `Bearer ${process.env.CALENDLY_PERSONAL_ACCESS_TOKEN}` } }
  );
  return res.data;
}

/**
 * Handles the invitee.created payload: matches the booking to a lead by the
 * invitee's email address and logs the meeting on that lead's timeline.
 */
async function handleInviteeCreated(payload) {
  const invitee = payload.payload;
  const email = invitee.email;
  const scheduledAt = invitee.event ? invitee.event.start_time : invitee.created_at;

  const leadRes = await query("SELECT * FROM leads WHERE email = $1", [email]);
  if (!leadRes.rows.length) return null;
  const lead = leadRes.rows[0];

  await query(
    `INSERT INTO communications (record_type, record_id, channel, direction, subject, occurred_at)
     VALUES ('lead', $1, 'meeting', 'outbound', 'Call booked via Calendly', $2)`,
    [lead.id, scheduledAt]
  );
  await query("UPDATE leads SET last_contact_at = now() WHERE id = $1", [lead.id]);
  return lead.id;
}

module.exports = { registerWebhook, handleInviteeCreated };
