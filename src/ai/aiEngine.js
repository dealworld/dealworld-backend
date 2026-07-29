const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-5"; // swap for whichever current model your account has access to

/**
 * Drafts a single personalized email for one row of an uploaded list, or one lead.
 * goal: what you're trying to accomplish ("reintroduce myself to buyers who went quiet")
 * tone: e.g. "warm and casual", "brief and professional"
 * person: { name, listingRef, stage, lastContactAt, type }
 */
async function draftEmail({ goal, tone, person }) {
  const prompt = `You are drafting a short business email on behalf of a business broker named Max.
Goal for this email: ${goal}
Tone: ${tone}
Recipient details: ${JSON.stringify(person)}

Write only the email body, no subject line, no preamble, no signature block beyond "Max".
Keep it under 120 words. Do not invent facts not present in the recipient details.`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }]
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
}

/**
 * Classifies an inbound reply into one of a fixed set of buckets.
 */
async function classifyReply({ body }) {
  const prompt = `Classify this email reply into exactly one of: interested, not_interested, needs_info, out_of_office, wrong_person.
Reply only with the single label, nothing else.

Reply text:
"""
${body}
"""`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 10,
    messages: [{ role: "user", content: prompt }]
  });
  const label = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().toLowerCase();
  const allowed = ["interested", "not_interested", "needs_info", "out_of_office", "wrong_person"];
  return allowed.includes(label) ? label : "needs_info";
}

/**
 * Reads an inbound email or text and decides whether a task should be created.
 * Returns { needsTask: boolean, title: string|null, suggestedDueDate: 'YYYY-MM-DD'|null }
 */
async function detectTask({ body, channel, today }) {
  const prompt = `A message came in on ${channel} to a business broker. Decide if it implies a task the broker should do
(answer a question, send a document, schedule a call, follow up on something specific). If it's just a pleasantry,
an automated notification, or something with no action needed, say no task is needed.

Respond in strict JSON only, no other text, in this shape:
{"needsTask": true or false, "title": "short actionable task title or null", "suggestedDueDate": "YYYY-MM-DD or null"}

Today's date is ${today}.

Message body:
"""
${body}
"""`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }]
  });
  const raw = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return { needsTask: false, title: null, suggestedDueDate: null };
  }
}

module.exports = { draftEmail, classifyReply, detectTask };
