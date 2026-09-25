# ConfirmX infrastructure audit (Railway → VPS)

Audited 2026-09-25 from the Railway CLI (read-only: project, services, deployments,
variable **names**), public DNS, HTTP probes and the repository. No value of any
secret was read or printed; database/Redis providers were identified from the URL
scheme and domain suffix only.

## 1. Current production — state at audit time

> **Production is DOWN.** `https://api.confirmx.ai` and `https://confirmx.ai` return
> Railway's `404 Application not found`. Both services have **no active deployment**:
> the most recent deployments were `REMOVED` (last on 2026-05-16) and the latest
> build attempts `FAILED` (api 2026-05-04, web 2026-05-08).
>
> Consequence for the migration: Railway is **not** a working rollback target today.
> Rolling back to Railway would first require a successful Railway redeploy.

### Railway project `confirmx_ai` (environment `production`, no volumes)

| Service | Source | Start command | Domains | Latest deployment |
| --- | --- | --- | --- | --- |
| `backend-intellivery` (API) | GitHub `rezainiet/eco-logistics-ai` | `node apps/api/dist/index.js` | `api.confirmx.ai`, `eco-logistics-ai-production.up.railway.app` | FAILED 2026-05-04; none active |
| `frontend-confirmx` (dashboard) | GitHub `rezainiet/eco-logistics-ai` | `npm --workspace apps/web run start -- -p $PORT` | `confirmx.ai`, `earnest-flexibility-production-10dc.up.railway.app` | FAILED 2026-05-08; none active |
| `function-bun` | image `ghcr.io/railwayapp/function-bun:1.3.0` | Railway "Hello world" template | `function-bun-production-8e02.up.railway.app` | never deployed — **unused, not part of ConfirmX** |

No Railway-managed database, Redis, cron service, volume or health-check path is
configured. Build command: Railway default (Nixpacks, `npm run build`).
The landing-page renderer (`apps/sites`) has **never been deployed**.

### External dependencies (still needed after migration)

| Dependency | Evidence | Notes |
| --- | --- | --- |
| MongoDB **Atlas** | `MONGODB_URI` scheme `mongodb+srv`, host `*.mongodb.net` | Keep during migration: add the VPS public IP to Atlas → Network Access. Free/M0 clusters pause after long inactivity — confirm it is running. |
| Redis **Upstash** | `REDIS_URL` scheme `rediss`, host `*.upstash.io` | BullMQ queues + cache. Either keep Upstash or run Redis locally on the VPS (see MIGRATION-PLAN). |
| Resend (email) | `RESEND_API_KEY` present | |
| Shopify public app | `SHOPIFY_APP_API_KEY/SECRET` present; `shopify.app.toml` | Registered URLs use **api.confirmx.ai** — keep that hostname and nothing needs re-registering. |
| Stripe, Twilio, SSL Wireless, Sentry | variables **not set** on Railway | Not active in production. |

### DNS (authoritative: Hostinger — `helios/aster.dns-parking.com`)

| Name | Record today | Serves |
| --- | --- | --- |
| `confirmx.ai` | A `69.46.46.2` (Railway edge) | dashboard (frontend-confirmx) |
| `www.confirmx.ai` | CNAME `confirmx.ai` | dashboard |
| `api.confirmx.ai` | CNAME `ta18xxk6.up.railway.app` | API |
| `app.confirmx.ai` | **none** | referenced by docs/Shopify listing links — decide: add it, or keep the dashboard at the apex |
| `status.confirmx.ai` | none | referenced in docs |

### Railway variable inventory (names only)

- **API:** `ADMIN_SECRET API_PORT CORS_ORIGIN COURIER_ENC_KEY EMAIL_FROM JWT_SECRET MONGODB_URI NODE_ENV PUBLIC_API_URL PUBLIC_WEB_URL REDIS_URL RESEND_API_KEY SHOPIFY_APP_API_KEY SHOPIFY_APP_API_SECRET TRIAL_DAYS TRUSTED_PROXIES` (+ Railway's own `RAILWAY_*`)
- **Web:** `NEXTAUTH_SECRET NEXTAUTH_URL NEXT_PUBLIC_API_URL NODE_ENV` (+ `RAILWAY_*`)
- Full per-variable purpose / requirement: [ENVIRONMENT.md](ENVIRONMENT.md); template: `/.env.production.example`.
- `SMS_WEBHOOK_SHARED_SECRET` is not set (the API warns at boot); `CORS_ORIGIN`/`PUBLIC_WEB_URL` values must match the chosen dashboard hostname (`confirmx.ai` vs `app.confirmx.ai`).

## 2. What the application needs (from the code)

| Concern | Finding |
| --- | --- |
| Processes | 3 Node processes: **api** (Express + tRPC + 16 BullMQ workers in-process, `apps/api/CLAUDE.md`), **web** (Next 14), **sites** (Next 14, landing renderer). No separate worker service. |
| Scheduled jobs | All recurring work is BullMQ **repeatable jobs** stored in Redis and run by the api process — no OS cron, no Railway cron. |
| Storage / uploads | No filesystem uploads. Landing-page images are stored **in MongoDB** (`LandingAsset.data`, ≤700 KB each) and served by `/api/landing-assets`. A Mongo backup covers them. |
| Health | api `GET /health` (liveness) · `GET /ready` (Mongo + Redis) · web `GET /api/health` · sites `GET /healthz`, `GET /readyz` (API reachable). Smoke test: `deploy/vps/smoke-test.sh`. |
| Auth | NextAuth (JWT session, `NEXTAUTH_SECRET`) → API access JWT (`JWT_SECRET`) + HttpOnly refresh cookie. Changing either secret signs everyone out. |
| Secrets that must be carried over **exactly** | `COURIER_ENC_KEY` (encrypts stored courier credentials — a new key makes them unreadable), `JWT_SECRET`, `NEXTAUTH_SECRET`, `ADMIN_SECRET`, `SHOPIFY_APP_API_SECRET` (webhook HMAC). |
| CORS | API allows exactly `CORS_ORIGIN` (dashboard origin). |
| CSP | Dashboard: report-only CSP (`CSP_ENFORCED=true` to enforce), `frame-src` includes the landing preview origin. Sites: strict CSP; Meta origins on public pages only. |
| Proxy trust | `TRUSTED_PROXIES` — on the VPS set `loopback` (only Nginx). |
| Callback URLs registered with third parties | Shopify: `https://api.confirmx.ai/api/shopify/install`, `/api/integrations/oauth/shopify/callback`, `/api/integrations/webhook/shopify`, GDPR `/api/webhooks/shopify/gdpr/*`. Courier/SMS/Resend/Stripe/Twilio webhooks live under `https://api.confirmx.ai/api/webhooks/*`. |
| Public host resolver (landing pages) | apps/sites → `LANDING_API_URL` (loopback on the VPS) → `publicLanding.resolveByHost`. Not routed publicly until the DOMAIN phase. |

## 3. Target VPS architecture

```
                      Internet
                         │
          ┌──────────────┼──────────────────────────────┐
          │ 80/443       │ 5060/udp(+tcp) · RTP range    │ 22
          ▼              ▼                               ▼
       Nginx          Asterisk (unchanged)              sshd
   ┌─────┼─────────┐
   ▼     ▼         ▼
 web   api      sites (not routed until DOMAIN phase)
 :3001 :4000    :3002        all bound to 127.0.0.1, run by systemd as user `confirmx`
         │
         ├── MongoDB Atlas (unchanged, TLS)            ← or local mongod later (optional)
         └── Redis: Upstash (unchanged) or 127.0.0.1:6379
```

- No Docker, Kubernetes or extra services. Node 22 LTS + npm workspaces
  (the repo uses **npm**, not pnpm), Nginx, certbot, optional `redis-server`.
- ConfirmX units are resource-capped (`CPUWeight=50`, `Nice=5`, `MemoryMax`) so
  they can never starve Asterisk of CPU/RAM. They never touch Asterisk files,
  ports or firewall rules for SIP/RTP.

## 4. Port map

| Port | Owner | Exposure | Collision risk |
| --- | --- | --- | --- |
| 22/tcp | sshd | public (restrict by IP / fail2ban) | — |
| 80, 443/tcp | **Nginx** (new) | public | Check first: an existing web server on the PBX host (Apache/FreePBX GUI, another Nginx) — `deploy/vps/preflight.sh` reports it. |
| 3001/tcp | web | 127.0.0.1 only | preflight checks |
| 3002/tcp | sites | 127.0.0.1 only | preflight checks |
| 4000/tcp | api | 127.0.0.1 only | preflight checks |
| 6379/tcp | redis (optional) | 127.0.0.1 only | — |
| 27017/tcp | mongod (optional, later) | 127.0.0.1 only | — |
| 5060/udp (+5061/tcp TLS) | Asterisk PJSIP | public, **unchanged** | none — ConfirmX never binds SIP ports |
| RTP range (rtp.conf, typically 10000–20000/udp) | Asterisk | public, **unchanged** | none |
| 5038/tcp | Asterisk AMI | 127.0.0.1 only | none |
| 8088/8089 | Asterisk HTTP/ARI (if enabled) | usually local | ConfirmX avoids these ports |

## 5. PBX host facts

Pending: collected by running `deploy/vps/preflight.sh` and
`ops/backup/pbx-backup.sh` on the PBX host (read-only). Once available, record here:
OS, Asterisk version, transports, endpoints, trunk registration state, firewall,
fail2ban jails, listening ports, existing web server.
