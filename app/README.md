# task-api

A small task-list REST API (Node.js 22+/Express 5) backed by PostgreSQL. The business logic stays
minimal on purpose. The code focuses on what operations need: health probes, Prometheus metrics,
structured JSON logs, configuration from the environment, graceful shutdown and a fault-injection
switch for incident drills.

## Endpoints

| Method   | Path         | Description                                                   |
| -------- | ------------ | ------------------------------------------------------------- |
| `GET`    | `/tasks`     | List tasks. Query: `limit` (1–100, default 50), `offset` (≥0) |
| `POST`   | `/tasks`     | Create a task. Body: `{"title": "...", "done": false}`        |
| `GET`    | `/tasks/:id` | Get one task                                                  |
| `PATCH`  | `/tasks/:id` | Update `title` and/or `done`                                  |
| `DELETE` | `/tasks/:id` | Delete a task                                                 |
| `GET`    | `/health`    | **Liveness**: always 200 while the process runs (no DB check) |
| `GET`    | `/ready`     | **Readiness**: 200 when the DB is reachable, 503 otherwise    |
| `GET`    | `/metrics`   | Prometheus metrics (text exposition format)                   |
| `GET`    | `/`          | Service name, version and endpoint list                       |

Errors are JSON: `{"error": {"status": 404, "message": "task not found", "request_id": "..."}}`.
Internal error details are never returned to the client; they are in the logs, under the same `request_id`.

### Why `/health` and `/ready` are separate

- The **liveness probe** (`/health`) must not depend on the database. If it did, a database outage
  would make Kubernetes restart every pod, which would not fix anything.
- The **readiness probe** (`/ready`) checks the database. A pod that can't reach it is removed from
  the Service endpoints until it can. It also returns 503 before the schema migration has run and
  once shutdown has started.

## Configuration

All configuration comes from environment variables. Invalid values stop the app at startup.

| Variable                   | Default    | Kubernetes source | Description                                                  |
| -------------------------- | ---------- | ----------------- | ------------------------------------------------------------ |
| `PORT`                     | `3000`     | ConfigMap         | HTTP port                                                    |
| `LOG_LEVEL`                | `info`     | ConfigMap         | `fatal` `error` `warn` `info` `debug` `trace` `silent`       |
| `APP_VERSION`              | `dev`      | image / Deployment | Version shown in logs, `/health` and `app_info` (**use the git commit SHA**) |
| `SERVICE_NAME`             | `task-api` | ConfigMap         | `service` field in logs                                      |
| `DB_HOST`                  | `localhost`| ConfigMap         | PostgreSQL host                                              |
| `DB_PORT`                  | `5432`     | ConfigMap         | PostgreSQL port                                              |
| `DB_NAME`                  | `taskapi`  | ConfigMap         | Database name                                                |
| `DB_USER`                  | `taskapi`  | ConfigMap/Secret  | Database user                                                |
| `DB_PASSWORD`              | *(empty)*  | **Secret**        | Database password                                            |
| `DB_SSL`                   | `false`    | ConfigMap         | `true` to require TLS to the database                        |
| `DB_POOL_MAX`              | `10`       | ConfigMap         | Max connections per pod                                      |
| `DB_CONNECTION_TIMEOUT_MS` | `2000`     | ConfigMap         | Timeout to get a connection                                  |
| `DB_STATEMENT_TIMEOUT_MS`  | `5000`     | ConfigMap         | Server-side query timeout                                    |
| `SHUTDOWN_DELAY_MS`        | `0`        | ConfigMap         | Keep serving this long after SIGTERM (set `5000` on Kubernetes) |
| `SHUTDOWN_TIMEOUT_MS`      | `10000`    | ConfigMap         | Max time to drain in-flight requests after the delay         |
| `FAULT_ERROR_RATE`         | `0`        | ConfigMap         | Fault injection: fraction (0–1) of `/tasks` requests that fail with 500 |
| `FAULT_LATENCY_MS`         | `0`        | ConfigMap         | Fault injection: extra latency added to `/tasks` requests    |

The schema (`tasks` table) is created at startup. A Postgres advisory lock stops replicas that start
together from running the migration at the same time. If the database is not reachable yet, the
app keeps running (liveness OK, readiness 503) and retries with exponential backoff, up to 30 s
between attempts.

## Run locally

Prerequisites: Node.js ≥ 22.13 (24 LTS recommended), Docker.

```bash
cd app
cp .env.example .env              # then set DB_PASSWORD to any local value
docker compose up -d --wait       # local PostgreSQL on 127.0.0.1:5432
npm ci
npm run dev                       # http://localhost:3000, reloads on change

curl -s localhost:3000/tasks -H 'content-type: application/json' -d '{"title":"hello"}'
curl -s localhost:3000/tasks
curl -s localhost:3000/ready
curl -s localhost:3000/metrics | grep http_requests_total

docker compose down -v            # stop and delete the local database
```

## Quality gates (for the CI pipeline)

| Command                    | What it does                                                                 | Needs DB |
| -------------------------- | ---------------------------------------------------------------------------- | -------- |
| `npm ci`                   | Clean install from the lockfile (exact pinned versions)                      | no       |
| `npm run lint`             | ESLint (fails on any error)                                                  | no       |
| `npm test`                 | Unit tests (in-memory repository)                                            | no       |
| `npm run test:ci`          | Unit tests + coverage (fails under 80 % lines) + JUnit report in `test-results/junit.xml` | no |
| `npm run test:integration` | Tests against a real PostgreSQL, using the `DB_*` variables                  | **yes**  |
| `npm run audit`            | `npm audit` on production dependencies, fails on high/critical              | no       |

In CI, run the integration tests with a `postgres` service container and the `DB_*` variables
set in the job environment.

## Container image notes (for the Dockerfile)

- Entry point: `node src/server.js` from the `app/` directory. Production dependencies only: `npm ci --omit=dev`.
- Listens on `PORT` (default `3000`) and handles `SIGTERM`: run `node` directly as PID 1, not through `npm start`, so the signal reaches the app.
- Pass the commit SHA as `APP_VERSION` (for example `ARG APP_VERSION` + `ENV APP_VERSION=$APP_VERSION`) so logs, `/health` and the `app_info` metric show which commit is running.
- Do not copy into the image: `node_modules/`, `test/`, `coverage/`, `test-results/`, `.env*`, `compose.yaml`.
- Writes nothing to disk, so it runs under a non-root user with a read-only root filesystem.

## Kubernetes notes (for the manifests)

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
  periodSeconds: 5
  failureThreshold: 2
# with SHUTDOWN_DELAY_MS=5000 and SHUTDOWN_TIMEOUT_MS=10000:
terminationGracePeriodSeconds: 20
```

To scrape metrics, Prometheus targets port `3000`, path `/metrics`.

## Observability

### Metrics

| Metric                            | Type      | Labels                            | Use                                  |
| --------------------------------- | --------- | --------------------------------- | ------------------------------------ |
| `http_requests_total`             | counter   | `method`, `route`, `status_code`  | Traffic and error-rate SLI           |
| `http_request_duration_seconds`   | histogram | `method`, `route`, `status_code`  | Latency SLI (buckets include 0.25 s and 0.5 s) |
| `db_pool_connections`             | gauge     | `state` = `total`/`idle`/`waiting`| DB pool saturation                   |
| `app_info`                        | gauge (1) | `version`, `node_version`         | Which commit runs where              |
| `process_*`, `nodejs_*`           | various   |                                   | CPU, memory, event loop lag, GC      |

`route` is the route template (`/tasks/:id`), not the raw URL, which keeps label cardinality bounded.
Unknown paths are labelled `unmatched`. `/health`, `/ready` and `/metrics` are **not** counted, so the
SLIs only reflect user traffic.

Example PromQL:

```promql
# Error rate (5xx ratio) over 5 minutes
sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# p95 latency per route
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))

# Share of requests served under 250 ms (latency SLI)
sum(rate(http_request_duration_seconds_bucket{le="0.25"}[5m])) / sum(rate(http_request_duration_seconds_count[5m]))

# Version running per pod
app_info
```

### Logs

One JSON object per line on stdout:

```json
{"level":"info","time":"2026-11-24T14:03:12.481Z","service":"task-api","version":"3f2c1ab","request_id":"6f1c…","method":"POST","path":"/tasks","route":"/tasks","status":201,"duration_ms":4.21,"user_agent":"curl/8.7.1","msg":"request completed"}
```

- `level`: `info` for 2xx/3xx, `warn` for 4xx, `error` for 5xx. Probe and scrape requests log at `debug`.
- `request_id`: taken from the incoming `X-Request-Id` header if valid, otherwise generated. It is
  sent back in the `X-Request-Id` response header and included in error responses.
- Server errors also produce a `"msg":"request failed"` line with the full `err` (type, message, stack).
- `password` fields and the `Authorization`/`Cookie` headers are redacted.

Example LogQL (Loki), assuming the pods carry the label `app="task-api"`:

```logql
{app="task-api"} | json | level="error"
{app="task-api"} | json | status >= 500 | line_format "{{.method}} {{.route}} {{.status}} {{.request_id}}"
{app="task-api"} | json | duration_ms > 250
sum by (status) (count_over_time({app="task-api"} | json | msg="request completed" [5m]))
{app="task-api"} | json | request_id="<id from an error response>"
```

## Fault injection (incident drills)

`FAULT_ERROR_RATE` and `FAULT_LATENCY_MS` are off by default. They affect only `/tasks` routes,
never the probes or `/metrics`, so pods stay up and ready while the user-facing symptoms show. Errors
injected this way are logged with `"fault_injected": true`.

```bash
# Example on Kubernetes: 30 % of requests fail, so the error-rate alert should fire
kubectl set env deployment/task-api FAULT_ERROR_RATE=0.3
# Mitigate by rolling back to the previous ReplicaSet
kubectl rollout undo deployment/task-api
```

## Project layout

```
app/
├── src/
│   ├── server.js            # entry point: wiring, startup migration, graceful shutdown
│   ├── app.js               # Express app factory (no I/O, testable)
│   ├── config.js            # env parsing and validation
│   ├── logger.js            # pino JSON logger
│   ├── metrics.js           # Prometheus registry and metrics
│   ├── db.js                # pg pool, migration, ping
│   ├── readiness.js         # readiness logic
│   ├── errors.js
│   ├── middleware/          # request context (logs + metrics), errors, fault injection
│   ├── repositories/        # PostgreSQL task repository
│   └── routes/tasks.js      # /tasks endpoints and validation
├── test/
│   ├── unit/                # no external dependency
│   ├── integration/         # needs PostgreSQL
│   └── helpers/
├── compose.yaml             # local PostgreSQL
├── eslint.config.js
├── package.json / package-lock.json
└── .env.example
```
