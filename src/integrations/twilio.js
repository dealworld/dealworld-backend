const twilio = require("twilio");
const { query } = require("../db");
const { detectTask } = require("../ai/aiEngine");

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSms({ to, body }) {
  const res = await client().messages.create({
    to,
    from: process.env.TWILIO_FROM_NUMBER,
    body
  });
  return res.sid;
}

async function sendBulkSms({ recipients, body }) {
  // recipients: [{ phone, name }]
  const results = [];
  for (const r of recipients) {
    const personalized = body.replace(/\{\{name\}\}/g, r.name || "there");
    const sid = await sendSms({ to: r.phone, body: personalized });
    results.push({ phone: r.phone, sid });
  }
  return results;
}

/**
 * Twilio webhook target for inbound SMS (set this URL as the "A message comes in"
 * webhook on your Twilio phone number: BASE_URL + /webhooks/twilio/inbound).
 * Matches the sender's phone number back to a lead and logs the reply.
 */
async function handleInboundSms({ From, Body, MessageSid }) {
  const normalizedPhone = From.replace(/\D/g, "").slice(-10); // last 10 digits, loose match
  const leadRes = await query(
    `SELECT * FROM leads WHERE regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $1`,
    [normalizedPhone]
  );
  if (!leadRes.rows.length) return null;

  const lead = leadRes.rows[0];
  await query(
    `INSERT INTO communications (record_type, record_id, channel, direction, body, twilio_sid)
     VALUES ('lead', $1, 'text', 'inbound', $2, $3)`,
    [lead.id, Body, MessageSid]
  );
  await query("UPDATE leads SET last_contact_at = now() WHERE id = $1", [lead.id]);

  const today = new Date().toISOString().slice(0, 10);
  const taskCheck = await detectTask({ body: Body, channel: "text", today });
  if (taskCheck.needsTask) {
    await query(
      `INSERT INTO tasks (record_type, record_id, title, due_date, auto_generated)
       VALUES ('lead', $1, $2, $3, true)`,
      [lead.id, taskCheck.title, taskCheck.suggestedDueDate || today]
    );
  }
  return lead.id;
}

module.exports = { sendSms, sendBulkSms, handleInboundSms };
