/**
 * End-to-end tests hitting a running instance of the apilayer service.
 *
 * Test isolation note:
 * On fresh dependencies the view counter starts at 0 and the products table
 * is empty, so repeated test runs against a freshly-initialized Postgres +
 * Redis pair always produce identical results. To make local re-runs
 * idempotent without a docker-compose down/up cycle, we connect to Postgres
 * and Redis directly in `before()` and reset both back to empty state.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Pool } = require('pg');
const Redis = require('ioredis');

const API_URL = process.env.API_URL || 'http://localhost:3000';

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
};

let pool;
let redis;
const state = { productId: null };

before(async () => {
  pool = new Pool(pgConfig);
  redis = new Redis(redisConfig);
  // Wait until the server's own connection is up before we reset state.
  await pool.query('SELECT 1');
  await pool.query('TRUNCATE products RESTART IDENTITY');
  await redis.flushdb();
});

after(async () => {
  if (pool) await pool.end();
  if (redis) await redis.quit();
});

test('1. GET /health returns 200 (liveness, no dep checks)', async () => {
  const res = await request(API_URL).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('2. GET /ready reports both Postgres and Redis up', async () => {
  const res = await request(API_URL).get('/ready');
  assert.equal(res.status, 200);
  assert.equal(res.body.postgres, 'up');
  assert.equal(res.body.redis, 'up');
});

test('3. POST /products creates a product (Postgres write)', async () => {
  const res = await request(API_URL)
    .post('/products')
    .send({ name: 'Test Product', price: 9.99 });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Test Product');
  assert.ok(res.body.id, 'expected a generated id on the new product');
  state.productId = res.body.id;
});

test('4. GET /products returns the created product (Postgres read)', async () => {
  const res = await request(API_URL).get('/products');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const found = res.body.find((p) => p.id === state.productId);
  assert.ok(found, 'expected created product to appear in the list');
  assert.equal(found.name, 'Test Product');
});

test('5. GET /products/:id — first call MISS, second call HIT (cache-aside)', async () => {
  const first = await request(API_URL).get(`/products/${state.productId}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-cache'], 'MISS');
  assert.equal(first.body.id, state.productId);

  const second = await request(API_URL).get(`/products/${state.productId}`);
  assert.equal(second.status, 200);
  assert.equal(second.headers['x-cache'], 'HIT');
  assert.equal(second.body.id, state.productId);
});

test('6. POST /products/:id/view three times → GET views returns 3 (Redis counter)', async () => {
  for (let i = 1; i <= 3; i++) {
    const inc = await request(API_URL).post(`/products/${state.productId}/view`);
    assert.equal(inc.status, 200);
    assert.equal(inc.body.views, i);
  }
  const final = await request(API_URL).get(`/products/${state.productId}/views`);
  assert.equal(final.status, 200);
  assert.equal(final.body.views, 3);
});

test('7. DELETE /products/:id → 404 on GET + cache invalidated', async () => {
  // Warm the cache first so we can prove invalidation happened.
  await request(API_URL).get(`/products/${state.productId}`);
  const beforeDel = await redis.get(`product:${state.productId}`);
  assert.ok(beforeDel, 'expected cache to be warmed before delete');

  const del = await request(API_URL).delete(`/products/${state.productId}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { deleted: true });

  const gone = await request(API_URL).get(`/products/${state.productId}`);
  assert.equal(gone.status, 404);

  const afterDel = await redis.get(`product:${state.productId}`);
  assert.equal(afterDel, null, 'expected cache key to be invalidated by DELETE');
});
