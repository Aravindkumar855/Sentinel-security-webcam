const crypto = require('node:crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OTP_ATTEMPTS = 5;

// Statements
const findUserByIdentifier = db.prepare('SELECT * FROM users WHERE identifier = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare('INSERT INTO users (id, identifier, kind, created_at, last_login) VALUES (?, ?, ?, ?, ?)');
const updateUserLogin = db.prepare('UPDATE users SET last_login = ? WHERE id = ?');

const insertSession = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const findSession = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');

const upsertOtp = db.prepare(`
  INSERT INTO otps (identifier, code, expires_at, attempts) 
  VALUES (?, ?, ?, 0) 
  ON CONFLICT(identifier) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0
`);
const findOtp = db.prepare('SELECT * FROM otps WHERE identifier = ?');
const incrementOtpAttempt = db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE identifier = ?');
const deleteOtp = db.prepare('DELETE FROM otps WHERE identifier = ?');

function generateSecureCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createOtp(identifier) {
  const code = generateSecureCode();
  const expiresAt = Date.now() + OTP_TTL_MS;
  upsertOtp.run(identifier, code, expiresAt);
  return { code, expiresAt };
}

function verifyOtp(identifier, inputCode) {
  const record = findOtp.get(identifier);
  if (!record) {
    return { ok: false, message: 'No verification code requested or code expired.' };
  }
  if (Date.now() > record.expires_at) {
    deleteOtp.run(identifier);
    return { ok: false, message: 'Verification code has expired. Please request a new one.' };
  }
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    deleteOtp.run(identifier);
    return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  if (record.code !== inputCode.trim()) {
    incrementOtpAttempt.run(identifier);
    return { ok: false, message: 'Invalid verification code.' };
  }

  deleteOtp.run(identifier);
  return { ok: true };
}

function getOrCreateUser(identifier, kind = 'email') {
  let user = findUserByIdentifier.get(identifier);
  const now = Date.now();
  if (!user) {
    const id = 'usr_' + crypto.randomBytes(8).toString('hex');
    insertUser.run(id, identifier, kind, now, now);
    user = { id, identifier, kind, created_at: now, last_login: now };
  } else {
    updateUserLogin.run(now, user.id);
    user.last_login = now;
  }
  return user;
}

function createSession(userId) {
  const token = generateSecureToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  insertSession.run(token, userId, now, expiresAt);
  return { token, expiresAt };
}

function authenticateToken(token) {
  if (!token) return null;
  const session = findSession.get(token, Date.now());
  if (!session) return null;
  const user = findUserById.get(session.user_id);
  if (!user) return null;
  return { user, session };
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  const auth = authenticateToken(token);
  if (!auth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid or expired session token' });
  }

  req.user = auth.user;
  req.session = auth.session;
  next();
}

function revokeSession(token) {
  deleteSession.run(token);
}

module.exports = {
  createOtp,
  verifyOtp,
  getOrCreateUser,
  createSession,
  authenticateToken,
  authMiddleware,
  revokeSession,
  generateSecureCode
};
