const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { parseCookies } = require('./http');

const SESSION_DAYS = 30;

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expires]);
  return { token, maxAge: SESSION_DAYS * 24 * 3600 };
}

async function destroySession(token) {
  if (token) await db.query('DELETE FROM sessions WHERE token=$1', [token]);
}

async function getUserFromReq(req) {
  const cookies = parseCookies(req);
  const token = cookies.sh_session;
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.active = true`,
    [token]
  );
  return rows[0] || null;
}

async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

module.exports = { createSession, destroySession, getUserFromReq, hashPassword, verifyPassword };
