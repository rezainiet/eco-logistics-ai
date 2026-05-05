# Railway staging deploy — `claude/staging-deploy`

Step-by-step guide to deploy `apps/api` + `apps/web` + WordPress to Railway,
using free-tier Atlas (Mongo) and Upstash (Redis) for the data layer.

**Branch:** `claude/staging-deploy` (already pushed to GitHub at commit `93544ab`)
**GitHub repo:** `rezainiet/eco-logistics-ai`
**Target Railway project:** new — call it `ecommerce-logistics-staging`

---

## 0. Generate your secrets (1 minute)

These you'll paste into Railway in step 4. Run in PowerShell:

```powershell
# JWT_SECRET — 32 random chars, min 16 required
[Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ }))

# ADMIN_SECRET — 32 random chars, min 24 required in prod
[Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ }))

# COURIER_ENC_KEY — base64-encoded EXACTLY 32 bytes
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ }))
```

Save these three strings somewhere. Don't reuse the local `.env` values for staging
— different env, different secrets.

---

## 1. Provision Atlas free Mongo (3 minutes)

1. Go to <https://cloud.mongodb.com/> → sign in or sign up.
2. **Create a deployment** → pick **M0 Free**, region close to your Railway region (US-East is the safest default).
3. **Database Access** → Add User → username `staging`, autogenerate password, copy it.
4. **Network Access** → Add IP → click **Allow Access from Anywhere** (`0.0.0.0/0`). Acceptable for staging M0; tighten for prod.
5. **Database Deployments** → Connect → **Drivers** → copy the URI:
   ```
   mongodb+srv://staging:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Append database name: `&authSource=admin&appName=staging` and add `/ecom_staging` before the `?`:
   ```
   mongodb+srv://staging:<password>@cluster0.xxxxx.mongodb.net/ecom_staging?retryWrites=true&w=majority&appName=staging
   ```

**Save as:** `MONGODB_URI`

---

## 2. Provision Upstash free Redis (2 minutes)

1. Go to <https://console.upstash.com/> → sign in / sign up (GitHub login is fastest).
2. **Create database** → name `ecom-staging`, region close to your Railway region, **Eviction: enable** (for BullMQ, eviction policy `noeviction` is required — Upstash defaults are fine).
3. Open the database → scroll to **Connect to your database** → choose **Node.js** → copy the `redis://...` URL (NOT the REST URL).

**Save as:** `REDIS_URL`

---

## 3. Create the Railway project (2 minutes)

1. <https://railway.com/dashboard> → click **+ New** (top right) → **Empty Project**.
2. Project page opens. Top-left, click the project name → **Settings** → rename to `ecommerce-logistics-staging`.
3. You'll add 3 services in step 4.

---

## 4. Add the three services

### 4a. API service

1. On the project canvas, click **+ Add** → **GitHub Repo** → select `rezainiet/eco-logistics-ai`.
2. Service name: `api`
3. Click the service → **Settings** tab:
   - **Source → Branch:** `claude/staging-deploy`
   - **Source → Root directory:** `apps/api`
   - **Build → Builder:** Nixpacks (default is fine)
   - **Build → Build command:** `cd ../.. && npm ci && npm --workspace packages/db run build --if-present && npm --workspace packages/types run build --if-present && npm --workspace apps/api run build`
   - **Deploy → Start command:** `node dist/index.js`
   - **Networking → Generate domain** (gives you `api-xxxx.up.railway.app`)
4. **Variables** tab → click **Raw editor** and paste:
   ```env
   NODE_ENV=production
   API_PORT=4000
   MONGODB_URI=<from step 1>
   REDIS_URL=<from step 2>
   JWT_SECRET=<from step 0>
   ADMIN_SECRET=<from step 0>
   COURIER_ENC_KEY=<from step 0>
   CORS_ORIGIN=<the web service domain — see step 4b below>
   PUBLIC_WEB_URL=<the web service domain>
   ```
   (Leave Stripe/Twilio/SMS vars blank for now — staging doesn't need real billing.)

### 4b. Web service

1. **+ Add** → **GitHub Repo** → same repo → service name `web`
2. **Settings:**
   - **Branch:** `claude/staging-deploy`
   - **Root directory:** `apps/web`
   - **Build command:** `cd ../.. && npm ci && npm --workspace packages/db run build --if-present && npm --workspace packages/types run build --if-present && npm --workspace apps/web run build`
   - **Start command:** `npm --workspace apps/web run start -- -p $PORT`
   - **Networking → Generate domain** (gives you `web-xxxx.up.railway.app`)
3. **Variables:**
   ```env
   NODE_ENV=production
   NEXT_PUBLIC_API_URL=<api service domain from step 4a>
   NEXTAUTH_URL=<this web service's own domain>
   NEXTAUTH_SECRET=<generate another random 32-char string>
   ```
4. **Go back to step 4a's CORS_ORIGIN and PUBLIC_WEB_URL** and set them to the web domain you just created. Both services will redeploy automatically.

### 4c. WordPress service (optional — skip if using Cloudflare Tunnel for local WP)

1. **+ Add** → **Templates** → search `WordPress` → pick the official one (it provisions WP + MySQL together).
2. After it deploys, **Networking → Generate domain** to get `wp-xxxx.up.railway.app`.
3. Open the domain in a browser → run the WP installer → install WooCommerce plugin → generate REST API keys (`WooCommerce → Settings → Advanced → REST API → Add key`, Read/Write).
4. Save the `ck_...` and `cs_...` plus the URL — that's what you paste into the dashboard's WooCommerce connect dialog.

**Cheaper alternative:** skip 4c entirely. Run `cloudflared tunnel --url http://localhost:8881` on your Windows machine — it gives a free public HTTPS URL to your already-running local WP. Use that URL in the WooCommerce connect dialog. No Railway WP service needed, no MySQL plugin, no $5/mo.

---

## 5. First deploy + smoke test

1. Both `api` and `web` deploys auto-trigger on save. Watch the **Deployments** tab logs.
2. **api expected log:** `[api] listening on :4000` followed by Mongo + Redis connection lines.
3. **web expected log:** `▲ Next.js 14.x.x ready on 0.0.0.0:$PORT`
4. Visit the web domain → sign up → connect Shopify or WooCommerce → click Import.
5. The dashboard should now show:
   - Healthy green pill on success
   - Red **Connection error — your store appears unreachable...** on transient failures (the bug fix from this session)
   - Real `imported` / `failed` counts after a Shopify import (no silent zeros)

---

## 6. When something breaks (it will)

The most common Railway-deploy failures and fixes:

| Symptom | Fix |
|---|---|
| `Cannot find module @ecom/db` at runtime | The build command didn't compile workspace packages first. Verify the build command in step 4a/4b matches exactly — the `--workspace packages/db run build` part is essential. |
| `MONGODB_URI is required` on startup | The variable wasn't set or has a typo. Check Variables tab — the URI must start with `mongodb+srv://` or `mongodb://`. |
| `REDIS_URL is required when NODE_ENV=production` | Same — check the Upstash URL was copied correctly. Use the `redis://` protocol URL, NOT the `https://...rest.upstash.io` REST URL. |
| `COURIER_ENC_KEY must be a base64-encoded 32-byte key` | Regenerate via the PowerShell snippet in step 0 — must be EXACTLY 32 bytes after base64-decode. |
| `CORS error` in browser console when web tries to call api | `CORS_ORIGIN` on api isn't set to the web domain. Fix and redeploy. |
| api builds but crashes with `EADDRINUSE` | Railway sets `$PORT` automatically — verify you used `$PORT` (Railway substitutes) NOT a hardcoded port. The env var schema falls back to `API_PORT=4000` but Railway expects `$PORT`. |

When you hit any of these, paste the deploy log into chat and I'll diagnose.

---

## 7. Recover your in-progress work

When you're done with the staging deploy and want to keep working on your other 470 modified files:

```powershell
cd C:\devs\ecommerce-logistics
git checkout main
git stash pop
```

That puts your stashed work back in the working tree on `main`. The `claude/staging-deploy` branch is preserved on GitHub for redeploys.
