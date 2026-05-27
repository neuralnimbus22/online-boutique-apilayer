# CLAUDE.md — online-boutique-apilayer

## What this is
A small Node.js + Express API that **genuinely cannot function without Postgres + Redis**. Postgres is the system of record for `products`; Redis is a cache-aside layer (`product:{id}`) and an atomic view counter (`views:{id}`). The repo exists to demonstrate the TestKube **dependency-services** testing pattern — same app, three test surfaces (node:test, Postman/Newman, an in-cluster TestWorkflow with ephemeral Postgres + Redis sidecars). See `ARCHITECTURE.md` for the deeper, beginner-friendly walkthrough.

## Architecture
```
client ─► Express app (src/server.js, port 3000)
              │
              ├──► Postgres (pg.Pool)   — products table, source of truth
              │       schema auto-applied from db/init.sql on startup
              │
              └──► Redis (ioredis)      — cache-aside + view counter (in-memory)
```
Eight endpoints; key proof-points are `GET /products/:id` (cache MISS → HIT) and `POST /products/:id/view` (Redis `INCR`). `GET /ready` reports 200 only when BOTH deps respond.

The app gets deployed two different ways from the same code:
1. **Persistent k8s deployment** in `local-laptop` namespace — `k8s/{apilayer,postgres,redis}.yaml`. The TestKube agent watches this namespace; an `apilayer-redeploy-trigger.yaml` TestTrigger fires a TestWorkflow whenever this deployment is modified.
2. **Ephemeral per-test-run** inside `testkube/dependency-services-test.yaml` — the TestWorkflow `services:` block stands up fresh `postgres:16` + `redis:7` containers for that one run, then tears them down.

## Key directories
| Path | Contents |
|---|---|
| `src/server.js` | Express app + `pg.Pool` + `ioredis` client. Eight endpoints. Auto-applies `db/init.sql` on startup. |
| `db/init.sql` | Idempotent `CREATE TABLE IF NOT EXISTS products …`. |
| `tests/api.test.js` | `node:test` + `supertest`. `TRUNCATE products RESTART IDENTITY` + `FLUSHDB` in `before()` so re-runs are idempotent. |
| `online-boutique-apilayer.postman_collection.json` | 11-request Newman story: health → ready → create → list → MISS → HIT → view×3 → views=3 → delete. Each run uses a unique product id. |
| `POSTMAN.md` | Newman usage docs. |
| `Dockerfile` | `node:20-alpine`, `npm ci --omit=dev`, runs as USER `node`. |
| `k8s/apilayer.yaml` | Deployment + Service. Image `apilayer:local`, `imagePullPolicy: Never`. Busybox initContainer waits for postgres + redis TCP before app starts. |
| `k8s/postgres.yaml`, `k8s/redis.yaml` | Long-running deps for the persistent k8s deployment. |
| `testkube/dependency-services-test.yaml` | TestWorkflow with ephemeral postgres + redis `services:`. |
| `apilayer-redeploy-trigger.yaml` | TestTrigger: deployment `app: apilayer` in `local-laptop` → fires `apilayer-postman-tests` workflow on `modified`. |
| `.env.example` | Documented env vars. |

## How to run / deploy

**Local dev (standalone docker deps):**
```bash
docker run -d --name apilayer-postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=apilayer \
  -p 5432:5432 postgres:16
docker run -d --name apilayer-redis -p 6379:6379 redis:7

npm install
npm start                                          # runs node src/server.js on :3000
npm test                                           # node --test tests/*.test.js  (needs server up)
npx newman run online-boutique-apilayer.postman_collection.json
```

**Deploy to Kubernetes (the persistent `local-laptop` deployment):**
```bash
# Build image into Docker Desktop's daemon (k8s uses dockerd as runtime)
docker build -t apilayer:local .

# Apply (namespace is set in each manifest — local-laptop)
kubectl apply -f k8s/
kubectl -n local-laptop rollout status deploy/apilayer
```

**Verify in-cluster:**
```bash
kubectl -n local-laptop port-forward svc/apilayer 18030:3000
curl http://localhost:18030/ready    # expect {"postgres":"up","redis":"up"}
```

**Apply the TestTrigger (after the TestWorkflow it references exists in TestKube Cloud):**
```bash
kubectl apply -f apilayer-redeploy-trigger.yaml
```

## Conventions / gotchas
- **Namespace is `local-laptop`, not `apilayer`** — deliberate. The TestKube runner watches its own namespace, so the deployment must live there for the TestTrigger to see it.
- **Image is local-only**: `apilayer:local` + `imagePullPolicy: Never`. Docker Desktop k8s uses `dockerd` so a local `docker build` is visible to the kubelet. Don't push to a registry.
- **Schema apply is one-shot on startup** — the busybox initContainer (`wait-for-deps`) blocks until postgres + redis accept TCP, so the schema apply always succeeds on first try. Without that init, the app would silently fail the schema step and later writes would break.
- **Service hostnames are bare names** (`postgres`, `redis`) — works because everything is in the same namespace. App env (`PGHOST=postgres`, `REDIS_HOST=redis`) is wired in `k8s/apilayer.yaml`.
- **Tests reset state via direct DB+Redis access** — `before()` truncates products and `FLUSHDB`s. They hit the API over HTTP via `API_URL` (default `http://localhost:3000`), but they need pg + ioredis credentials too, so all `PG*`/`REDIS_*` vars must be set when running tests.
- **Postman collection is idempotent across runs** — each run generates a fresh product id, so MISS-then-HIT and the `view×3 → views=3` assertion don't collide across runs. No global cleanup needed.
- **TestTrigger lives in `local-laptop`** (not next to the workflow on the cloud control plane). Apply it with `kubectl`.

## Common tasks
- **Change app behavior** → `src/server.js`. Update tests in `tests/api.test.js` and request bodies in `online-boutique-apilayer.postman_collection.json` if endpoints change. Don't forget to update the README endpoint table + `ARCHITECTURE.md`.
- **Redeploy after code change** → `docker build -t apilayer:local .` then `kubectl -n local-laptop rollout restart deploy/apilayer`. The TestTrigger should fire automatically.
- **Run only the Newman tests against a deployed instance** → port-forward, then `npx newman run … --env-var baseUrl=http://localhost:18030`.
- **Inspect what the TestWorkflow does in TestKube** → read `testkube/dependency-services-test.yaml`; the `shell:` block is the actual command sequence (npm ci, start app in background, wait for `/ready`, `npm test`, kill app).
- **Schema change** → edit `db/init.sql` (keep it idempotent: `IF NOT EXISTS` / `ALTER … IF EXISTS`). The app re-runs it on every startup so a pod restart applies it.
