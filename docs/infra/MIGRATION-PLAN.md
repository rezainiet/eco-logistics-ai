# Railway → VPS migration plan

Status: **prepared, not executed.** No DNS has been changed and Railway has not
been touched. Audit facts: [INFRA-AUDIT.md](INFRA-AUDIT.md) · variables:
[ENVIRONMENT.md](ENVIRONMENT.md) · rebuild runbook: [CONFIRMX-RECOVERY.md](CONFIRMX-RECOVERY.md).

```
CURRENT (2026-09-25)                       TARGET
Internet                                   Internet
  → Hostinger DNS                            → Hostinger DNS
  → Railway edge                             → VPS (shared with Asterisk)
      frontend-confirmx  (no active deploy)      Nginx :80/:443
      backend-intellivery (no active deploy)       → web   127.0.0.1:3001
  → MongoDB Atlas, Upstash Redis                   → api   127.0.0.1:4000
                                                   → sites 127.0.0.1:3002 (DOMAIN phase)
                                                 → MongoDB Atlas (unchanged)
                                                 → Redis 127.0.0.1:6379 (recommended) or Upstash
```

**Important finding:** production on Railway is already offline (no active
deployments since May 2026). The cutover therefore cannot make availability
worse, but it also means **Railway is not a ready rollback target**. Step 0
decides how rollback works.

## Guiding rules

1. The Asterisk/PBX installation is never modified. ConfirmX only adds Nginx,
   Node services on loopback ports and (optionally) Redis on loopback. Every
   step starts with `deploy/vps/preflight.sh` (read-only).
2. Nothing irreversible before a verified backup (`ops/backup/*`, Phase D).
3. DNS changes only in Step 6, only with explicit go-ahead.
4. Railway is not deleted until the rollback window closes (Step 8).

## Decisions to make first

| Decision | Recommendation | Why |
| --- | --- | --- |
| MongoDB | **Keep Atlas** for the cutover | Zero data migration; add the VPS IP to Atlas Network Access. Self-hosting can be a later, separate project. |
| Redis | **Local `redis-server` on the VPS** (127.0.0.1, `appendonly yes`) | BullMQ issues many commands per second (Upstash bills/limits per command) and latency drops to ~0. Queue state after months of downtime has no value; repeatable jobs re-register at API boot. |
| Dashboard hostname | Keep **`confirmx.ai`** (what Railway serves) *or* create `app.confirmx.ai` (what the docs/Shopify listing links use) | `CORS_ORIGIN`, `PUBLIC_WEB_URL`, `NEXTAUTH_URL` must match the choice. |
| Rollback target | See Step 0 | Railway is down today. |

## Step 0 — Rollback readiness (before touching anything)

Option A (recommended): **fix one Railway deploy** so Railway is a real
fallback — inspect the failed build logs (`railway logs --deployment <id>`),
redeploy the current `main`, confirm `/health`. Keeps the old path warm.

Option B: accept that the rollback is "VPS previous release"
(`deploy.sh --rollback`) plus DNS back to the Railway CNAME once it is fixed.

## Step 1 — Backup everything (Phase D)

- `node ops/backup/local-backup.mjs` → git bundle (all branches) + source tarball + templates + recovery docs, SHA-256 manifest.
- `mongodump` of Atlas → `E:\confirm-x\backups\confirmx\database\` (operator runs it; see CONFIRMX-RECOVERY §15).
- `sudo bash ops/backup/pbx-backup.sh` on the PBX → copy to `E:\confirm-x\backups\pbx\`.
- Export Railway variables (Raw Editor) → encrypt → `backups\confirmx\secrets\`.
- `node ops/backup/verify-local-backup.mjs` must end with `restore test passed`.

## Step 2 — Deploy ConfirmX to the VPS (no public traffic yet)

1. `sudo bash deploy/vps/preflight.sh > preflight.txt` — confirm 80/443/3001/3002/4000/6379 are free, Asterisk healthy, enough RAM (ConfirmX needs ~2.5 GB with its caps).
2. Install Node 22, Nginx, certbot, `redis-server` (bind 127.0.0.1). **Do not** run `ufw reset`/`iptables -F`; only *add* allow rules for 80/443.
3. Create user `confirmx`, `/opt/confirmx`, `/etc/confirmx/{api,web,sites}.env` (values from the encrypted backup; `TRUSTED_PROXIES=loopback`, `REDIS_URL=redis://127.0.0.1:6379`, `API_PORT=4000`, `LANDING_API_URL=http://127.0.0.1:4000`).
4. `bash deploy/vps/deploy.sh main` (build in a new release dir, switch symlink).
5. Install the three systemd units from `deploy/vps/systemd/`, `systemctl enable --now`.
6. Atlas: add the VPS public IP to Network Access.

## Step 3 — Internal health checks

```bash
bash /opt/confirmx/app/deploy/vps/smoke-test.sh      # loopback: api /health /ready, web, sites
systemctl status confirmx-api confirmx-web confirmx-sites
asterisk -rx "core show uptime"; asterisk -rx "pjsip show registrations"   # PBX unaffected
```

## Step 4 — Test with temporary hostnames

- DNS (new records only): `app-vps.confirmx.ai`, `api-vps.confirmx.ai` → VPS IP.
- Nginx: add them to the `server_name` lines; `certbot --nginx -d app-vps.confirmx.ai -d api-vps.confirmx.ai`.
- Build web with `NEXT_PUBLIC_API_URL=https://api-vps.confirmx.ai` and set `CORS_ORIGIN=https://app-vps.confirmx.ai` for the test period (revert before cutover).
- `WEB=https://app-vps.confirmx.ai API=https://api-vps.confirmx.ai bash smoke-test.sh`

## Step 5 — Functional verification (on the temporary hostnames)

- [ ] Sign up / log in / refresh / log out; password reset email arrives (Resend)
- [ ] Orders list, fraud review, integrations page load; Shopify OAuth **not** re-run (callback is bound to api.confirmx.ai)
- [ ] Landing pages: create, edit (click-to-edit), Bangla + English, device preview, save, publish
- [ ] Template rendering (5 templates), uploads (image ≤700 KB) and asset URLs
- [ ] Analytics: Pixel settings save; (DOMAIN phase) Meta events on a published page
- [ ] WhatsApp / phone links on a published page
- [ ] Admin: template management, observability page
- [ ] `/ready` shows mongo + redis ok; BullMQ repeatable jobs registered (api logs at boot)
- [ ] PBX: calls in/out still work; `pjsip show registrations` unchanged

## Step 6 — Production DNS switch (only on explicit instruction)

1. 24 h before: lower TTL of `confirmx.ai`, `www`, `api.confirmx.ai` to 300 s (Hostinger).
2. Rebuild web with production URLs; set `CORS_ORIGIN`/`PUBLIC_*`/`NEXTAUTH_URL` to production values.
3. Change records: `confirmx.ai` A → VPS IP; `api.confirmx.ai` CNAME(Railway) → A VPS IP; `www` stays CNAME → apex.
4. As soon as DNS resolves to the VPS: `certbot --nginx -d confirmx.ai -d www.confirmx.ai -d api.confirmx.ai`.
5. `WEB=https://confirmx.ai API=https://api.confirmx.ai bash smoke-test.sh`.
6. Shopify: send a test webhook from the Partner dashboard; confirm 200 in api logs.

## Step 7 — Rollback window (keep Railway ≥ 14 days)

Triggers: smoke test fails, error rate spikes, auth broken, PBX degraded.

| Situation | Action | Time |
| --- | --- | --- |
| Bad release on the VPS | `bash deploy/vps/deploy.sh --rollback` | < 1 min |
| VPS broken, Railway repaired (Step 0 A) | Hostinger: `api.confirmx.ai` CNAME → `ta18xxk6.up.railway.app`; `confirmx.ai` A → `69.46.46.2` (values recorded in INFRA-AUDIT) | TTL (5 min) |
| PBX affected by ConfirmX | `systemctl stop confirmx-api confirmx-web confirmx-sites` (Nginx can stay); verify `pjsip show registrations` | seconds |

Data: both platforms use the same Atlas database, so a DNS rollback needs no
data move. Redis is only queues/cache.

## Step 8 — Decommission Railway (after the window, explicitly approved)

Remove custom domains from the Railway services, then delete the project
(`function-bun` is unrelated demo code and can go first). Revoke any Railway
deploy tokens.

## What can be automated vs manual

| Automated (in repo) | Manual (operator) |
| --- | --- |
| `preflight.sh` (read-only audit) | Buying/choosing the VPS size, SSH hardening |
| `deploy.sh` build/switch/rollback + smoke test | Filling `/etc/confirmx/*.env` from the encrypted backup |
| systemd units, Nginx config, TLS snippet | DNS changes in Hostinger, Atlas IP allow-list |
| `smoke-test.sh` | certbot runs (need DNS pointing at the VPS) |
| Backups + restore test (`ops/backup/*`) | Running `mongodump` against Atlas, running `pbx-backup.sh` on the PBX |
