# online-boutique-apilayer

A small Node.js + Express demo API that **cannot function without both Postgres and Redis**. It exists to demonstrate the dependency-services testing pattern (later wired up in TestKube): Postgres is the system of record for products, Redis is both a read-through cache and a view counter.

## Endpoints

| # | Method | Path                       | Dependency             | Purpose                                                         |
|---|--------|----------------------------|------------------------|-----------------------------------------------------------------|
| 1 | GET    | `/health`                  | none                   | Liveness — `200 {status:"ok"}`, no dep checks                   |
| 2 | GET    | `/ready`                   | Postgres + Redis       | Readiness — `200` only if both up, else `503` with detail       |
| 3 | POST   | `/products`                | Postgres               | Create product `{name, price}`, returns `201` with generated id |
| 4 | GET    | `/products`                | Postgres               | List all products                                               |
| 5 | GET    | `/products/:id`            | Postgres + Redis       | Cache-aside — `X-Cache: MISS` first call, `HIT` subsequently    |
| 6 | DELETE | `/products/:id`            | Postgres + Redis       | Delete from DB **and** invalidate the cache key                 |
| 7 | POST   | `/products/:id/view`       | Redis                  | `INCR views:{id}`, returns the new count                        |
| 8 | GET    | `/products/:id/views`      | Redis                  | Returns the current view count (`0` if unset)                   |

`X-Cache: MISS`/`HIT` is the proof-point for cache-aside; the view counter is the proof-point for Redis-only writes.

## Running locally

### 1. Start the dependencies

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

### 2. Install + start the server

```bash
npm install
npm start
```

The server self-applies `db/init.sql` on boot (`CREATE TABLE IF NOT EXISTS products …`), so no separate migration step is needed. You can also apply it manually:

```bash
docker exec -i apilayer-postgres psql -U postgres -d apilayer < db/init.sql
```

### 3. Run the tests

In a separate terminal:

```bash
npm test
```

The tests connect to Postgres and Redis directly to `TRUNCATE products RESTART IDENTITY` and `FLUSHDB` before running, so re-runs against the same containers are idempotent.

## Configuration

All settings are environment variables — see `.env.example` for the complete list and defaults.

| Var            | Default                 | Used for                          |
|----------------|-------------------------|-----------------------------------|
| `PORT`         | `3000`                  | HTTP listen port                  |
| `PGHOST`       | `localhost`             | Postgres host                     |
| `PGPORT`       | `5432`                  | Postgres port                     |
| `PGUSER`       | `postgres`              | Postgres user                     |
| `PGPASSWORD`   | `postgres`              | Postgres password                 |
| `PGDATABASE`   | `apilayer`              | Postgres database name            |
| `REDIS_HOST`   | `localhost`             | Redis host                        |
| `REDIS_PORT`   | `6379`                  | Redis port                        |
| `API_URL`      | `http://localhost:3000` | Base URL the test suite targets   |

## Layout

```
src/server.js        Express app + Postgres pool + Redis client
db/init.sql          Idempotent products-table schema
tests/api.test.js    node:test + supertest, hits a running instance
testkube/            (reserved) TestWorkflow YAMLs will land here
.env.example         Documented env vars
```
