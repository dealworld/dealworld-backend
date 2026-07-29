const axios = require("axios");
const { query } = require("../db");

const BOLDSIGN_BASE = "https://api.boldsign.com/v1";

function client() {
  return axios.create({
    baseURL: BOLDSIGN_BASE,
    headers: { "X-API-KEY": process.env.BOLDSIGN_API_KEY }
  });
}

/**
 * Sends a document from a BoldSign template, with a custom subject/message and
 * the signer's name/email filled in as merge data. Works for NDA, Marketing
 * Agreement, or APA — pass the right templateId and documentType.
 */
async function sendFromTemplate({ templateId, documentType, lead, customSubject, customMessage }) {
  const payload = {
    templateId,
    title: `${documentType} — ${lead.name}`,
    message: customMessage || `Hi ${lead.name}, please review and sign the attached ${documentType}.`,
    roles: [
      {
        roleIndex: 1,
        signerName: lead.name,
        signerEmail: lead.email,
        // Field values BoldSign will drop into the template's merge fields.
        formFields: [
          { fieldId: "listing_reference", value: lead.listing_ref || "" },
          { fieldId: "date", value: new Date().toISOString().slice(0, 10) }
        ]
      }
    ],
    // BoldSign will POST to this URL on view / sign / decline events.
    // Configure the same URL once in the BoldSign dashboard's webhook settings,
    // scoped to Document events, so this fires for every send automatically.
  };
  if (customSubject) payload.title = customSubject;

  const res = await client().post("/document/sendUsingTemplate", payload);
  const envelopeId = res.data.documentId;

  await query(
    `INSERT INTO documents (lead_id, type, boldsign_envelope_id, status)
     VALUES ($1, $2, $3, 'sent')`,
    [lead.id, documentType, envelopeId]
  );
  await query(
    `INSERT INTO communications (record_type, record_id, channel, direction, subject, body)
     VALUES ('lead', $1, 'email', 'outbound', $2, $3)`,
    [lead.id, payload.title, payload.message]
  );

  return envelopeId;
}

async function sendNda({ lead, customSubject, customMessage }) {
  return sendFromTemplate({
    templateId: process.env.BOLDSIGN_NDA_TEMPLATE_ID,
    documentType: "NDA",
    lead,
    customSubject,
    customMessage
  });
}

async function sendMarketingAgreement({ lead, customSubject, customMessage }) {
  return sendFromTemplate({
    templateId: process.env.BOLDSIGN_MARKETING_AGREEMENT_TEMPLATE_ID,
    documentType: "Marketing",
    lead,
    customSubject,
    customMessage
  });
}

async function sendApa({ lead, customSubject, customMessage }) {
  return sendFromTemplate({
    templateId: process.env.BOLDSIGN_APA_TEMPLATE_ID,
    documentType: "APA",
    lead,
    customSubject,
    customMessage
  });
}

/**
 * Handles BoldSign's webhook payload. Configure this route's full URL
 * (BASE_URL + /webhooks/boldsign) once in the BoldSign dashboard.
 * Expected event types: Viewed, Completed (signed), Declined.
 */
async function handleWebhook(payload) {
  const envelopeId = payload.data && payload.data.documentId;
  const eventType = payload.event && payload.event.eventType; // "Viewed" | "Completed" | "Declined"
  if (!envelopeId) return;

  const docRes = await query("SELECT * FROM documents WHERE boldsign_envelope_id = $1", [envelopeId]);
  if (!docRes.rows.length) return;
  const doc = docRes.rows[0];

  if (eventType === "Viewed") {
    await query("UPDATE documents SET status = 'viewed', viewed_at = now() WHERE id = $1", [doc.id]);
  }

  if (eventType === "Completed") {
    await query("UPDATE documents SET status = 'signed', signed_at = now() WHERE id = $1", [doc.id]);

    if (doc.type === "NDA") {
      await query("UPDATE leads SET stage = 'NDA Signed', last_contact_at = now() WHERE id = $1", [doc.lead_id]);
      // The CIM send is deliberately manual — see routes/documents.js sendCim —
      // since the CIM file itself has to be the one you uploaded for that specific deal.
    }
    if (doc.type === "Marketing") {
      await query("UPDATE leads SET stage = 'Marketing Agmt Signed', last_contact_at = now() WHERE id = $1", [doc.lead_id]);
    }
  }

  if (eventType === "Declined") {
    await query("UPDATE documents SET status = 'declined' WHERE id = $1", [doc.id]);
  }
}

module.exports = { sendNda, sendMarketingAgreement, sendApa, sendFromTemplate, handleWebhook };
