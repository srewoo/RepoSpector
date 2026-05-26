# Aegis — RepoSpector Backend Service

Code-complete, locally-runnable. Hosts the orchestrated review pipeline
server-side so RepoSpector can do what a Chrome extension can't:
real `git clone`, cross-repo coupling, webhook automation, multi-tenant
standards, and metered billing.

See `docs/adr/0001-backend-service.md` for the design.

## Bring up locally

```bash
docker compose up --build
# api      → http://localhost:8080
# worker   → tails the BullMQ `review` queue
# postgres → :5432   (db=aegis user=aegis pass=aegis)
# redis    → :6379
```

`migrate` runs once and exits; `api` and `worker` boot when migrations finish.

## Smoke test (no auth — dev tenant)

```bash
# Create a dev tenant (one-off)
docker compose exec postgres psql -U aegis -d aegis -c \
  "INSERT INTO tenant (name, plan) VALUES ('local-dev', 'free') RETURNING id;"
# Copy the returned UUID into TENANT below.

TENANT=<paste-uuid>
curl -X POST http://localhost:8080/v1/review/mr \
  -H "Content-Type: application/json" \
  -H "X-Aegis-Dev-Tenant: $TENANT" \
  -d '{
    "mr_url": "https://github.com/octocat/Hello-World/pull/1",
    "head_sha": "abc1234"
  }'

# → { "job_id": "...", "status": "queued", "poll_url": "/v1/review/<job_id>" }

curl -s http://localhost:8080/v1/review/<job_id> -H "X-Aegis-Dev-Tenant: $TENANT" | jq
```

The worker logs every step. Source repo is shallow-cloned to
`/tmp/aegis/<job_id>/`, the orchestrator runs against the real diff, and
the workspace is wiped at job end.

## Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET  | `/v1/health` | Liveness | — |
| GET  | `/v1/readiness` | DB reachable? | — |
| POST | `/v1/review/mr` | Submit MR for review | JWT |
| GET  | `/v1/review/:jobId` | Poll status + report | JWT |
| GET  | `/v1/standards` | Fetch tenant standards bundle | JWT |
| PUT  | `/v1/standards` | Replace tenant standards bundle | JWT (admin) |
| POST | `/v1/feedback` | Dismiss / accept a finding | JWT |
| POST | `/v1/webhook/github` | GitHub App webhook | HMAC-SHA256 |
| POST | `/v1/webhook/gitlab` | GitLab system hook | Token header |
| POST | `/v1/billing/webhook` | Stripe → Aegis | Stripe HMAC |
| POST | `/v1/billing/checkout` | Hosted Stripe Checkout URL | JWT (admin) |

## Requires user action (before going to production)

These need accounts / credentials the engineer cannot create from inside the repo:

1. **GitHub App** — register at https://github.com/settings/apps/new
   Permissions: Read pull-requests, Read contents. Subscribe to
   `pull_request` events. Set webhook URL → `<aegis>/v1/webhook/github`.
   Copy: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`.
2. **GitLab webhook** — per-project or group. Set `X-Gitlab-Token` =
   `GITLAB_WEBHOOK_SECRET`. Subscribe to *Merge request events*.
3. **Stripe** — create product "Aegis Pro" with a metered price (event
   name = number of MR reviews). Note the price id (set
   `STRIPE_PRO_PRICE_ID`) and meter id (set `STRIPE_USAGE_METER_ID`).
   Add a webhook endpoint pointing at `<aegis>/v1/billing/webhook`. Copy
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
4. **Deep-review LLM hook** — replace `BackendDeepEngine` in
   `src/workers/reviewWorker.js` with a real LLM caller. The orchestrator
   already does everything else; this is the one integration seam.
5. **AWS / hosting** — `apps/api/Dockerfile` is hosting-agnostic. Deploy
   to ECS Fargate, Cloud Run, Fly, or anywhere that runs containers.
   Provision RDS Postgres + ElastiCache Redis equivalents.

## Architecture map

```
extension (popup + content)                ┐
   │                                       │
   ▼ POST /v1/review/mr (JWT)              │
api (Fastify) ─── enqueue ──► review queue ◄── webhook handlers
                                │              (github/gitlab/stripe)
                                ▼
                          review worker (BullMQ)
                            │
                            ▼ shallow clone
                          /tmp/aegis/<jobId>/
                            │
                            ▼ orchestrator (review-core)
                            │  skip rules → chunker → deep + standards
                            │   → assigned-hunks normalize → dedupe
                            ▼
                          cross-repo verification
                            │  clone consumer repos, grep for changed symbols
                            ▼
                          persist VerdictReport to Postgres
                          emit usage_event
                          wipe workspace
```
