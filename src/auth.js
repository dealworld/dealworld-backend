const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const COOKIE_NAME = "dw_token";
const TOKEN_TTL = "30d";

function requireSecret() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set in .env");
  return process.env.JWT_SECRET;
}

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, requireSecret(), { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, user) {
  res.cookie(COOKIE_NAME, signToken(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: req_is_https(res),
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

// Only send the cookie as Secure once the app is actually served over HTTPS —
// forcing it on a plain-HTTP local/dev deployment would make the browser silently drop it.
function req_is_https(res) {
  return res.req.protocol === "https" || res.req.headers["x-forwarded-proto"] === "https";
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: req_is_https(res) });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "not authenticated" });
  try {
    req.user = jwt.verify(token, requireSecret());
    next();
  } catch (e) {
    return res.status(401).json({ error: "session expired" });
  }
}

module.exports = { COOKIE_NAME, hashPassword, comparePassword, signToken, setAuthCookie, clearAuthCookie, requireAuth };
