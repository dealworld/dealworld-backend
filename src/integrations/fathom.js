const axios = require("axios");
const { query } = require("../db");

const FATHOM_BASE = "https://api.fathom.ai/v1"; // confirm exact base path in Fathom's current API docs

function client() {
  return axios.create({
    baseURL: FATHOM_BASE,
    headers: { Authorization: `Bearer ${process.env.FATHOM_API_KEY}` }
  });
}

/**
 * Polls Fathom for meetings completed since a given time, matches each one to
 * a lead by attendee email, and attaches the transcript URL and AI summary to
 * that lead's communication timeline. Call this on a schedule (e.g. hourly) —
 * see services/reminderScheduler.js.
 */
async function syncRecentMeetings({ sinceIso }) {
  const res = await client().get("/meetings", { params: { since: sinceIso } });
  const meetings = res.data.meetings || [];

  for (const meeting of meetings) {
    const attendeeEmails = (meeting.attendees || []).map((a) => a.email).filter(Boolean);
    if (!attendeeEmails.length) continue;

    const leadRes = await query("SELECT * FROM leads WHERE email = ANY($1)", [attendeeEmails]);
    if (!leadRes.rows.length) continue;
    const lead = leadRes.rows[0];

    await query(
      `INSERT INTO communications
         (record_type, record_id, channel, direction, subject, summary, transcript_url, occurred_at)
       VALUES ('lead', $1, 'meeting', 'outbound', $2, $3, $4, $5)`,
      [lead.id, meeting.title || "Call", meeting.summary || "", meeting.transcript_url || "", meeting.recorded_at]
    );
    await query("UPDATE leads SET last_contact_at = now() WHERE id = $1", [lead.id]);
  }
  return meetings.length;
}

module.exports = { syncRecentMeetings };
