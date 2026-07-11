// src/routes/auth.js
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const { sanitizeText } = require('../utils/sanitize');

const EMAIL_REGEX          = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CREW_PIN_MAX_ATTEMPTS = 5;
const CREW_LOCKOUT_MINUTES  = 15;

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
}

// GET /api/auth/crew-list
router.get('/crew-list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT crew_id AS id, name FROM crew ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /auth/crew-list]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { firstName, lastName = '', email, password, phone } = req.body;
  const rawFirstName = sanitizeText(firstName || '');
  const rawLastName  = sanitizeText(lastName || '');
  const rawEmail     = String(email || '').toLowerCase().trim();
  const rawPassword  = String(password || '');
  const rawPhone     = String(phone || '').trim();

  if (!rawFirstName || !rawEmail || !rawPassword || !rawPhone)
    return res.status(400).json({ error: 'firstName, email, phone and password are required' });
  if (!/^[6-9]\d{9}$/.test(rawPhone))
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number (no +91, no spaces)' });
  if (rawFirstName.length > 60 || rawLastName.length > 60)
    return res.status(400).json({ error: 'Name is too long (max 60 characters)' });
  if (rawEmail.length > 150)
    return res.status(400).json({ error: 'Email is too long' });
  if (!EMAIL_REGEX.test(rawEmail))
    return res.status(400).json({ error: 'Invalid email format' });
  if (rawPassword.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(rawPassword))
    return res.status(400).json({ error: 'Password must contain at least one number or special character (e.g. @, #, 1, 2)' });
  if (rawPassword.length > 128)
    return res.status(400).json({ error: 'Password is too long (max 128 characters)' });

  try {
    const hash      = await bcrypt.hash(rawPassword, 10);
    const { rows }  = await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone, password, role)
       VALUES ($1, $2, $3, $4, $5, 'USER')
       RETURNING id, first_name, last_name, email, phone, role`,
      [rawFirstName, rawLastName, rawEmail, rawPhone, hash]
    );
    const u     = rows[0];
    const name  = `${u.first_name} ${u.last_name}`.trim();
    const token = makeToken({ id: u.id, email: u.email, role: u.role, name });
    res.status(201).json({ token, name, role: u.role, email: u.email });
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({ error: 'Registration failed. Please try again with different credentials.' });
    console.error('[POST /auth/register]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const rawEmail    = String(email || '').toLowerCase().trim();
  const rawPassword = String(password || '');

  if (!rawEmail || !rawPassword)
    return res.status(400).json({ error: 'Email and password are required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, first_name, last_name, email, password, role FROM users WHERE email = $1',
      [rawEmail]
    );
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(rawPassword, u.password);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const name  = `${u.first_name} ${u.last_name}`.trim();
    const token = makeToken({ id: u.id, email: u.email, role: u.role, name });
    res.json({ token, name, role: u.role, email: u.email });
  } catch (err) {
    console.error('[POST /auth/login]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/crew-login
router.post('/crew-login', async (req, res) => {
  const { crewId, pin } = req.body;
  const rawCrewId = String(crewId || '').trim();
  const rawPin    = String(pin || '');

  if (!rawCrewId || !rawPin)
    return res.status(400).json({ error: 'crewId and pin are required' });
  if (!/^\d{6}$/.test(rawPin))
    return res.status(400).json({ error: 'Invalid PIN format' });

  try {
    const { rows } = await pool.query(
      'SELECT crew_id, name, pin_hash, failed_attempts, locked_until FROM crew WHERE crew_id = $1',
      [rawCrewId]
    );
    const c = rows[0];
    if (!c) return res.status(401).json({ error: 'Invalid crew ID or PIN' });

    if (c.locked_until && new Date(c.locked_until) > new Date())
      return res.status(423).json({ error: 'Account locked due to repeated failed login attempts. Try again later.' });

    const ok = await bcrypt.compare(rawPin, c.pin_hash);
    if (!ok) {
      const failedAttempts = (c.failed_attempts || 0) + 1;
      const lockedUntil    = failedAttempts >= CREW_PIN_MAX_ATTEMPTS
        ? new Date(Date.now() + CREW_LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null;

      await pool.query(
        'UPDATE crew SET failed_attempts = $1, locked_until = $2 WHERE crew_id = $3',
        [failedAttempts, lockedUntil, rawCrewId]
      );

      const errorMsg = lockedUntil
        ? 'Account locked due to repeated failed login attempts. Try again later.'
        : 'Invalid crew ID or PIN';
      return res.status(401).json({ error: errorMsg });
    }

    await pool.query(
      'UPDATE crew SET online = TRUE, failed_attempts = 0, locked_until = NULL WHERE crew_id = $1',
      [rawCrewId]
    );

    const token = makeToken({ id: c.crew_id, crewId: c.crew_id, role: 'CREW', name: c.name });
    res.json({ token, name: c.name, role: 'CREW', crewId: c.crew_id });
  } catch (err) {
    console.error('[POST /auth/crew-login]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
