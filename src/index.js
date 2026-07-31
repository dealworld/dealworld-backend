require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const apiRoutes = require("./routes/api");
const authRoutes = require("./routes/auth");
const { requireAuth } = require("./auth");
const gmail = require("./integrations/gmail");
const boldsign = require("./integrations/boldsign");
const twilioIntegration = require("./integrations/twilio");
const calendly = require("./integrations/calendly");
const scheduler = require("./services/reminderScheduler");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio posts form-encoded webhooks
app.use(cookieParser());

/* ---------- Static frontend ---------- */
// Drop the DealWorld_2.0.html file (or a built frontend) into /public and it's served here.
// The page itself is static and unprotected — it's just the shell; the login
// screen inside it is what actually gates access, and every /api/* route
// below (aside from /api/auth) requires a valid session before it returns data.
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------- API ---------- */
app.use("/api/auth", authRoutes);
app.use("/api", requireAuth, apiRoutes);

/* ---------- Gmail OAuth (one time setup) ---------- */
app.get("/auth/gmail", (req, res) => {
  res.redirect(gmail.authUrl());
});
app.get("/auth/gmail/callback", async (req, res) => {
  try {
    const tokens = await gmail.handleOAuthCallback(req.query.code);
    // Surface the refresh token once so you can copy it into your .env as
    // GOOGLE_REFRESH_TOKEN. It is only ever returned the first time you consent.
    res.send(`
      <h2>Gmail connected</h2>
      <p>Copy this into your .env as GOOGLE_REFRESH_TOKEN, then restart the server:</p>
      <pre>${tokens.refresh_token || "(no refresh token returned — remove any prior app authorization in your Google account and try again)"}</pre>
    `);
  } catch (e) {
    res.status(500).send("OAuth failed: " + e.message);
  }
});

/* ---------- Webhooks ---------- */
app.post("/webhooks/boldsign", async (req, res) => {
  try {
    await boldsign.handleWebhook(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("BoldSign webhook error", e);
    res.sendStatus(500);
  }
});

app.post("/webhooks/twilio/inbound", async (req, res) => {
  try {
    await twilioIntegration.handleInboundSms(req.body);
    res.type("text/xml").send("<Response></Response>"); // empty TwiML = no auto-reply sent
  } catch (e) {
    console.error("Twilio webhook error", e);
    res.sendStatus(500);
  }
});

app.post("/webhooks/calendly", async (req, res) => {
  try {
    if (req.body.event === "invitee.created") {
      await calendly.handleInviteeCreated(req.body);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Calendly webhook error", e);
    res.sendStatus(500);
  }
});

/* ---------- Health check ---------- */
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DealWorld 2.0 backend listening on port ${PORT}`);
  scheduler.start();
});
