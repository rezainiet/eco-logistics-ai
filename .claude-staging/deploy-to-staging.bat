@echo off
REM =======================================================================
REM  deploy-to-staging.bat
REM
REM  Carves a clean `claude/staging-deploy` branch off `main` containing
REM  ONLY the four files I edited this session:
REM    1. apps/api/src/server/routers/integrations.ts
REM       (humanized "Connection error — cannot reach <host>" + sets
REM        lastSyncStatus="error" so the dashboard pill flips on test
REM        failure; getHealth + replayWebhook procedures recovered from
REM        the accidentally-emitted .js sibling after a Windows-mount
REM        truncation chewed the last ~85 lines of the working tree)
REM    2. apps/web/src/components/integrations/IntegrationHealthCard.tsx
REM       (red "Connection error — your store appears unreachable"
REM        inline alert when status === "error" and lastError matches
REM        ECONNREFUSED / ENOTFOUND / timeout / "Connection error")
REM    3. apps/api/tsconfig.build.json
REM       (paths repointed at packages/<name>/dist/ so `tsc -p
REM        tsconfig.build.json` resolves cleanly — the previous values
REM        pointed at non-existent packages/<name>/src/index.d.ts files
REM        and triggered a TSC "Debug Failure" on every build)
REM    4. apps/web/e2e/shopify-import-progress.spec.ts  (new spec)
REM       (Playwright test that asserts the import modal NEVER shows
REM        imported=0 AND failed=0 simultaneously when totalReceived>0)
REM
REM  Your other 470 modified/untracked files are stashed first and
REM  restored at the end with `git stash pop`. Nothing is lost.
REM
REM  Run from the repo root:
REM      .\.claude-staging\deploy-to-staging.bat
REM =======================================================================

setlocal enabledelayedexpansion

REM Anchor at the repo root regardless of where the user double-clicked.
cd /d "%~dp0\.."

if not exist ".git" (
  echo [error] Not in a git repo. Expected to find .git at: %CD%
  exit /b 1
)

REM ----------------------------------------------------------------------
REM  Step 1: Self-heal a stale .git\index.lock left by a crashed prior
REM          git process. Same logic as your existing _commit-and-push.bat.
REM ----------------------------------------------------------------------
if exist ".git\index.lock" (
  tasklist /FI "IMAGENAME eq git.exe" 2>NUL | find /I "git.exe" >NUL
  if errorlevel 1 (
    echo [info] Removing stale .git\index.lock
    del /Q ".git\index.lock"
  ) else (
    echo [error] Active git.exe holds .git\index.lock. Wait for it to finish, then re-run.
    exit /b 1
  )
)

REM ----------------------------------------------------------------------
REM  Step 2: Confirm we have a clean route through. Refuse to run if a
REM          rebase / merge / cherry-pick is mid-flight — those leave
REM          state in .git/ that would collide with our checkout.
REM ----------------------------------------------------------------------
for %%f in ("MERGE_HEAD" "CHERRY_PICK_HEAD" "REBASE_HEAD" "rebase-merge" "rebase-apply") do (
  if exist ".git\%%~f" (
    echo [error] In-progress git operation detected: .git\%%~f
    echo         Resolve it manually before running this script.
    exit /b 1
  )
)

REM ----------------------------------------------------------------------
REM  Step 3: Stash everything (modified + untracked) so we can land on a
REM          clean main. The 470 files become a single stash entry you
REM          can pop later. `--include-untracked` covers fresh files;
REM          `-m` tags it for findability in `git stash list`.
REM ----------------------------------------------------------------------
echo.
echo [step 3/8] Stashing all current changes (470+ files)...
git stash push --include-untracked -m "claude-staging-deploy-WIP-%DATE:/=-%-%TIME::=-%"
if errorlevel 1 (
  echo [error] git stash failed. Aborting.
  exit /b 1
)

REM ----------------------------------------------------------------------
REM  Step 4: Branch off main. If `claude/staging-deploy` already exists,
REM          delete it first (this is intended to be a single-shot deploy
REM          ref, not a long-lived branch). The `-D` is force-delete.
REM ----------------------------------------------------------------------
echo.
echo [step 4/8] Checking out main and creating claude/staging-deploy...
git checkout main
if errorlevel 1 (
  echo [error] Could not check out main. Restoring your stash:
  git stash pop
  exit /b 1
)
git branch -D claude/staging-deploy 2>NUL
git checkout -b claude/staging-deploy
if errorlevel 1 (
  echo [error] Could not create claude/staging-deploy. Restoring your stash:
  git stash pop
  exit /b 1
)

REM ----------------------------------------------------------------------
REM  Step 5: Apply the four backed-up files from .claude-staging\ on top
REM          of clean main. These were captured before the stash so they
REM          carry the exact post-recovery contents (incl. the
REM          getHealth/replayWebhook restoration in integrations.ts).
REM ----------------------------------------------------------------------
echo.
echo [step 5/8] Restoring the four staging-deploy files...
copy /Y ".claude-staging\integrations.ts"               "apps\api\src\server\routers\integrations.ts" >NUL
copy /Y ".claude-staging\IntegrationHealthCard.tsx"     "apps\web\src\components\integrations\IntegrationHealthCard.tsx" >NUL
copy /Y ".claude-staging\tsconfig.build.json"           "apps\api\tsconfig.build.json" >NUL
copy /Y ".claude-staging\shopify-import-progress.spec.ts" "apps\web\e2e\shopify-import-progress.spec.ts" >NUL

REM ----------------------------------------------------------------------
REM  Step 6: Stage + commit. Force-add IntegrationHealthCard.tsx in case
REM          a parent directory's .gitignore would otherwise hide it.
REM ----------------------------------------------------------------------
echo.
echo [step 6/8] Staging + committing...
git add -f "apps/api/src/server/routers/integrations.ts"
git add -f "apps/web/src/components/integrations/IntegrationHealthCard.tsx"
git add -f "apps/api/tsconfig.build.json"
git add -f "apps/web/e2e/shopify-import-progress.spec.ts"

git commit -F ".claude-staging\commit-message.txt"
if errorlevel 1 (
  echo [error] git commit failed. Likely empty commit ^(files identical to main^)
  echo         or hooks blocked it. Check the output above.
  echo         Your stash is still intact; recover via:
  echo             git checkout main ^&^& git stash pop
  exit /b 1
)

REM ----------------------------------------------------------------------
REM  Step 7: Push. -u tracks the branch upstream. Uses your existing
REM          Git Credential Manager — no token paste required.
REM ----------------------------------------------------------------------
echo.
echo [step 7/8] Pushing claude/staging-deploy to origin...
git push -u origin claude/staging-deploy
if errorlevel 1 (
  echo [error] Push failed. Branch is committed locally; you can retry with:
  echo             git push -u origin claude/staging-deploy
  exit /b 1
)

REM ----------------------------------------------------------------------
REM  Step 8: Done. Tell the user how to recover their stashed work.
REM ----------------------------------------------------------------------
echo.
echo =======================================================================
echo  SUCCESS
echo =======================================================================
echo.
echo  Branch  : claude/staging-deploy
echo  Pushed  : origin/claude/staging-deploy
echo  Commit  : 4 files - integrations.ts, IntegrationHealthCard.tsx,
echo            tsconfig.build.json, shopify-import-progress.spec.ts
echo.
echo  To restore your other 470+ uncommitted changes:
echo      git checkout main
echo      git stash pop
echo.
echo  Railway will now pick up claude/staging-deploy on its next sync.
echo  Tell Claude "pushed" in chat and it'll start the Railway deploy.
echo =======================================================================
echo.
endlocal
