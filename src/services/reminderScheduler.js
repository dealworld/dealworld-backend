const cron = require("node-cron");
const { query } = require("../db");
const { pollInbox, sendEmail } = require("../integrations/gmail");
const { sendSms } = require("../integrations/twilio");
const { sendRinglessVoicemail } = require("../integrations/ringlessVoicemail");
const { syncRecentMeetings } = require("../integrations/fathom");
const { reminderEmailsEnabled, logSkippedReminder } = require("../reminderFlag");

const NDA_REMINDER_DAYS = [3, 6, 9]; // email at day 3, text at day 6, RVM at day 9 since NDA sent
const GONE_QUIET_BUYER_DAYS = 7;
const GONE_QUIET_SELLER_DAYS = 14;

/**
 * Every buyer lead sitting in "NDA Sent" without a signed NDA gets a staged
 * reminder: an email first, then a text, then a ringless voicemail drop,
 * each logged so you can see what has already gone out.
 */
async function runNdaReminders() {
  const pending = await query(
    `SELECT l.*, d.sent_at AS nda_sent_at, d.id AS document_id
     FROM leads l
     JOIN documents d ON d.lead_id = l.id AND d.type = 'NDA'
     WHERE l.stage = 'NDA Sent' AND d.status IN ('sent','viewed')`
  );

  for (const lead of pending.rows) {
    const daysSinceSent = Math.floor((Date.now() - new Date(lead.nda_sent_at).getTime()) / 86400000);
    const alreadySent = await query(
      `SELECT COUNT(*) FROM communications
       WHERE record_type = 'lead' AND record_id = $1 AND subject LIKE 'NDA reminder%'
         AND occurred_at > $2`,
      [lead.id, lead.nda_sent_at]
    );
    const remindersLoggedSoFar = parseInt(alreadySent.rows[0].count, 10);

    if (daysSinceSent >= NDA_REMINDER_DAYS[0] && remindersLoggedSoFar === 0) {
      // Checked right before the send. Skipping it also holds back the text and
      // voicemail steps, which only fire after this email has been logged.
      if (!reminderEmailsEnabled()) {
        logSkippedReminder(`NDA reminder email to lead ${lead.id}`);
        continue;
      }
      const body = `Hi ${lead.name}, just following up — the NDA for ${lead.listing_ref || "the listing"} is still waiting on your signature. Let me know if you have any questions.`;
      await sendEmail({ to: lead.email, subject: "NDA reminder — still waiting on your signature", body });
      await logReminder(lead.id, "NDA reminder (email)");
    } else if (daysSinceSent >= NDA_REMINDER_DAYS[1] && remindersLoggedSoFar === 1 && lead.phone) {
      await sendSms({ to: lead.phone, body: `Hi ${lead.name}, this is Max — following up on the NDA for the listing you inquired about. Can you take a look today?` });
      await logReminder(lead.id, "NDA reminder (text)");
    } else if (daysSinceSent >= NDA_REMINDER_DAYS[2] && remindersLoggedSoFar === 2 && lead.phone) {
      if (process.env.DROPCOWBOY_AUDIO_ID) {
        await sendRinglessVoicemail({ phone: lead.phone, audioId: process.env.DROPCOWBOY_AUDIO_ID });
        await logReminder(lead.id, "NDA reminder (ringless voicemail)");
      }
    }
  }
}

async function logReminder(leadId, subject) {
  await query(
    `INSERT INTO communications (record_type, record_id, channel, direction, subject)
     VALUES ('lead', $1, 'email', 'outbound', $2)`,
    [leadId, subject]
  );
}

/**
 * Finds every open lead with no logged contact within the threshold for its
 * type, and emails you a single digest listing all of them.
 */
async function runGoneQuietDigest() {
  const stale = await query(
    `SELECT name, type, stage, last_contact_at,
            EXTRACT(DAY FROM now() - last_contact_at) AS days_quiet
     FROM leads
     WHERE stage != 'Closed'
       AND (
         (type = 'buyer' AND last_contact_at < now() - ($1 || ' days')::interval)
         OR
         (type = 'seller' AND last_contact_at < now() - ($2 || ' days')::interval)
       )
     ORDER BY days_quiet DESC`,
    [GONE_QUIET_BUYER_DAYS, GONE_QUIET_SELLER_DAYS]
  );

  if (!stale.rows.length) return;

  const lines = stale.rows.map(
    (r) => `- ${r.name} (${r.type}, ${r.stage}) — ${Math.floor(r.days_quiet)} days quiet`
  );
  if (!reminderEmailsEnabled()) {
    logSkippedReminder(`gone quiet digest (${stale.rows.length} leads)`);
    return;
  }
  const body = `Good morning. These leads have gone quiet and could use a touch:\n\n${lines.join("\n")}`;
  await sendEmail({
    to: process.env.GMAIL_SEND_AS_ADDRESS,
    subject: `DealWorld 2.0 — ${stale.rows.length} lead(s) gone quiet`,
    body
  });
}

function start() {
  // Poll the inbox every 5 minutes for new BizBuySell leads and replies.
  cron.schedule("*/5 * * * *", () => pollInbox().catch((e) => console.error("pollInbox failed", e)));

  // Run the NDA reminder sequence every morning at 8am.
  cron.schedule("0 8 * * *", () => runNdaReminders().catch((e) => console.error("runNdaReminders failed", e)));

  // Send the gone quiet digest every morning at 7am, before reminders go out.
  cron.schedule("0 7 * * *", () => runGoneQuietDigest().catch((e) => console.error("runGoneQuietDigest failed", e)));

  // Sync Fathom meeting transcripts every hour.
  cron.schedule("0 * * * *", () =>
    syncRecentMeetings({ sinceIso: new Date(Date.now() - 3600 * 1000).toISOString() }).catch((e) =>
      console.error("syncRecentMeetings failed", e)
    )
  );

  console.log("DealWorld 2.0 scheduler started.");
}

module.exports = { start, runNdaReminders, runGoneQuietDigest };
