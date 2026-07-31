const express = require("express");
const { query } = require("../db");
const { hashPassword, comparePassword, setAuthCookie, clearAuthCookie, requireAuth } = require("../auth");

const router = express.Router();

function validEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 8;
}

// Public — lets the frontend decide whether to show "create your account" or "log in".
router.get("/status", async (req, res) => {
  const result = await query("SELECT COUNT(*)::int AS n FROM users");
  res.json({ hasAccount: result.rows[0].n > 0 });
});

// One-time bootstrap. Refuses once an account already exists — after that, use /login.
router.post("/setup", async (req, res) => {
  const existing = await query("SELECT COUNT(*)::int AS n FROM users");
  if (existing.rows[0].n > 0) return res.status(409).json({ error: "an account already exists — log in instead" });

  const { email, password } = req.body;
  if (!validEmail(email)) return res.status(400).json({ error: "enter a valid email address" });
  if (!validPassword(password)) return res.status(400).json({ error: "password must be at least 8 characters" });

  const password_hash = await hashPassword(password);
  const result = await query(
    "INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email",
    [email.toLowerCase().trim(), password_hash]
  );
  const user = result.rows[0];
  setAuthCookie(res, user);
  res.status(201).json({ email: user.email });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!validEmail(email) || typeof password !== "string") {
    return res.status(401).json({ error: "invalid email or password" });
  }
  const result = await query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
  const user = result.rows[0];
  // Compare against a dummy hash even when no user matches, so a nonexistent
  // email doesn't respond faster than a wrong password (basic timing hygiene).
  const ok = user
    ? await comparePassword(password, user.password_hash)
    : await comparePassword(password, "$2b$12$1H71vr3SQQuc3uTRwxEXDehTQQ9YPSdyflWMIC356kyB3uB.ql6iG");
  if (!user || !ok) return res.status(401).json({ error: "invalid email or password" });

  setAuthCookie(res, user);
  res.json({ email: user.email });
});

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const result = await query("SELECT email FROM users WHERE id = $1", [req.user.sub]);
  if (!result.rows.length) return res.status(401).json({ error: "not authenticated" });
  res.json({ email: result.rows[0].email });
});

// Changing email or password both require the current password as confirmation.
router.patch("/me", requireAuth, async (req, res) => {
  const { currentPassword, newEmail, newPassword } = req.body;
  const result = await query("SELECT * FROM users WHERE id = $1", [req.user.sub]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "not authenticated" });
  if (typeof currentPassword !== "string" || !(await comparePassword(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: "current password is incorrect" });
  }

  const fields = [];
  const values = [];
  if (newEmail) {
    if (!validEmail(newEmail)) return res.status(400).json({ error: "enter a valid email address" });
    fields.push("email"); values.push(newEmail.toLowerCase().trim());
  }
  if (newPassword) {
    if (!validPassword(newPassword)) return res.status(400).json({ error: "new password must be at least 8 characters" });
    fields.push("password_hash"); values.push(await hashPassword(newPassword));
  }
  if (!fields.length) return res.status(400).json({ error: "nothing to update" });

  const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(", ");
  values.push(user.id);
  let updated;
  try {
    updated = await query(
      `UPDATE users SET ${setClause}, updated_at = now() WHERE id = $${values.length} RETURNING id, email`,
      values
    );
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "that email is already in use" });
    throw e;
  }

  setAuthCookie(res, updated.rows[0]); // re-sign so the cookie's embedded email stays current
  res.json({ email: updated.rows[0].email });
});

module.exports = router;
