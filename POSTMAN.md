# Postman / Newman

`online-boutique-apilayer.postman_collection.json` is a Postman Collection v2.1 that exercises the apilayer service end-to-end. It runs as a story — health, ready, create, list, get-MISS, get-HIT, three view-counter increments, get-views=3, delete — and assertions on each request encode the contract for that endpoint. The cache MISS-then-HIT pair is the proof that the cache-aside layer is actually working; the views==3 assertion after three increments is the proof that the Redis counter is real.

## Idempotent across runs

Each run **creates a brand-new product**, captures its generated id into the `{{productId}}` collection variable, and uses that id for every subsequent request — including the MISS/HIT pair and the view counter. Fresh id ⇒ fresh `product:{id}` cache key and `views:{id}` counter key ⇒ MISS is guaranteed on the first call, the counter is guaranteed to start at 0. The final DELETE removes the product, so the only persistent residue per run is the unused auto-increment.

## Collection variables

| Key         | Default                  | Purpose                                              |
|-------------|--------------------------|------------------------------------------------------|
| `baseUrl`   | `http://localhost:3000`  | Where the running app is reachable                   |
| `productId` | `(empty)`                | Set by request #3 (Create product), used downstream  |

Override `baseUrl` on the CLI to point at any environment — see Newman commands below.

## Importing into Postman desktop

1. Open Postman.
2. **File → Import** (or drag the JSON into the import dialog).
3. Select `online-boutique-apilayer.postman_collection.json`.
4. The collection appears in the left sidebar. The `baseUrl` and `productId` variables are pre-populated; you can edit them in the collection's **Variables** tab.
5. Use the **Runner** to execute the whole collection in order, or click individual requests to run them by hand.

## Running headless with Newman

Newman is Postman's CLI runner. Easiest path is `npx`, no install required:

```bash
# Against the default baseUrl (http://localhost:3000):
npx newman run online-boutique-apilayer.postman_collection.json

# Pointed at any other host (e.g. a port-forwarded k8s service):
npx newman run online-boutique-apilayer.postman_collection.json \
  --env-var baseUrl=http://localhost:18030

# With JUnit-style report output (useful for CI dashboards):
npx newman run online-boutique-apilayer.postman_collection.json \
  --reporters cli,junit --reporter-junit-export newman-report.xml
```

A clean run prints a green-on-black summary; any assertion failure is listed at the bottom under `failures`.

## Running locally end-to-end

```bash
# 1. Start the dependencies (or skip if already running):
docker run -d --name apilayer-postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=apilayer -p 5432:5432 postgres:16
docker run -d --name apilayer-redis -p 6379:6379 redis:7

# 2. Install deps + start the app:
npm install
npm start &

# 3. Wait a beat, then run Newman:
sleep 2
npx newman run online-boutique-apilayer.postman_collection.json
```

See `ARCHITECTURE.md` for the full local-dev story.

## Use inside TestKube

The same JSON file is what a TestKube `postman/collection` workflow will run inside the cluster — typically with `baseUrl` set to the in-cluster Service URL `http://apilayer.apilayer.svc.cluster.local:3000` (or whatever the deployment exposes). Version-controlling the collection here makes the local run, CI run, and TestKube run all execute the exact same assertions.
