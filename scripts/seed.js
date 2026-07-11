// scripts/seed.js
// Run ONCE to create the admin user.
// Usage:  node scripts/seed.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('../src/db/pool');

const ADMIN = {
  firstName: process.env.SEED_ADMIN_FIRST || 'Admin',
  lastName:  process.env.SEED_ADMIN_LAST  || 'TrainServe',
  email:     process.env.SEED_ADMIN_EMAIL,
  password:  process.env.SEED_ADMIN_PASSWORD,
};

// ── Startup guards ─────────────────────────────────────────────────────
if (!ADMIN.email || !ADMIN.password) {
  console.error('FATAL: Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in your Render environment variables.');
  process.exit(1);
}

async function seed() {
  try {
    console.log('Seeding database...');

    const passHash = await bcrypt.hash(ADMIN.password, 10);
    await pool.query(
      `INSERT INTO users (first_name, last_name, email, password, role)
       VALUES ($1, $2, $3, $4, 'ADMIN')
       ON CONFLICT (email) DO NOTHING`,
      [ADMIN.firstName, ADMIN.lastName, ADMIN.email.toLowerCase().trim(), passHash]
    );

    console.log('  Admin created:', ADMIN.email);
    console.log('\nSeeding complete. You can now sign in.');
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
