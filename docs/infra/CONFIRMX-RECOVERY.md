# ConfirmX — rebuild on a brand-new VPS

Use this when the server is gone and only the local backup
(`E:\confirm-x\backups\`) is left. Commands are for Ubuntu 24.04 LTS as root
unless shown otherwise. If the same VPS also runs Asterisk, restore the PBX
first ([PBX-RECOVERY.md](PBX-RECOVERY.md)) and never run commands here that
reset the firewall.

Backup layout:
```
backups/confirmx/source/     confirmx-<stamp>-<sha>.bundle, confirmx-src-<stamp>-<sha>.tar.gz
backups/confirmx/database/   confirmx-mongo-<stamp>.archive.gz   (mongodump --archive --gzip)
backups/confirmx/config/     .env.production.example, deploy/, ops/backup/
backups/confirmx/secrets/    api.env / web.env / sites.env — ENCRYPTED
backups/manifests/           backup-manifest.json (commit, versions, SHA-256 of every file)
```
First verify the backup on your PC: `node ops/backup/verify-local-backup.mjs` → `restore test passed`.

## 1. Ubuntu setup
```bash
apt update && apt -y full-upgrade
timedatectl set-timezone Asia/Dhaka
adduser --system --group --home /opt/confirmx confirmx
apt -y install git curl ca-certificates build-essential ufw fail2ban
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp   # ADD rules only; never `ufw reset` on the PBX host
ufw status                                                   # if inactive and the PBX needs 5060/RTP, allow those BEFORE `ufw enable`
```

## 2. Node version
Node **22 LTS** (repo requires ≥ 20; CI and development use 22; the manifest records the exact version).
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs
node -v && npm -v
```

## 3. Package manager
The monorepo uses **npm workspaces** with `package-lock.json` — **not pnpm**.
Always install with `npm ci` from the repo root; never `npm install` inside an app folder.

## 4. MongoDB
Default: keep using **MongoDB Atlas** (`MONGODB_URI` in `api.env`); add the new
server's public IP under Atlas → Network Access. To self-host instead (optional):
```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-7.gpg
echo "deb [signed-by=/usr/share/keyrings/mongodb-7.gpg] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" > /etc/apt/sources.list.d/mongodb-7.list
apt update && apt -y install mongodb-org mongodb-database-tools
systemctl enable --now mongod        # binds 127.0.0.1:27017 by default
```
Either way install the tools for restores: `apt -y install mongodb-database-tools`.

## 5. Redis
Required in production (BullMQ).
```bash
apt -y install redis-server
sed -i 's/^#\? *appendonly .*/appendonly yes/; s/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
systemctl enable --now redis-server && redis-cli ping     # PONG
```

## 6. Clone repository
From GitHub, or — if GitHub is unavailable — from the backup bundle:
```bash
sudo -u confirmx git clone https://github.com/rezainiet/eco-logistics-ai.git /opt/confirmx/src
# offline alternative (copy the .bundle to the server first):
sudo -u confirmx git clone /root/confirmx-<stamp>-<sha>.bundle /opt/confirmx/src
cd /opt/confirmx/src && sudo -u confirmx git checkout <commit from backup-manifest.json>
```

## 7. Install dependencies
```bash
cd /opt/confirmx/src && sudo -u confirmx npm ci --no-audit --no-fund
```

## 8. Restore environment
Decrypt `backups/confirmx/secrets/*` on your PC, copy to the server:
```bash
install -d -m 0750 -o root -g confirmx /etc/confirmx
install -m 0640 -o root -g confirmx api.env web.env sites.env /etc/confirmx/
```
Check against `/.env.production.example`. On the VPS: `API_PORT=4000`,
`TRUSTED_PROXIES=loopback`, `REDIS_URL=redis://127.0.0.1:6379`,
`LANDING_API_URL=http://127.0.0.1:4000`. **Keep `COURIER_ENC_KEY`, `JWT_SECRET`,
`NEXTAUTH_SECRET`, `ADMIN_SECRET` identical to the backup.**

## 9–12. Build packages, API, web, sites
`deploy/vps/deploy.sh` does all of this into `/opt/confirmx/releases/…` and
points `/opt/confirmx/app` at it. Manually it is:
```bash
cd /opt/confirmx/src
npm --workspace packages/db run build
npm --workspace packages/types run build
npm --workspace packages/branding run build --if-present
npm --workspace packages/landing run build
npm --workspace apps/api run build:strict                                   # 10. API
( set -a; . /etc/confirmx/web.env;   set +a; npm --workspace apps/web run build )    # 11. web (NEXT_PUBLIC_* baked in)
( set -a; . /etc/confirmx/sites.env; set +a; npm --workspace apps/sites run build )  # 12. sites
ln -sfn /opt/confirmx/src /opt/confirmx/app
```

## 13. Configure systemd
```bash
cp /opt/confirmx/app/deploy/vps/systemd/confirmx-*.service /etc/systemd/system/
systemctl daemon-reload
```
Units run as `confirmx`, bind 127.0.0.1, and are CPU/memory-capped so they cannot starve Asterisk.

## 14. Configure Nginx
```bash
apt -y install nginx certbot python3-certbot-nginx
cp /opt/confirmx/app/deploy/vps/nginx/confirmx.conf /etc/nginx/sites-available/
cp /opt/confirmx/app/deploy/vps/nginx/snippets/*.conf /etc/nginx/snippets/
ln -s /etc/nginx/sites-available/confirmx.conf /etc/nginx/sites-enabled/
# Before certificates exist, comment out the two 443 server blocks, then:
nginx -t && systemctl reload nginx
certbot --nginx -d confirmx.ai -d www.confirmx.ai -d api.confirmx.ai    # needs DNS pointing here
# re-enable the 443 blocks (certbot may have edited them) → nginx -t && systemctl reload nginx
```

## 15. Restore database
Only when rebuilding onto an **empty** database (never restore over a live one without a fresh dump first):
```bash
mongorestore --uri="$MONGODB_URI" --archive=/root/confirmx-mongo-<stamp>.archive.gz --gzip --dryRun   # check first
mongorestore --uri="$MONGODB_URI" --archive=/root/confirmx-mongo-<stamp>.archive.gz --gzip
```
Making the dump (operator, from any machine with network access to Atlas):
```bash
mongodump --uri="<production URI, read-only user>" --archive=confirmx-mongo-$(date -u +%Y%m%dT%H%M%SZ).archive.gz --gzip
```
Then run indexes once: `curl -X POST -H "x-admin-secret: $ADMIN_SECRET" http://127.0.0.1:4000/admin/sync-indexes`.

## 16. Restore assets
Landing-page images live **inside MongoDB** (`landingassets` collection) — step 15
restores them. There are no filesystem uploads. Verify: open a published page
and check its images load from `https://api.confirmx.ai/api/landing-assets/<id>`.

## 17. Start services
```bash
systemctl enable --now confirmx-api confirmx-web confirmx-sites
journalctl -u confirmx-api -n 50 --no-pager     # "[db] connected", workers registered, listening on 4000
```

## 18. Health checks
```bash
curl -s http://127.0.0.1:4000/health      # {"ok":true}
curl -s http://127.0.0.1:4000/ready       # mongo + redis ok
curl -s http://127.0.0.1:3001/api/health  # {"ok":true,"service":"web"}
curl -s http://127.0.0.1:3002/readyz      # {"ok":true,"service":"sites","checks":{"api":true}}
```

## 19. Smoke tests
```bash
bash /opt/confirmx/app/deploy/vps/smoke-test.sh
WEB=https://confirmx.ai API=https://api.confirmx.ai bash /opt/confirmx/app/deploy/vps/smoke-test.sh
```
Then log in, open Orders, open a landing page in the editor, and confirm
`asterisk -rx "pjsip show registrations"` is unchanged.

## 20. Rollback
- Bad release: as root: `bash /opt/confirmx/app/deploy/vps/deploy.sh --rollback` (add `--dry-run` to preview).
- Bad server: stop ConfirmX (`systemctl stop confirmx-api confirmx-web confirmx-sites`) — Asterisk is unaffected — and point DNS back to the previous host (records in INFRA-AUDIT.md).
- Bad data restore: restore the dump taken immediately before (step 15 rule).
