# ConfirmX environment inventory

Every variable the three services read, from `apps/api/src/env.ts` (validated at
boot — the API refuses to start on invalid values), `process.env` reads in
apps/web and apps/sites, and `next.config.mjs` files. Template with the same
names: `/.env.production.example`. **No values here or anywhere in git.**

Legend — Required: **R** always · **P** required when `NODE_ENV=production` · O optional.
Build: **B** = read by `next build` (changing it needs a rebuild).
On Railway today: ✔ set · — not set.

## Environments

| | development | staging / QA | production |
| --- | --- | --- | --- |
| Where | developer machine | VPS with temporary hostnames (`app-vps.*`, `api-vps.*`) or a scratch DB | VPS behind `confirmx.ai` / `api.confirmx.ai` |
| Env files | `.env` (git-ignored) per app | `/etc/confirmx/*.env` on the VPS | `/etc/confirmx/*.env` on the VPS |
| Database | local mongod / docker-compose | **copy** of production, never production itself | Atlas (production) |
| `NODE_ENV` | development | production | production |
| Landing domain | `*.localhost` | unset (404) until DOMAIN phase | unset until DOMAIN phase |

Production secrets are never copied into git, CI logs or staging.

## API (`/etc/confirmx/api.env`)

| Variable | Purpose | Req | Railway | Where used |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | runtime mode; production enables strict checks | R | ✔ | env.ts |
| `API_PORT` | listen port (VPS: 4000 on 127.0.0.1) | O (4000) | ✔ | index.ts |
| `API_HOST` | listen interface; VPS `127.0.0.1` (loopback only, Nginx proxies). Unset = all interfaces | P | — | index.ts |
| `LANDING_PROXY_SECRET` | shared with the Sites checkout proxy; only then is its forwarded customer IP trusted | P | — | server/landing-orders.ts |
| `MONGODB_URI` | MongoDB connection (Atlas) | R | ✔ | lib/db.ts |
| `REDIS_URL` | BullMQ queues, repeatable jobs, cache | P | ✔ | lib/queue.ts, lib/redis |
| `JWT_SECRET` | signs API access tokens (≥16) — changing it signs everyone out | R | ✔ | auth |
| `ADMIN_SECRET` | guards `/admin/*` maintenance endpoints (≥24) | P | ✔ | server/admin.ts |
| `COURIER_ENC_KEY` | AES key for stored courier credentials — **must be carried over exactly** | R | ✔ | lib/crypto |
| `CORS_ORIGIN` | the dashboard origin allowed to call the API | R | ✔ | index.ts |
| `PUBLIC_API_URL` | public API base (webhook URLs, asset URLs, emails) | P | ✔ | many |
| `PUBLIC_WEB_URL` | public dashboard base (links in emails) | P | ✔ | email, billing |
| `TRUSTED_PROXIES` | which proxy hops may set X-Forwarded-For (VPS: `loopback`) | O | ✔ | index.ts |
| `TRIAL_DAYS`, `TRIAL_WARNING_DAYS` | trial length / reminder | O | ✔ / — | billing |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` | transactional email | O | ✔ / — / ✔ | lib/email |
| `SHOPIFY_APP_API_KEY`, `SHOPIFY_APP_API_SECRET` | Shopify public app (OAuth, webhook HMAC) | O | ✔ | integrations |
| `SMS_WEBHOOK_SHARED_SECRET` | authenticates SMS webhooks (boot warning if unset) | O* | — | webhooks |
| `STRIPE_*` (secret, webhook secret, prices, USD, period, grace) | card billing | O | — | billing |
| `SSL_WIRELESS_*` | SMS (Bangladesh) | O | — | lib/sms |
| `TWILIO_*` | SMS/voice fallback | O | — | webhooks/twilio |
| `PAY_BKASH_*`, `PAY_NAGAD_*`, `PAY_BANK_INFO`, `PAY_MANUAL_DAILY_CAP` | manual payment instructions | O | — | billing |
| `SENTRY_DSN`, `SENTRY_RELEASE` | error reporting | O | — | telemetry |
| `PATHAO_BASE_URL`, `STEADFAST_BASE_URL`, `REDX_BASE_URL`, `COURIER_MOCK` | courier endpoints / mock | O | — | couriers |
| `TRACKING_SYNC_INTERVAL_MIN`, `TRACKING_SYNC_BATCH` | tracking sync worker | O | — | workers |
| `CUSTOMER_DATA_RETENTION_DAYS`, `…_INTERVAL_MIN` | retention sweep | O | — | workers |
| `LANDING_ROOT_DOMAIN`, `LANDING_PUBLIC_URL_PATTERN`, `LANDING_SLUG_HOLD_DAYS`, `LANDING_MAX_PAGES_PER_MERCHANT` | landing pages (domain set in DOMAIN phase) | O | — | lib/landing |
| Feature flags: `FRAUD_NETWORK_*`, `ADDRESS_*`, `INTENT_SCORING_ENABLED`, `DELIVERY_RELIABILITY_*`, `LANE_INTELLIGENCE_*`, `EXTERNAL_DELIVERY_*`, `BDCOURIER_*`, `NETWORK_EVIDENCE_SURFACE_ENABLED` | staged features; defaults in env.ts | O | — | various |
| `SHOPIFY_FETCH_TIMEOUT_MS`, `SHOPIFY_RETRY_*`, `WOO_*`, `SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS`, `BRANDING_OVERRIDES` | integration tuning (read directly) | O | — | integrations |

## Web (`/etc/confirmx/web.env`)

| Variable | Purpose | Req | Build | Railway |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | | R | | ✔ |
| `PORT` | listen port (VPS 3001 on 127.0.0.1) | R | | (Railway `$PORT`) |
| `NEXTAUTH_URL` | public dashboard URL | R | | ✔ |
| `NEXTAUTH_SECRET` | session encryption — **carry over exactly** or everyone is signed out | R | | ✔ |
| `NEXT_PUBLIC_API_URL` | API base for the browser | R | B | ✔ |
| `NEXT_PUBLIC_WEB_URL` | canonical dashboard URL | O | B | — |
| `PUBLIC_API_URL` | server-side API base fallback | O | | — |
| `NEXT_PUBLIC_SUPPORT_WHATSAPP`, `NEXT_PUBLIC_SUPPORT_URL` | support footer | O | B | — |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_RELEASE` | browser error reporting | O | B | — |
| `NEXT_PUBLIC_SHOPIFY_APP_API_KEY` | embedded Shopify surface | O | B | — |
| `NEXT_PUBLIC_INCIDENT_BANNER_LEVEL`, `…_TEXT` | incident banner | O | B | — |
| `NEXT_PUBLIC_EXTERNAL_DELIVERY_UI_ENABLED`, `NEXT_PUBLIC_NETWORK_EVIDENCE_UI_ENABLED` | UI flags | O | B | — |
| `NEXT_PUBLIC_LANDING_PREVIEW_URL` | landing editor preview host; also added to CSP `frame-src` | O | B | — |
| `CSP_ENFORCED` | `true` = enforce CSP instead of report-only | O | B | — |

## Sites (`/etc/confirmx/sites.env`) — landing-page renderer

| Variable | Purpose | Req | Build |
| --- | --- | --- | --- |
| `NODE_ENV`, `PORT` | runtime; 3002 on 127.0.0.1 | R | |
| `LANDING_API_URL` | API base (VPS: `http://127.0.0.1:4000`) | R | B |
| `LANDING_ASSET_ORIGIN` | public origin serving `/api/landing-assets` (CSP img-src) | R | B |
| `LANDING_ROOT_DOMAIN` | landing parent domain (DOMAIN phase) | O | B |
| `LANDING_PREVIEW_HOST`, `LANDING_EDITOR_ORIGINS` | editor preview host + allowed editor origins | O | B |
| `LANDING_PROXY_SECRET` | same value as the API's; sent with checkout requests so the API trusts the forwarded customer IP | P | |
| `LANDING_ALLOW_INDEXING` | `true` lets search engines index pages | O | |
| `LANDING_ANALYTICS` | `off` disables merchant Meta Pixels platform-wide | O | B |

## Where real values live

- VPS: `/etc/confirmx/{api,web,sites}.env` — owner `root:confirmx`, mode `0640`.
- Offline backup: `E:\confirm-x\backups\confirmx\secrets\` — **encrypted** archive only
  (see `README.txt` there). Export from Railway: service → Variables → *Raw Editor*.
