@echo off
REM ----------------------------------------------------------------------
REM  Commits the Shopify OAuth canonicalization-loop fix round.
REM
REM  Stages only the files with real semantic changes. The "modified"
REM  files in `git status` for orders.ts, merchant.ts, signup/page.tsx,
REM  etc. are CRLF/LF line-ending swaps with zero real diff (N ins / N
REM  del = same line count) — staging them would balloon the commit
REM  with noise. To fix the line-ending churn separately, run
REM  `git add --renormalize .` in its own commit later.
REM
REM  Run from the repo root with:  .\_commit-and-push.bat
REM ----------------------------------------------------------------------

cd /d "%~dp0"

REM Self-heal a stale .git\index.lock left by a crashed prior git process.
if exist ".git\index.lock" (
  tasklist /FI "IMAGENAME eq git.exe" 2>NUL | find /I "git.exe" >NUL
  if errorlevel 1 (
    echo Found stale .git\index.lock with no running git process — removing.
    del /Q ".git\index.lock"
  ) else (
    echo .git\index.lock exists AND git.exe is running. Aborting so we
    echo don't trample another git process. Wait for it to finish, then
    echo re-run this script.
    exit /b 1
  )
)

echo.
echo === Staging the OAuth fix files ===
git add ^
  "packages/db/src/models/integration.ts" ^
  "apps/api/src/server/routers/integrations.ts" ^
  "apps/api/src/server/webhooks/integrations.ts" ^
  "apps/web/src/app/dashboard/integrations/page.tsx" ^
  "apps/web/e2e/shopify-connect.spec.ts"

if errorlevel 1 (
  echo ERROR: git add failed.
  exit /b 1
)

echo.
echo === Files staged for this commit ===
git diff --cached --stat

echo.
echo === Committing ===
git commit -F _commit-message.txt
if errorlevel 1 (
  echo ERROR: git commit failed.
  exit /b 1
)

echo.
echo === Pushing ===
git push
if errorlevel 1 (
  echo ERROR: git push failed. Commit is local only.
  exit /b 1
)

echo.
echo === Done. ===
