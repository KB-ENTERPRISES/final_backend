// src/db/init.js
// Creates all tables and indexes on first run.
// Does NOT auto-seed products — use scripts/seed.js for that.

const pool = require('./pool');

const SQL = `
-- ── Users ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  TEXT        NOT NULL,
  last_name   TEXT        NOT NULL DEFAULT '',
  email       TEXT        UNIQUE NOT NULL,
  password    TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'USER',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Crew ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crew (
  crew_id      TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  pin_hash     TEXT        NOT NULL,
  online       BOOLEAN     NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER   NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Products ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id              TEXT         PRIMARY KEY,
  name            TEXT         NOT NULL,
  icon            TEXT         NOT NULL DEFAULT '📦',
  img             TEXT         NOT NULL DEFAULT '',
  price           NUMERIC      NOT NULL,
  unit            TEXT         NOT NULL,
  in_stock        BOOLEAN      NOT NULL DEFAULT TRUE,
  case_price      NUMERIC,
  pieces_per_case INTEGER,
  deleted         BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Orders ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                TEXT        PRIMARY KEY,
  user_id           UUID        REFERENCES users(id),
  user_name         TEXT        NOT NULL,
  train_no          TEXT        NOT NULL DEFAULT '',
  train_name        TEXT        NOT NULL DEFAULT '',
  current_location  TEXT        NOT NULL DEFAULT '',
  eta               TEXT        NOT NULL DEFAULT '',
  status            TEXT        NOT NULL DEFAULT 'PENDING',
  assigned_crew_id  TEXT        REFERENCES crew(crew_id),
  total             NUMERIC     NOT NULL DEFAULT 0,
  payment_uploaded  BOOLEAN     NOT NULL DEFAULT FALSE,
  order_type        TEXT        NOT NULL DEFAULT 'train',
  stall_name        TEXT,
  stall_location    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at       TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);

-- ── Order Items ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id          SERIAL      PRIMARY KEY,
  order_id    TEXT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  qty         INTEGER     NOT NULL,
  price       NUMERIC     NOT NULL
);

-- ── Notifications ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL      PRIMARY KEY,
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  crew_id     TEXT        REFERENCES crew(crew_id) ON DELETE CASCADE,
  message     TEXT        NOT NULL,
  read        BOOLEAN     NOT NULL DEFAULT FALSE,
  time        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit Logs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            SERIAL      PRIMARY KEY,
  order_id      TEXT        NOT NULL,
  event         TEXT        NOT NULL,
  performed_by  TEXT,
  note          TEXT,
  event_time    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Payment Screenshots ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_screenshots (
  id              SERIAL      PRIMARY KEY,
  order_id        TEXT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  screenshot_url  TEXT        NOT NULL,
  amount_paid     NUMERIC     NOT NULL DEFAULT 0,
  uploaded_by     TEXT        NOT NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes on foreign keys (performance) ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_user_id            ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_assigned_crew      ON orders(assigned_crew_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order         ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user        ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_screenshots_order ON payment_screenshots(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_order          ON audit_logs(order_id);
`;

// Safe migrations — runs on every start but ADD COLUMN IF NOT EXISTS is idempotent.
// Handles existing databases that still have old columns.
const MIGRATIONS = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type     TEXT NOT NULL DEFAULT 'train';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stall_name     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stall_location TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_total NUMERIC;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivered_qty INTEGER;
ALTER TABLE crew ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crew ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Migrate payment_screenshots from base64 to URL storage
ALTER TABLE payment_screenshots ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
ALTER TABLE payment_screenshots DROP COLUMN IF EXISTS screenshot_base64;
ALTER TABLE payment_screenshots DROP COLUMN IF EXISTS file_name;

-- Migrate payment_screenshots back to storing images directly in the DB
ALTER TABLE payment_screenshots ALTER COLUMN screenshot_url DROP NOT NULL;
ALTER TABLE payment_screenshots ADD COLUMN IF NOT EXISTS screenshot_data BYTEA;
ALTER TABLE payment_screenshots ADD COLUMN IF NOT EXISTS screenshot_mime TEXT;
ALTER TABLE orders ALTER COLUMN total TYPE NUMERIC USING total::numeric;
ALTER TABLE order_items ALTER COLUMN price TYPE NUMERIC USING price::numeric;
ALTER TABLE payment_screenshots ALTER COLUMN amount_paid TYPE NUMERIC USING amount_paid::numeric;
`;

async function initDb() {
  try {
    await pool.query(SQL);
    await pool.query(MIGRATIONS);
    console.log('Database tables ready');

    // Seed admin if environment variables are set
    const adminEmail = process.env.SEED_ADMIN_EMAIL;
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    const adminFirst = process.env.SEED_ADMIN_FIRST || 'Admin';
    const adminLast = process.env.SEED_ADMIN_LAST || '';
    const adminPhone = process.env.SEED_ADMIN_PHONE || '';

    if (adminEmail && adminPassword) {
      const emailNormalized = adminEmail.toLowerCase().trim();
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [emailNormalized]);
      if (!rows.length) {
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(adminPassword, 10);
        await pool.query(
          `INSERT INTO users (first_name, last_name, email, password, role, phone)
           VALUES ($1, $2, $3, $4, 'ADMIN', $5)`,
          [adminFirst, adminLast, emailNormalized, hash, adminPhone]
        );
        console.log(`Admin user seeded successfully: ${emailNormalized}`);
      } else {
        console.log(`Admin user already exists: ${emailNormalized}`);
      }
    }
  } catch (err) {
    console.error('Database init failed:', err.message);
    process.exit(1);
  }
}

module.exports = initDb;
