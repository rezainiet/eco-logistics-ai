@echo off
REM =======================================================================
REM  push-fix-11.bat - register Shopify webhooks on access-token connect
REM
REM  Bug: integrations.connect for provider=shopify only registered
REM  webhook subscriptions inside the OAuth callback handler at
REM  apps/api/src/server/webhooks/integrations.ts:539. When a merchant
REM  pasted credentials directly via the "Advanced" section
REM  (apiKey + apiSecret + accessToken), status flipped to "connected"
REM  but registerShopifyWebhooks() was never called. The dashboard
REM  showed "Healthy / connected" yet Shopify never POSTed to
REM  /api/integrations/webhook/shopify/{id} because no subscription
REM  existed on the Shopify side. New orders silently never landed.
REM
REM  Detected during end-to-end audit: order #1003, #1004, and #1005
REM  all landed in Shopify but never appeared on staging dashboard.
REM  Railway HTTP logs filter @path:/api/integrations/webhook returned
REM  zero hits. Only the manual /admin/api/2024-04/webhooks.json POST
REM  done by registerShopifyWebhooks() ever creates the subscription
REM  on Shopify's side, and the connect flow skipped that call.
REM
REM  Fix: in routers/integrations.ts connect mutation, after the
REM  existing WC registration block, add a parallel block that fires
REM  when (provider==="shopify" && accessToken provided && status ===
REM  "connected"). Calls registerShopifyWebhooks with the same
REM  callbackUrl pattern + access token, persists webhookStatus, and
REM  writes an audit log of the topics registered. Mirrors the OAuth-
REM  callback's pattern. Existing OAuth flow unchanged.
REM
REM  Verification plan after deploy:
REM    1. Disconnect existing Shopify integration (its webhookStatus is
REM       still wrong)
REM    2. Reconnect via Advanced path (paste credentials)
REM    3. Watch deploy logs for [registerShopifyWebhooks] success per
REM       topic (orders/create, orders/updated, orders/cancelled, etc.)
REM    4. Create order #1006 in Shopify admin
REM    5. Within ~5s a single Order doc should land on staging
REM       /dashboard/orders
REM    6. Railway HTTP logs filter @path:/api/integrations/webhook/shopify
REM       should now show one POST per webhook topic firing
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-11.bat
REM =======================================================================

setlocal enabledelayedexpansion

cd /d "%~dp0\.."

if exist ".git\index.lock" (
  tasklist /FI "IMAGENAME eq git.exe" 2>NUL | find /I "git.exe" >NUL
  if errorlevel 1 del /Q ".git\index.lock"
)

for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%b
if not "%CURRENT_BRANCH%"=="claude/staging-deploy" (
  git checkout claude/staging-deploy
  if errorlevel 1 exit /b 1
)

git add -f "apps/api/src/server/routers/integrations.ts"

git commit -m "fix(integrations): register Shopify webhooks on access-token connect path" -m "integrations.connect for provider=shopify only registered webhook subscriptions inside the OAuth callback handler. When a merchant pasted credentials via the Advanced section (apiKey + apiSecret + accessToken), status flipped to connected but registerShopifyWebhooks() was never called. Dashboard showed Healthy yet Shopify never POSTed to /api/integrations/webhook/shopify/{id}; new orders silently never landed. Detected via end-to-end audit (#1003/#1004/#1005 created in Shopify but absent from staging dashboard, HTTP logs zero hits on /api/integrations/webhook). Mirror the WC inline-register pattern: after the WC block, add a parallel Shopify block firing when accessToken is provided. Persists webhookStatus + audits topics. OAuth flow unchanged."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-11 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 11" and it'll wait for the build, then
echo  disconnect + reconnect Shopify (so registration runs), and
echo  create one fresh order to verify webhook delivery + single doc.

endlocal
