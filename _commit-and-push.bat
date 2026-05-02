@echo off
REM ----------------------------------------------------------------------
REM  Commits the auth-form hardening round.
REM
REM  Only stages the 5 form files. The other "modified" files in
REM  `git status` are CRLF/LF line-ending swaps with zero real diff
REM  (3217 ins / 3217 del = same line count, every line "changed") —
REM  staging them would balloon the diff with noise. If you want to fix
REM  the line-ending churn separately, run `git add --renormalize .`
REM  in its own commit.
REM
REM  Run from the repo root with:  .\_commit-and-push.bat
REM ----------------------------------------------------------------------

cd /d "%~dp0"

REM --- Self-heal: a previous git crash leaves .git\index.lock around.
REM     If it exists AND no git.exe is currently running, remove it.
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
echo === Staging the 5 hardened auth forms ===
git add ^
  "apps/web/src/app/(auth)/login/page.tsx" ^
  "apps/web/src/app/(auth)/signup/page.tsx" ^
  "apps/web/src/app/reset-password/page.tsx" ^
  "apps/web/src/app/forgot-password/page.tsx" ^
  "apps/web/src/app/dashboard/settings/page.tsx"

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
