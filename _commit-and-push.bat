@echo off
REM One-shot commit + push for the dashboard / branding / auth-refresh batch.
REM Stages exactly the files Claude touched (so unrelated dirty work in your
REM tree is left alone), commits with the prepared message, pushes, then
REM deletes itself + the message file.

setlocal
cd /d "%~dp0"

if exist ".git\index.lock" (
  echo Removing stale .git\index.lock ...
  del /Q ".git\index.lock"
)
if exist ".git\test.tmp" (
  del /Q ".git\test.tmp"
)

echo Staging changed files ...
git add ^
  apps/api/src/server/routers/merchants.ts ^
  packages/db/src/models/merchant.ts ^
  apps/web/src/app/dashboard/layout.tsx ^
  apps/web/src/app/dashboard/page.tsx ^
  apps/web/src/app/dashboard/getting-started/page.tsx ^
  apps/web/src/app/dashboard/orders/page.tsx ^
  apps/web/src/app/dashboard/settings/page.tsx ^
  apps/web/src/app/providers.tsx ^
  apps/web/src/components/billing/subscription-banner.tsx ^
  apps/web/src/components/billing/dashboard-banners.tsx ^
  apps/web/src/components/branding/branding.ts ^
  apps/web/src/components/branding/branding-provider.tsx ^
  apps/web/src/components/branding/branding-section.tsx ^
  apps/web/src/components/auth/token-refresh-keeper.tsx ^
  apps/web/src/components/onboarding/dashboard-hero.tsx ^
  apps/web/src/components/onboarding/onboarding-checklist.tsx ^
  apps/web/src/components/shell/notifications-drawer.tsx ^
  apps/web/src/components/sidebar/Sidebar.tsx ^
  apps/web/src/lib/auth.ts ^
  apps/web/src/lib/auth-refresh.ts ^
  apps/web/.env.local.example
if errorlevel 1 (
  echo git add failed.
  pause
  exit /b 1
)

echo.
echo Committing ...
git commit -F _commit-message.txt
if errorlevel 1 (
  echo git commit failed.
  pause
  exit /b 1
)

echo.
echo Pushing ...
git push
if errorlevel 1 (
  echo git push failed.
  pause
  exit /b 1
)

echo.
echo Done. Cleaning up scaffolding ...
del /Q _commit-message.txt
del /Q "%~f0"
endlocal
