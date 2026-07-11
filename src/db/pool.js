// src/db/pool.js
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || '';
const isLocalDatabaseUrl = /^postgres(?:ql)?:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(databaseUrl);

const poolConfig = process.env.DATABASE_URL ? {
  connectionString: databaseUrl,
} : {
  host:                    process.env.DB_HOST,
  port:                    parseInt(process.env.DB_PORT || '5432'),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
};

const pool = new Pool({
  ...poolConfig,
  max:                     parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis:       10000,
  connectionTimeoutMillis: 5000,
  statement_timeout:       30000,
  application_name:        'kb-enterprises-backend',
  ssl: ((databaseUrl && !isLocalDatabaseUrl) || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost'))
    ? { rejectUnauthorized: true }
    : false,
});

pool.on('error', (err) => {
  console.error('[POOL] Unexpected database error:', err.message);
});

module.exports = pool;
