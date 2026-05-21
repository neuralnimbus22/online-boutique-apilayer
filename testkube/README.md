# TestKube workflows

Version-controlled source-of-truth for the TestKube TestWorkflows that exercise this service. The same definitions also live in the TestKube control plane — when they diverge, the file in this folder wins.

## `dependency-services-test.yaml`

### What it does

This workflow proves the API layer works against real Postgres and Redis (not mocks) by:

1. Spinning up **ephemeral** Postgres 16 and Redis 7 containers as TestKube **services** inside the test pod. They get fresh IPs each run and are torn down when the workflow ends.
2. Waiting for each service to pass its TCP readiness probe (`5432` for Postgres, `6379` for Redis) — `periodSeconds: 2`, `failureThreshold: 30`, so up to ~60s for slow image pulls.
3. Checking out this repo's `main` branch into `/data/repo`.
4. Installing app dependencies with `npm ci` (lockfile-strict, faster than `npm install` in CI).
5. Starting the API app in the background, pointed at the service IPs via `PGHOST` / `REDIS_HOST` env vars (templated from `{{ services.postgres.0.ip }}` and `{{ services.redis.0.ip }}`).
6. Polling `GET /ready` until it returns 200 (proves the app connected to both deps).
7. Running `npm test` — the integration suite in `tests/api.test.js`. Tests `TRUNCATE products RESTART IDENTITY` and `FLUSHDB` before they run, so they always start from a known-empty state.
8. Capturing the test exit code, killing the app process, and exiting with the test code so a test failure fails the workflow.

### Why fresh dependencies matter

Every run gets a brand-new Postgres and Redis — empty tables, counter at 0, no leftover keys. That's what makes the suite **deterministic and isolated**: the same sequence of API calls produces the same observable behavior every time (test 5 sees `MISS` then `HIT`, test 6 sees the counter go `1, 2, 3`). Locally you have to TRUNCATE+FLUSHDB to get the same property; in TestKube the ephemeral services give it to you for free.

### Gotcha: start the app with `node`, not `npm start`

The shell step starts the app with `node src/server.js &` and captures `$!` as the app PID. **Do not** change this to `npm start &`.

`npm start` is a wrapper script — it forks a child process that runs `node src/server.js`. When you capture `$!` after `npm start &`, you get the PID of the npm wrapper, **not** the node process. `kill $APP_PID` then kills the wrapper, the node child gets reparented to PID 1, and the shell step hangs at the end waiting for the orphan to exit (or hits the workflow timeout). Calling `node` directly makes `$!` the real server process, so `kill $APP_PID` actually stops the server and the step exits cleanly.

### Running it

This file is what the cluster runs. To apply changes:

```bash
# Apply to the cluster (overwrites the in-cluster object if it already exists):
kubectl apply -f testkube/dependency-services-test.yaml

# Trigger a run from the CLI:
testkube run testworkflow apilayer-dependency-services-test

# Or trigger from the TestKube Cloud dashboard (Workflows → run).
```

Inspect the most recent run:

```bash
testkube get testworkflowexecutions --testworkflow apilayer-dependency-services-test
```

All 7 tests passing in the run output is the proof that the integration works against real, freshly-spawned Postgres + Redis on every commit.
