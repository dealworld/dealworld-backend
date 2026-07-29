const { google } = require("googleapis");
const { query } = require("../db");
const { sendNda } = require("./boldsign");
const { detectTask } = require("../ai/aiEngine");

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function authUrl() {
  const oauth2Client = oauthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify"
    ]
  });
}

async function handleOAuthCallback(code) {
  const oauth2Client = oauthClient();
  const { tokens } = await oauth2Client.getToken(code);
  // tokens.refresh_token only comes back the first time you consent.
  // Store it in your .env (or secrets manager) as GOOGLE_REFRESH_TOKEN.
  return tokens;
}

function gmailClient() {
  const oauth2Client = oauthClient();
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

function decodeBody(payload) {
  // Gmail bodies are base64url encoded, and may be nested in multipart messages.
  function walk(part) {
    if (part.body && part.body.data) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (part.parts) {
      for (const p of part.parts) {
        const found = walk(p);
        if (found) return found;
      }
    }
    return "";
  }
  return walk(payload);
}

function headerValue(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

/**
 * Parses the "Inquirer's Information" block out of a BizBuySell notification,
 * whether it arrived directly or forwarded through the tworld inbox (which wraps
 * the original message under a "Fwd:" subject with the original headers pushed
 * down into the body).
 */
function parseBizBuySellBody(bodyText) {
  const get = (label) => {
    const re = new RegExp(label + "\\s*:?\\s*([^\\n\\r]+)", "i");
    const m = bodyText.match(re);
    return m ? m[1].trim() : "";
  };
  const listingIdMatch = bodyText.match(/Listing ID\s*:?\s*(\d+)/i);
  const refIdMatch = bodyText.match(/Ref ID\s*:?\s*([\w-]+)/i);
  const headlineMatch = bodyText.match(/Headline\s*:?\s*([^\n\r]+)/i);

  return {
    contactName: get("Contact Name"),
    contactEmail: get("Contact Email"),
    contactPhone: get("Contact Phone"),
    contactZip: get("Contact Zip"),
    ableToInvest: get("Able to Invest"),
    purchaseWithin: get("Purchase Within"),
    listingId: listingIdMatch ? listingIdMatch[1] : "",
    refId: refIdMatch ? refIdMatch[1] : "",
    headline: headlineMatch ? headlineMatch[1] : ""
  };
}

function looksLikeBizBuySellLead(fromHeader, subjectHeader, bodyText) {
  const fromMatch = /interest@bizbuysell\.com/i.test(fromHeader);
  const forwardedMatch = /bizbuysell/i.test(bodyText) && /Inquirer.?s Information/i.test(bodyText);
  const subjectMatch = /Business.?for.?sale listing/i.test(subjectHeader);
  return fromMatch || forwardedMatch || subjectMatch;
}

/**
 * Polls Gmail for unread messages, and for each one:
 *  - if it's a new BizBuySell lead: creates the lead, sends the NDA, logs the activity
 *  - if it's a reply on a thread tied to an existing lead: logs it and clears "gone quiet"
 *  - either way: runs the AI task detector and creates a task if one is implied
 * Call this on a schedule (see services/reminderScheduler.js) — e.g. every 5-10 minutes.
 */
async function pollInbox() {
  const gmail = gmailClient();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults: 25
  });

  const messages = list.data.messages || [];
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
    const headers = full.data.payload.headers;
    const from = headerValue(headers, "From");
    const subject = headerValue(headers, "Subject");
    const threadId = full.data.threadId;
    const bodyText = decodeBody(full.data.payload);

    // 1. Is this thread already tied to an existing lead? If so, log the reply.
    const existing = await query("SELECT * FROM leads WHERE gmail_thread_id = $1", [threadId]);
    if (existing.rows.length) {
      const lead = existing.rows[0];
      await query(
        `INSERT INTO communications (record_type, record_id, channel, direction, subject, body, gmail_message_id)
         VALUES ('lead', $1, 'email', 'inbound', $2, $3, $4)`,
        [lead.id, subject, bodyText, m.id]
      );
      await query("UPDATE leads SET last_contact_at = now() WHERE id = $1", [lead.id]);
      await maybeCreateTaskFromMessage({ recordId: lead.id, body: bodyText, channel: "email" });
      await gmail.users.messages.modify({ userId: "me", id: m.id, requestBody: { removeLabelIds: ["UNREAD"] } });
      continue;
    }

    // 2. Is this a new BizBuySell inquiry?
    if (looksLikeBizBuySellLead(from, subject, bodyText)) {
      const parsed = parseBizBuySellBody(bodyText);
      const inserted = await query(
        `INSERT INTO leads (name, email, phone, type, source, listing_ref, gmail_thread_id, buyer_industry_pref)
         VALUES ($1, $2, $3, 'buyer', 'BizBuySell', $4, $5, $6)
         RETURNING *`,
        [
          parsed.contactName || "Unknown buyer",
          parsed.contactEmail,
          parsed.contactPhone,
          `${parsed.headline} (Ref ${parsed.refId || parsed.listingId})`,
          threadId,
          parsed.ableToInvest
        ]
      );
      const lead = inserted.rows[0];

      await query(
        `INSERT INTO communications (record_type, record_id, channel, direction, subject, body, gmail_message_id)
         VALUES ('lead', $1, 'email', 'inbound', $2, $3, $4)`,
        [lead.id, subject, bodyText, m.id]
      );

      // BizBuySell tells you to respond within 3 business days — create that task now.
      const dueDate = addBusinessDays(new Date(), 3);
      await query(
        `INSERT INTO tasks (record_type, record_id, title, due_date, auto_generated)
         VALUES ('lead', $1, 'Respond to new BizBuySell inquiry', $2, true)`,
        [lead.id, dueDate.toISOString().slice(0, 10)]
      );

      // Send the NDA automatically.
      await sendNda({ lead });

      await gmail.users.messages.modify({ userId: "me", id: m.id, requestBody: { removeLabelIds: ["UNREAD"] } });
      continue;
    }

    // 3. Not tied to a known lead and not a BizBuySell inquiry — leave it alone.
    // (Left as unread so it doesn't get silently swallowed; a future pass could
    // fuzzy-match by sender email against contacts/provisors here as well.)
  }
}

async function maybeCreateTaskFromMessage({ recordId, body, channel }) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await detectTask({ body, channel, today });
  if (result.needsTask) {
    await query(
      `INSERT INTO tasks (record_type, record_id, title, due_date, auto_generated)
       VALUES ('lead', $1, $2, $3, true)`,
      [recordId, result.title, result.suggestedDueDate || today]
    );
  }
}

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

/**
 * Sends an email through the connected Gmail account (used for NDA/CIM sends
 * that go through Gmail directly rather than through BoldSign's own mailer,
 * and for mass outreach / newsletter sends).
 */
async function sendEmail({ to, subject, body, threadId }) {
  const gmail = gmailClient();
  const messageParts = [
    `To: ${to}`,
    `From: ${process.env.GMAIL_SEND_AS_ADDRESS}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ];
  const raw = Buffer.from(messageParts.join("\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId }
  });
  return res.data;
}

module.exports = { authUrl, handleOAuthCallback, pollInbox, sendEmail, parseBizBuySellBody };
