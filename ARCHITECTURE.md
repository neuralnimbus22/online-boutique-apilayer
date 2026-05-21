# Architecture & Concepts

A beginner-friendly walkthrough of what this service is, how its two backing dependencies (Postgres and Redis) earn their keep, and why each test exists. Everything below references the actual code, endpoints, and tests in this repo — not generic examples.

---

## 1. Overview

`online-boutique-apilayer` is a tiny Node.js + Express HTTP service that **only works when both Postgres and Redis are reachable**. Postgres stores products (the system of record); Redis caches reads and counts product views. The service exists to demonstrate the **dependency-services testing pattern**: when an app has external dependencies, tests must run against the real things (not mocks) to prove the integration actually works. This service will later be wired up in TestKube, which will stand up Postgres + Redis as sidecar containers in the same pod so the test suite runs against real infrastructure on every change.

---

## 2. The two dependencies

### 2.1 Postgres — the source of truth

Postgres is the **persistent**, authoritative store for products. If the app restarts, every product written before the restart is still there, because Postgres writes data to disk.

| Endpoint               | What Postgres does                                  |
|------------------------|-----------------------------------------------------|
| `POST /products`       | `INSERT INTO products(name, price) … RETURNING …`   |
| `GET /products`        | `SELECT … FROM products ORDER BY id`                |
| `GET /products/:id`    | `SELECT … FROM products WHERE id = $1` (on miss)    |
| `DELETE /products/:id` | `DELETE FROM products WHERE id = $1`                |
| `GET /ready`           | `SELECT 1` — readiness probe                        |

Why Postgres? Because we need data to **survive** — once a product is created it must still exist after the next deploy, after a crash, after the Redis cache evicts everything. Anything else (the cache, the view counter) is allowed to disappear, but products are not.

### 2.2 Redis — the fast, ephemeral helper

Redis is an **in-memory** key-value store. It's much faster than Postgres for simple reads and writes, but data lives in RAM by default and can be wiped at any time. The service uses Redis for two things:

| Endpoint                   | What Redis does                                |
|----------------------------|------------------------------------------------|
| `GET /products/:id`        | Cache: `GET product:{id}` first, then `SETEX`  |
| `DELETE /products/:id`     | Cache invalidation: `DEL product:{id}`         |
| `POST /products/:id/view`  | View counter: `INCR views:{id}`                |
| `GET /products/:id/views`  | View counter read: `GET views:{id}`            |
| `GET /ready`               | `PING` — readiness probe                       |

Why Redis? Two reasons:

- **Caching** — Postgres queries cost real time. If the same product page is loaded 1,000 times in a minute, Postgres ends up doing the same `SELECT` 1,000 times. Redis lets us answer the next 999 of those from RAM instead.
- **Counters** — Incrementing a counter 1,000 times/second is painful in Postgres (each `UPDATE` has to lock a row, write to disk, etc.). Redis has a single command, `INCR`, that does it atomically in microseconds, which is exactly right for "how many times has this product been viewed?".

### 2.3 The cache-aside pattern — `GET /products/:id`

This endpoint is the classic **cache-aside** pattern. Look at the handler in `src/server.js`:

```js
app.get('/products/:id', async (req, res) => {
  const cacheKey = `product:${id}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(JSON.parse(cached));
  }
  const result = await pool.query(
    'SELECT id, name, price, created_at FROM products WHERE id = $1', [id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const product = result.rows[0];
  await redis.set(cacheKey, JSON.stringify(product), 'EX', 60);
  res.set('X-Cache', 'MISS');
  res.json(product);
});
```

Translated to plain English:

- **Cache MISS** (first time we ask for a product): Redis doesn't have it, so we ask Postgres, *then* save the answer to Redis with a 60-second expiry, *then* return the answer with the header `X-Cache: MISS`.
- **Cache HIT** (second time within 60 seconds): Redis still has the answer from last time, so we return it immediately with `X-Cache: HIT` — Postgres is never touched.

Why this matters: the second call is dramatically faster and doesn't load Postgres. In a real system this is the difference between Postgres collapsing under load vs. handling it comfortably. The `X-Cache` header is there so a human (and a test) can *prove* which path the request took.

### 2.4 Cache invalidation — `DELETE /products/:id`

If we delete a product from Postgres but leave its entry in the Redis cache, the next `GET /products/:id` will return a "HIT" with stale data — telling the client a product still exists when it doesn't. That's a real bug.

The fix in `src/server.js`:

```js
await pool.query('DELETE FROM products WHERE id = $1', [id]);
await redis.del(`product:${id}`);  // <-- this is the invalidation
```

After deleting from Postgres we also delete the cache entry. Now the next `GET /products/:id` finds nothing in Redis, falls through to Postgres, finds nothing there either, and correctly returns `404`. Test 7 exercises exactly this path.

---

## 3. Endpoint reference

| # | Method | Path                       | Dependency        | What it does                                       | Expected response                              |
|---|--------|----------------------------|-------------------|----------------------------------------------------|------------------------------------------------|
| 1 | GET    | `/health`                  | none              | Liveness — is the process alive?                   | `200 {status:"ok"}`                            |
| 2 | GET    | `/ready`                   | Postgres + Redis  | Readiness — are both deps reachable?               | `200 {postgres:"up", redis:"up"}` or `503`     |
| 3 | POST   | `/products`                | Postgres          | Insert a product (`name`, `price`)                 | `201` + the new row with generated `id`        |
| 4 | GET    | `/products`                | Postgres          | List all products                                  | `200` + JSON array                             |
| 5 | GET    | `/products/:id`            | Postgres + Redis  | Cache-aside read of one product                    | `200` + `X-Cache: MISS` or `HIT` (or `404`)    |
| 6 | DELETE | `/products/:id`            | Postgres + Redis  | Delete row **and** invalidate cache                | `200 {deleted:true}` (or `404`)                |
| 7 | POST   | `/products/:id/view`       | Redis             | `INCR views:{id}`, atomic increment                | `200 {id, views:<new count>}`                  |
| 8 | GET    | `/products/:id/views`      | Redis             | Read the current counter (0 if unset)              | `200 {id, views:<count>}`                      |

Quick reference of *who needs what*:

- `/health` needs nothing — it's pure liveness.
- `/products/:id/view` and `/products/:id/views` need *only Redis*.
- Everything else under `/products` needs Postgres; `/products/:id` and `DELETE /products/:id` *also* need Redis.

---

## 4. The data flow — `GET /products/:id`, step by step

Let's say a client just created product `id = 1` and is now requesting it.

### First request (cache MISS)

1. The client sends `GET /products/1`.
2. Express routes the request to the handler in `src/server.js`.
3. The handler builds the cache key: `cacheKey = "product:1"`.
4. It runs `await redis.get("product:1")`. Redis has nothing for this key, so the result is `null`.
5. The handler falls through to Postgres: `SELECT id, name, price, created_at FROM products WHERE id = 1`.
6. Postgres returns one row.
7. The handler stores the row in Redis: `redis.set("product:1", "<json>", "EX", 60)` — the `EX 60` is the **TTL** (time-to-live): this key will auto-expire in 60 seconds.
8. The handler sets the response header `X-Cache: MISS`.
9. It returns `200` with the product as JSON.

### Second request (cache HIT, within 60s)

1. The client sends `GET /products/1` again.
2. Same handler, same cache key `product:1`.
3. `await redis.get("product:1")` now returns the JSON we stored on the previous call.
4. The handler parses the JSON.
5. It sets the response header `X-Cache: HIT`.
6. It returns `200` with the product — **Postgres was never touched**.

This is the whole point of caching: step 5 of the MISS path (the Postgres query) is skipped on the HIT path. The endpoint is functionally identical to the client, but vastly cheaper for the system.

After 60 seconds the Redis key expires automatically (because of the TTL), and the next call becomes a MISS again. That's how the cache stays "fresh-ish" without needing manual cleanup.

---

## 5. How to run locally

### Start the two dependencies (Docker)

```bash
docker run -d --name apilayer-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=apilayer \
  -p 5432:5432 \
  postgres:16

docker run -d --name apilayer-redis \
  -p 6379:6379 \
  redis:7
```

That's it — both containers expose their standard ports on `localhost`, which is what the app's defaults expect.

### Environment variables the app reads

| Var          | Default                 | What it's for                                       |
|--------------|-------------------------|-----------------------------------------------------|
| `PORT`       | `3000`                  | Where Express listens                               |
| `PGHOST`     | `localhost`             | Postgres host                                       |
| `PGPORT`     | `5432`                  | Postgres port                                       |
| `PGUSER`     | `postgres`              | Postgres user                                       |
| `PGPASSWORD` | `postgres`              | Postgres password                                   |
| `PGDATABASE` | `apilayer`              | Postgres database name                              |
| `REDIS_HOST` | `localhost`             | Redis host                                          |
| `REDIS_PORT` | `6379`                  | Redis port                                          |
| `API_URL`    | `http://localhost:3000` | Used by the test suite to find the running service  |

In TestKube these will point at the Postgres/Redis sidecar containers running alongside the test pod — same env vars, different values, no code change needed.

### Apply the schema (optional)

The server self-applies `db/init.sql` on startup, so this is just a verification step:

```bash
docker exec -i apilayer-postgres psql -U postgres -d apilayer < db/init.sql
```

`init.sql` uses `CREATE TABLE IF NOT EXISTS`, so it's safe to run any number of times — that's the **idempotent** property.

### Install + start the server

```bash
npm install
npm start
```

You should see log lines like:

```
[startup] Connecting to Postgres localhost:5432/apilayer as postgres
[startup] Connecting to Redis localhost:6379
[postgres] initial probe ok
[redis] ready
[postgres] schema applied
[server] listening on :3000
```

Smoke-test it:

```bash
curl localhost:3000/health   # → {"status":"ok"}
curl localhost:3000/ready    # → {"postgres":"up","redis":"up"}
```

### Run the test suite

In a second terminal (the server must be running):

```bash
npm test
```

You should see all 7 tests pass in well under a second.

---

## 6. What each test proves

The suite lives in `tests/api.test.js`. Each test exercises one specific dependency behavior:

| #  | Test                                          | What it proves                                                           |
|----|-----------------------------------------------|--------------------------------------------------------------------------|
| 1  | `GET /health` → 200                           | The process is alive (liveness, no deps touched)                         |
| 2  | `GET /ready` → both `up`                      | Both Postgres and Redis are reachable from inside the app                |
| 3  | `POST /products` returns an `id`              | Postgres **writes** work end-to-end                                      |
| 4  | `GET /products` includes the created product  | Postgres **reads** work end-to-end                                       |
| 5  | First `GET /products/:id` MISS, second HIT    | **Cache-aside works** — the cache is populated on miss and read on hit   |
| 6  | Three POSTs to `/view` then GET views = 3     | **Redis `INCR` counter works** — atomic, monotonic, Postgres-free        |
| 7  | DELETE → 404 on next GET, cache key gone      | **Cache invalidation works** — DELETE clears Redis, not just Postgres    |

Tests 5 and 6 are the headline proofs of dependency behavior. Test 5 demonstrates that we genuinely have a working two-tier read path; test 6 demonstrates the pure-Redis write path.

### Why isolation matters — and how we get it

Notice the top of `tests/api.test.js`:

```js
before(async () => {
  pool = new Pool(pgConfig);
  redis = new Redis(redisConfig);
  await pool.query('TRUNCATE products RESTART IDENTITY');
  await redis.flushdb();
});
```

Before any test runs, we wipe the products table (`TRUNCATE … RESTART IDENTITY` — empty + reset the `id` sequence back to 1) and clear all keys in Redis (`FLUSHDB`). On fresh dependencies the view counter starts at 0 and the products table is empty, so each test run starts from the *same known state*. That's why test 6 can confidently assert "views = 1, 2, 3" — we *know* the counter started at 0. Without that reset, the second test run would see views = 4, 5, 6 and fail.

This is the property that makes the suite safe to run over and over: deterministic input → deterministic output.

---

## 7. Concepts glossary

Plain definitions, in roughly the order they show up in this app.

- **Source of truth** — The one place that holds the authoritative version of the data. If a cache and the source of truth disagree, the source of truth wins. Here: Postgres.
- **Persistence** — Data that survives process restarts because it's been written to durable storage (typically disk). Postgres is persistent.
- **Ephemeral** — The opposite: data that lives only in memory and can vanish on restart. Default Redis is ephemeral (it can be configured to persist, but we don't bother for this demo).
- **Cache** — A fast, secondary copy of data placed in front of a slower system, used to answer repeat reads cheaply.
- **Cache-aside** — A specific caching pattern: the app checks the cache first, falls back to the source of truth on a miss, and then populates the cache so the next call is a hit. This service does this in `GET /products/:id`.
- **Cache HIT / MISS** — A "hit" means the cache had the answer; a "miss" means it didn't and we had to go to the source of truth. The `X-Cache` response header on `GET /products/:id` reports which one happened.
- **TTL (time-to-live)** — An expiry attached to a cached entry, so stale data eventually goes away without anyone having to remember to delete it. We set `EX 60` on cached products, so each entry self-deletes 60 seconds after it was written.
- **Cache invalidation** — Explicitly removing an entry from the cache (instead of waiting for the TTL) because the underlying data changed. `DELETE /products/:id` invalidates the matching cache key right after the DB delete.
- **INCR** — A Redis command that atomically increments a key's integer value by 1 and returns the new value. It's the right tool for counters because two clients calling it at the same time still produce a correct, monotonically increasing sequence — no race condition.
- **Connection pool** — A small group of pre-opened database connections that the app reuses across requests instead of opening a new one each time. `pg.Pool` in this app manages that for Postgres. Opening a fresh connection per request would be slow and limit throughput.
- **Idempotent** — An operation that has the same effect no matter how many times you run it. Our `init.sql` is idempotent because of `CREATE TABLE IF NOT EXISTS` — running it twice doesn't break anything. Test setup (`TRUNCATE` + `FLUSHDB`) is idempotent for the same reason.
- **Liveness vs. readiness** — Two different "is this alive?" questions. Liveness (`/health`) just confirms the process is running. Readiness (`/ready`) confirms it can actually do its job, which here means both Postgres and Redis are reachable. Kubernetes uses these probes to decide whether to restart a pod (liveness) vs. whether to send traffic to it (readiness).
