const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);

const pgConfig = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'apilayer',
};

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Keep the process alive even if Redis is briefly unreachable —
  // /ready reports the truth, /health stays green for liveness.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: false,
};

const pool = new Pool(pgConfig);
const redis = new Redis(redisConfig);

console.log(
  `[startup] Connecting to Postgres ${pgConfig.host}:${pgConfig.port}/${pgConfig.database} as ${pgConfig.user}`
);
console.log(`[startup] Connecting to Redis ${redisConfig.host}:${redisConfig.port}`);

pool.on('error', (err) => console.error('[postgres] pool error:', err.message));
redis.on('connect', () => console.log('[redis] connected'));
redis.on('ready', () => console.log('[redis] ready'));
redis.on('error', (err) => console.error('[redis] error:', err.message));

// Non-fatal initial probes so the log makes it obvious whether each
// dependency is reachable on boot. The service stays up either way.
pool
  .query('SELECT 1')
  .then(() => console.log('[postgres] initial probe ok'))
  .catch((err) => console.error('[postgres] initial probe failed:', err.message));

const app = express();
app.use(express.json());

// 1. Liveness — no dependency checks, always reports the process is up.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 2. Readiness — pings both dependencies and reports per-dep status.
app.get('/ready', async (_req, res) => {
  const result = { postgres: 'down', redis: 'down' };
  try {
    await pool.query('SELECT 1');
    result.postgres = 'up';
  } catch (err) {
    result.postgresError = err.message;
  }
  try {
    const pong = await redis.ping();
    if (pong === 'PONG') result.redis = 'up';
  } catch (err) {
    result.redisError = err.message;
  }
  const allUp = result.postgres === 'up' && result.redis === 'up';
  res.status(allUp ? 200 : 503).json(result);
});

// 3. Create — Postgres write.
app.post('/products', async (req, res) => {
  const { name, price } = req.body || {};
  if (!name || price === undefined || price === null) {
    return res.status(400).json({ error: 'name and price are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO products(name, price) VALUES($1, $2) RETURNING id, name, price, created_at',
      [name, price]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. List — Postgres read.
app.get('/products', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, price, created_at FROM products ORDER BY id'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Read-one — cache-aside (Redis + Postgres).
app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `product:${id}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(JSON.parse(cached));
    }
    const result = await pool.query(
      'SELECT id, name, price, created_at FROM products WHERE id = $1',
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    const product = result.rows[0];
    await redis.set(cacheKey, JSON.stringify(product), 'EX', 60);
    res.set('X-Cache', 'MISS');
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Delete — Postgres delete + Redis cache invalidation.
app.delete('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    await redis.del(`product:${id}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Increment view counter — pure Redis.
app.post('/products/:id/view', async (req, res) => {
  const { id } = req.params;
  try {
    const views = await redis.incr(`views:${id}`);
    res.json({ id: parseInt(id, 10), views });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Read view counter — pure Redis.
app.get('/products/:id/views', async (req, res) => {
  const { id } = req.params;
  try {
    const val = await redis.get(`views:${id}`);
    res.json({ id: parseInt(id, 10), views: val ? parseInt(val, 10) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Try to apply the schema on startup — init.sql is idempotent, so this is
// safe to run every time and means the service self-bootstraps against a
// fresh Postgres without a separate setup step.
async function applySchema() {
  const sqlPath = path.join(__dirname, '..', 'db', 'init.sql');
  if (!fs.existsSync(sqlPath)) return;
  try {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    console.log('[postgres] schema applied');
  } catch (err) {
    console.error('[postgres] failed to apply schema:', err.message);
  }
}

const server = app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});

applySchema();

function shutdown() {
  console.log('[server] shutting down');
  server.close(() => {
    Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
