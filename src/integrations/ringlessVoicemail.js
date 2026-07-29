const axios = require("axios");

// Drop Cowboy charges per drop rather than a large monthly platform fee, and has
// a documented public API. Sign up, create a "brand" for caller ID compliance,
// and record or upload the voicemail audio in their dashboard first — this call
// references that pre recorded audio by ID.
const DROPCOWBOY_BASE = "https://app.dropcowboy.com/app/api";

async function sendRinglessVoicemail({ phone, audioId }) {
  const res = await axios.post(`${DROPCOWBOY_BASE}/rvm`, {
    team_id: process.env.DROPCOWBOY_TEAM_ID,
    secret: process.env.DROPCOWBOY_SECRET,
    brand_id: process.env.DROPCOWBOY_BRAND_ID,
    phone,
    audio_id: audioId
  });
  return res.data;
}

async function sendBulkRinglessVoicemail({ recipients, audioId }) {
  const results = [];
  for (const r of recipients) {
    const result = await sendRinglessVoicemail({ phone: r.phone, audioId });
    results.push({ phone: r.phone, result });
  }
  return results;
}

module.exports = { sendRinglessVoicemail, sendBulkRinglessVoicemail };
