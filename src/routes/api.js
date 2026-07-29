const express = require("express");
const { query } = require("../db");
const { sendNda, sendMarketingAgreement, sendApa } = require("../integrations/boldsign");
const { sendEmail } = require("../integrations/gmail");
const { sendBulkSms } = require("../integrations/twilio");
const { sendBulkRinglessVoicemail } = require("../integrations/ringlessVoicemail");
const { draftEmail } = require("../ai/aiEngine");

const router = express.Router();

/* ---------- Leads ---------- */
router.get("/leads", async (req, res) => {
  const { type } = req.query;
  const result = type
    ? await query("SELECT * FROM leads WHERE type = $1 ORDER BY created_at DESC", [type])
    : await query("SELECT * FROM leads ORDER BY created_at DESC");
  res.json(result.rows);
});

router.get("/leads/:id", async (req, res) => {
  const lead = await query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
  if (!lead.rows.length) return res.status(404).json({ error: "not found" });
  const notes = await query("SELECT * FROM notes WHERE record_type='lead' AND record_id=$1 ORDER BY created_at DESC", [req.params.id]);
  const tasks = await query("SELECT * FROM tasks WHERE record_type='lead' AND record_id=$1 ORDER BY due_date", [req.params.id]);
  const documents = await query("SELECT * FROM documents WHERE lead_id=$1 ORDER BY sent_at DESC", [req.params.id]);
  const communications = await query("SELECT * FROM communications WHERE record_type='lead' AND record_id=$1 ORDER BY occurred_at DESC", [req.params.id]);
  res.json({ ...lead.rows[0], notes: notes.rows, tasks: tasks.rows, documents: documents.rows, communications: communications.rows });
});

router.post("/leads", async (req, res) => {
  const { name, email, phone, type, source, listing_ref } = req.body;
  const result = await query(
    `INSERT INTO leads (name, email, phone, type, source, listing_ref) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, email, phone, type, source, listing_ref]
  );
  res.status(201).json(result.rows[0]);
});

// Manual promotion / stage change — deliberately explicit, never automatic in the background
// except where a webhook (NDA signed, etc.) is the thing you configured to move it.
router.patch("/leads/:id/stage", async (req, res) => {
  const { stage, outcome } = req.body;
  const result = await query(
    "UPDATE leads SET stage = $1, outcome = $2 WHERE id = $3 RETURNING *",
    [stage, outcome || null, req.params.id]
  );
  res.json(result.rows[0]);
});

router.patch("/leads/:id/contact", async (req, res) => {
  await query("UPDATE leads SET last_contact_at = now() WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

router.patch("/leads/:id/description", async (req, res) => {
  const result = await query("UPDATE leads SET description = $1 WHERE id = $2 RETURNING *", [req.body.description, req.params.id]);
  res.json(result.rows[0]);
});

router.delete("/leads/:id", async (req, res) => {
  await query("DELETE FROM leads WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- Listings ---------- */
router.get("/listings", async (req, res) => {
  const result = await query(
    `SELECT li.*, (SELECT COUNT(*) FROM leads l WHERE l.listing_id = li.id AND l.type='buyer') AS buyer_count
     FROM listings li ORDER BY li.created_at DESC`
  );
  res.json(result.rows);
});

router.get("/listings/:id", async (req, res) => {
  const listing = await query("SELECT * FROM listings WHERE id = $1", [req.params.id]);
  if (!listing.rows.length) return res.status(404).json({ error: "not found" });
  const buyers = await query("SELECT * FROM leads WHERE listing_id = $1 AND type='buyer'", [req.params.id]);
  const links = await query("SELECT * FROM listing_links WHERE listing_id = $1 ORDER BY created_at", [req.params.id]);
  res.json({ ...listing.rows[0], buyers: buyers.rows, links: links.rows });
});

router.post("/listings/:id/links", async (req, res) => {
  let { label, url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const result = await query(
    "INSERT INTO listing_links (listing_id, label, url) VALUES ($1,$2,$3) RETURNING *",
    [req.params.id, label || "Link", url]
  );
  res.status(201).json(result.rows[0]);
});

router.delete("/listings/:id/links/:linkId", async (req, res) => {
  await query("DELETE FROM listing_links WHERE id = $1 AND listing_id = $2", [req.params.linkId, req.params.id]);
  res.json({ ok: true });
});

router.post("/listings", async (req, res) => {
  const { business_name, industry, asking_price, status, notes, seller_lead_id } = req.body;
  const result = await query(
    `INSERT INTO listings (business_name, industry, asking_price, status, notes, seller_lead_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [business_name, industry, asking_price, status || "Active", notes, seller_lead_id || null]
  );
  res.status(201).json(result.rows[0]);
});

router.patch("/listings/:id/status", async (req, res) => {
  const result = await query("UPDATE listings SET status = $1 WHERE id = $2 RETURNING *", [req.body.status, req.params.id]);
  res.json(result.rows[0]);
});

router.delete("/listings/:id", async (req, res) => {
  // Unlink any buyer leads rather than deleting them along with the listing.
  await query("UPDATE leads SET listing_id = NULL WHERE listing_id = $1", [req.params.id]);
  await query("DELETE FROM listings WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- Notes ---------- */
router.post("/notes", async (req, res) => {
  const { record_type, record_id, body, author } = req.body;
  const result = await query(
    "INSERT INTO notes (record_type, record_id, body, author) VALUES ($1,$2,$3,$4) RETURNING *",
    [record_type, record_id, body, author || "Max"]
  );
  if (record_type === "lead") {
    await query("UPDATE leads SET last_contact_at = now() WHERE id = $1", [record_id]);
  }
  res.status(201).json(result.rows[0]);
});

/* ---------- Tasks ---------- */
router.get("/tasks", async (req, res) => {
  const result = await query(
    `SELECT t.*, l.name AS lead_name FROM tasks t
     LEFT JOIN leads l ON l.id = t.record_id AND t.record_type = 'lead'
     ORDER BY (t.status = 'done'), t.due_date`
  );
  res.json(result.rows);
});

router.post("/tasks", async (req, res) => {
  const { record_type, record_id, title, due_date, assignee } = req.body;
  const result = await query(
    "INSERT INTO tasks (record_type, record_id, title, due_date, assignee) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [record_type, record_id, title, due_date, assignee || "Max"]
  );
  res.status(201).json(result.rows[0]);
});

router.patch("/tasks/:id/toggle", async (req, res) => {
  const result = await query(
    "UPDATE tasks SET status = CASE WHEN status='done' THEN 'open' ELSE 'done' END WHERE id=$1 RETURNING *",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

router.delete("/tasks/:id", async (req, res) => {
  await query("DELETE FROM tasks WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

router.delete("/notes/:id", async (req, res) => {
  await query("DELETE FROM notes WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- Documents / esignature ---------- */
router.post("/leads/:id/documents/nda", async (req, res) => {
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [req.params.id])).rows[0];
  const envelopeId = await sendNda({ lead, customSubject: req.body.subject, customMessage: req.body.message });
  res.json({ envelopeId });
});

router.post("/leads/:id/documents/marketing", async (req, res) => {
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [req.params.id])).rows[0];
  const envelopeId = await sendMarketingAgreement({ lead, customSubject: req.body.subject, customMessage: req.body.message });
  res.json({ envelopeId });
});

router.post("/leads/:id/documents/apa", async (req, res) => {
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [req.params.id])).rows[0];
  const envelopeId = await sendApa({ lead, customSubject: req.body.subject, customMessage: req.body.message });
  res.json({ envelopeId });
});

// CIM send is manual by design — it sends whatever file URL you've uploaded for this deal.
router.post("/leads/:id/documents/cim", async (req, res) => {
  const { fileUrl } = req.body;
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [req.params.id])).rows[0];
  await query("INSERT INTO documents (lead_id, type, status, file_url) VALUES ($1,'CIM','sent',$2)", [lead.id, fileUrl]);
  await sendEmail({
    to: lead.email,
    subject: `CIM — ${lead.listing_ref || "your listing of interest"}`,
    body: `Hi ${lead.name}, thanks for signing the NDA. Here's the CIM: ${fileUrl}`
  });
  await query("UPDATE leads SET stage = 'CIM Sent', last_contact_at = now() WHERE id = $1", [lead.id]);
  res.json({ ok: true });
});

// Address release — a single explicit action, not automatic on any webhook.
router.post("/leads/:id/release-address", async (req, res) => {
  const { address } = req.body;
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [req.params.id])).rows[0];
  await sendEmail({
    to: lead.email,
    subject: `Business address — ${lead.listing_ref || ""}`,
    body: `Hi ${lead.name}, as discussed, here is the business address: ${address}`
  });
  await query("UPDATE leads SET address_released_at = now(), last_contact_at = now() WHERE id = $1", [lead.id]);
  res.json({ ok: true });
});

router.delete("/documents/:id", async (req, res) => {
  await query("DELETE FROM documents WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- Contacts ---------- */
router.get("/contacts", async (req, res) => {
  res.json((await query("SELECT * FROM contacts ORDER BY created_at DESC")).rows);
});
router.get("/contacts/:id", async (req, res) => {
  const contact = await query("SELECT * FROM contacts WHERE id = $1", [req.params.id]);
  if (!contact.rows.length) return res.status(404).json({ error: "not found" });
  const notes = await query("SELECT * FROM notes WHERE record_type='contact' AND record_id=$1 ORDER BY created_at DESC", [req.params.id]);
  const tasks = await query("SELECT * FROM tasks WHERE record_type='contact' AND record_id=$1 ORDER BY due_date", [req.params.id]);
  res.json({ ...contact.rows[0], notes: notes.rows, tasks: tasks.rows });
});
router.post("/contacts", async (req, res) => {
  const { name, email, phone, details, category, photo_url, linkedin } = req.body;
  const result = await query(
    "INSERT INTO contacts (name,email,phone,details,category,photo_url,linkedin) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [name, email, phone, details, category || "General", photo_url, linkedin]
  );
  res.status(201).json(result.rows[0]);
});
router.patch("/contacts/:id/linkedin", async (req, res) => {
  let { linkedin } = req.body;
  if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = "https://" + linkedin;
  const result = await query("UPDATE contacts SET linkedin = $1 WHERE id = $2 RETURNING *", [linkedin, req.params.id]);
  res.json(result.rows[0]);
});
router.delete("/contacts/:id", async (req, res) => {
  await query("DELETE FROM contacts WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- Provisors ---------- */
router.get("/provisors", async (req, res) => {
  const provisors = await query(
    `SELECT p.*, c.name, c.email, c.phone, c.photo_url FROM provisors p JOIN contacts c ON c.id = p.contact_id`
  );
  res.json(provisors.rows);
});
router.post("/provisors", async (req, res) => {
  const { name, email, phone, photo_url, specialty, tags } = req.body;
  const contact = await query(
    "INSERT INTO contacts (name,email,phone,category,photo_url) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [name, email, phone, "Provisor", photo_url]
  );
  const provisor = await query(
    "INSERT INTO provisors (contact_id, specialty, tags) VALUES ($1,$2,$3) RETURNING *",
    [contact.rows[0].id, specialty, tags || []]
  );
  res.status(201).json({ ...provisor.rows[0], ...contact.rows[0] });
});
router.post("/provisors/:id/troikas", async (req, res) => {
  const { event_date, notes } = req.body;
  const result = await query(
    "INSERT INTO provisor_troikas (provisor_id, event_date, notes) VALUES ($1,$2,$3) RETURNING *",
    [req.params.id, event_date, notes]
  );
  res.status(201).json(result.rows[0]);
});
router.delete("/provisors/:id/troikas/:troikaId", async (req, res) => {
  await query("DELETE FROM provisor_troikas WHERE id = $1 AND provisor_id = $2", [req.params.troikaId, req.params.id]);
  res.json({ ok: true });
});
router.post("/provisors/:id/connections", async (req, res) => {
  const { direction, note, linked_lead_id } = req.body;
  const result = await query(
    "INSERT INTO provisor_connections (provisor_id, direction, note, linked_lead_id) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.params.id, direction, note, linked_lead_id || null]
  );
  res.status(201).json(result.rows[0]);
});
router.delete("/provisors/:id/connections/:connId", async (req, res) => {
  await query("DELETE FROM provisor_connections WHERE id = $1 AND provisor_id = $2", [req.params.connId, req.params.id]);
  res.json({ ok: true });
});
// Deleting a provisor removes its underlying contact record too, since a provisor
// is a contact with extra fields (see the JOIN in GET /provisors above).
router.delete("/provisors/:id", async (req, res) => {
  const p = await query("SELECT contact_id FROM provisors WHERE id = $1", [req.params.id]);
  if (p.rows.length) {
    await query("DELETE FROM contacts WHERE id = $1", [p.rows[0].contact_id]); // cascades to the provisor row and its troikas/connections
  }
  res.json({ ok: true });
});

/* ---------- Newsletters ---------- */
router.get("/newsletters", async (req, res) => {
  res.json((await query("SELECT * FROM newsletters ORDER BY created_at DESC")).rows);
});
router.post("/newsletters", async (req, res) => {
  const { subject, body, recipient_group } = req.body;
  const result = await query(
    "INSERT INTO newsletters (subject, body, recipient_group) VALUES ($1,$2,$3) RETURNING *",
    [subject, body, recipient_group]
  );
  res.status(201).json(result.rows[0]);
});
router.delete("/newsletters/:id", async (req, res) => {
  await query("DELETE FROM newsletters WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});
router.post("/newsletters/:id/send", async (req, res) => {
  const nl = (await query("SELECT * FROM newsletters WHERE id=$1", [req.params.id])).rows[0];
  const recipients = await recipientsForGroup(nl.recipient_group);
  for (const r of recipients) {
    if (r.email) await sendEmail({ to: r.email, subject: nl.subject, body: nl.body.replace(/\{\{name\}\}/g, r.name || "") });
  }
  await query("UPDATE newsletters SET status='sent', sent_at=now() WHERE id=$1", [req.params.id]);
  res.json({ sentTo: recipients.length });
});

async function recipientsForGroup(group) {
  if (group === "all_buyers") return (await query("SELECT name, email FROM leads WHERE type='buyer' AND stage != 'Closed'")).rows;
  if (group === "all_sellers") return (await query("SELECT name, email FROM leads WHERE type='seller' AND stage != 'Closed'")).rows;
  if (group === "all_contacts") return (await query("SELECT name, email FROM contacts")).rows;
  if (group === "all_provisors") return (await query("SELECT c.name, c.email FROM provisors p JOIN contacts c ON c.id=p.contact_id")).rows;
  return [];
}

/* ---------- Mass outreach (email / text / ringless voicemail) ---------- */
router.post("/outreach/mass-email", async (req, res) => {
  const { leadIds, subject, body } = req.body;
  const leads = (await query("SELECT * FROM leads WHERE id = ANY($1)", [leadIds])).rows;
  for (const lead of leads) {
    await sendEmail({ to: lead.email, subject, body: body.replace(/\{\{name\}\}/g, lead.name) });
  }
  res.json({ sentTo: leads.length });
});

router.post("/outreach/mass-text", async (req, res) => {
  const { leadIds, body } = req.body;
  const leads = (await query("SELECT * FROM leads WHERE id = ANY($1)", [leadIds])).rows;
  const results = await sendBulkSms({ recipients: leads.map((l) => ({ phone: l.phone, name: l.name })), body });
  res.json({ results });
});

router.post("/outreach/mass-voicemail", async (req, res) => {
  const { leadIds, audioId } = req.body;
  const leads = (await query("SELECT * FROM leads WHERE id = ANY($1)", [leadIds])).rows;
  const results = await sendBulkRinglessVoicemail({ recipients: leads.map((l) => ({ phone: l.phone })), audioId });
  res.json({ results });
});

/* ---------- Bulk CSV/Excel import ---------- */
// The frontend parses the file and maps columns client side (see DealWorld_2.0.html),
// then posts already-shaped rows here. Each endpoint mirrors that module's single-create route.
router.post("/import/leads", async (req, res) => {
  const { rows, type } = req.body; // rows: [{name,email,phone,source,listing_ref}], type: 'buyer'|'seller'
  const created = [];
  for (const r of rows) {
    if (!r.name) continue;
    const result = await query(
      `INSERT INTO leads (name,email,phone,type,source,listing_ref) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [r.name, r.email, r.phone, type, r.source || "CSV/Excel import", r.listing_ref]
    );
    created.push(result.rows[0]);
  }
  res.status(201).json({ created: created.length, records: created });
});

router.post("/import/listings", async (req, res) => {
  const { rows } = req.body; // rows: [{business_name, industry, asking_price, status, notes}]
  const created = [];
  for (const r of rows) {
    if (!r.business_name) continue;
    const result = await query(
      `INSERT INTO listings (business_name, industry, asking_price, status, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [r.business_name, r.industry, r.asking_price, r.status || "Active", r.notes]
    );
    created.push(result.rows[0]);
  }
  res.status(201).json({ created: created.length, records: created });
});

router.post("/import/contacts", async (req, res) => {
  const { rows } = req.body; // rows: [{name,email,phone,details,linkedin}]
  const created = [];
  for (const r of rows) {
    if (!r.name) continue;
    const result = await query(
      `INSERT INTO contacts (name,email,phone,details,category,linkedin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [r.name, r.email, r.phone, r.details, r.category || "General", r.linkedin]
    );
    created.push(result.rows[0]);
  }
  res.status(201).json({ created: created.length, records: created });
});

router.post("/import/provisors", async (req, res) => {
  const { rows } = req.body; // rows: [{name,email,phone,specialty}]
  const created = [];
  for (const r of rows) {
    if (!r.name) continue;
    const contact = await query(
      `INSERT INTO contacts (name,email,phone,category) VALUES ($1,$2,$3,'Provisor') RETURNING *`,
      [r.name, r.email, r.phone]
    );
    const provisor = await query(
      `INSERT INTO provisors (contact_id, specialty, tags) VALUES ($1,$2,$3) RETURNING *`,
      [contact.rows[0].id, r.specialty || "Other", [r.specialty || "Other"]]
    );
    created.push({ ...provisor.rows[0], ...contact.rows[0] });
  }
  res.status(201).json({ created: created.length, records: created });
});

/* ---------- AI-assisted list upload ---------- */
// Body: { rows: [{name, email, phone, ...}], goal, tone, createAs: 'lead'|'contact', leadType }
router.post("/list-upload/generate-drafts", async (req, res) => {
  const { rows, goal, tone, createAs, leadType } = req.body;
  const drafts = [];
  for (const row of rows) {
    let recordId;
    if (createAs === "lead") {
      const existing = await query("SELECT id FROM leads WHERE email = $1", [row.email]);
      if (existing.rows.length) {
        recordId = existing.rows[0].id;
      } else {
        const inserted = await query(
          "INSERT INTO leads (name,email,phone,type,source) VALUES ($1,$2,$3,$4,'List upload') RETURNING id",
          [row.name, row.email, row.phone, leadType || "buyer"]
        );
        recordId = inserted.rows[0].id;
      }
    } else {
      const inserted = await query(
        "INSERT INTO contacts (name,email,phone) VALUES ($1,$2,$3) RETURNING id",
        [row.name, row.email, row.phone]
      );
      recordId = inserted.rows[0].id;
    }
    const draftBody = await draftEmail({ goal, tone, person: row });
    drafts.push({ recordId, name: row.name, email: row.email, draftBody });
  }
  res.json({ drafts });
});

module.exports = router;
