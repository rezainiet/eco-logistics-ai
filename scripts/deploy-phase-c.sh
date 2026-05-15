#!/usr/bin/env bash
# deploy-phase-c.sh — Phase C + polish + integrity-fix deployment
#
# Designed for Git Bash on Windows (works on WSL / Linux / macOS too).
# Run from the repo root: bash scripts/deploy-phase-c.sh
#
# What this script does (in order, fail-fast, never force-push):
#   1. Pre-flight: confirm repo root, current branch, clean staging
#   2. Clear known stale state: .git/index.lock + tsconfig.button-only.json
#   3. Run apps/api typecheck  (must exit 0)
#   4. Run apps/web typecheck  (must exit 0)
#   5. Run apps/web Next.js production build  (must exit 0)
#   6. Stage Commit 1: the H1+H3+M3 polish patches (3 files)
#   7. Stage Commit 2: Phase C frontend bridge + auto-provision +
#                      Button augmentation neutralization +
#                      @ecom/branding tsconfig integrity fix (12 files)
#   8. Show diffs + commit summaries; require explicit confirmation
#      before push (set CONFIRM=1 to skip the prompt)
#   9. Push to origin/main (regular push — never --force, never --force-with-lease)
#  10. Print post-deploy verification commands
#
# What this script will NEVER do:
#   - Force-push (no --force / --force-with-lease anywhere)
#   - git add . / -A / --all (every staged file is named explicitly)
#   - Auto-delete files outside the two known scratch paths
#   - Modify .gitignore, tsconfig, package.json, or any source file
#   - Touch shopify.app.toml or next.config.mjs (Phase D items)
#   - Skip a failed typecheck or build
#
# Rollback (if needed after push):
#   git revert <commit-2-sha>      # reverts Phase C cleanly
#   git revert <commit-1-sha>      # reverts polish patches
#   git push origin main           # rolled back
#
# Set this env var to skip the interactive confirmation:
#   CONFIRM=1 bash scripts/deploy-phase-c.sh

set -euo pipefail

# --- Display helpers ------------------------------------------------
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
BOLD="\033[1m"
RESET="\033[0m"

step()  { printf "\n${BOLD}${BLUE}==> %s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

# --- Pre-flight -----------------------------------------------------
step "Pre-flight checks"

# Must be in the repo root (look for the workspace package.json + monorepo markers)
[ -f "package.json" ] || fail "Run from repo root — package.json not found in $(pwd)"
[ -d "apps/api" ] && [ -d "apps/web" ] && [ -d "packages/branding" ] || \
  fail "Repo layout not as expected (apps/api, apps/web, packages/branding missing)"
ok "In repo root: $(pwd)"

# Must be on main (no Phase C work on a feature branch — direct deploy)
current_branch=$(git rev-parse --abbrev-ref HEAD)
[ "$current_branch" = "main" ] || \
  fail "Current branch is '$current_branch' — checkout 'main' first"
ok "On branch: main"

# Must be in sync with origin/main (no local commits ahead, no remote ahead)
git fetch origin main --quiet
local_head=$(git rev-parse main)
remote_head=$(git rev-parse origin/main)
[ "$local_head" = "$remote_head" ] || \
  fail "Local main ($local_head) differs from origin/main ($remote_head). Pull/rebase first."
ok "Local main == origin/main ($local_head)"

# --- Clear known stale state ---------------------------------------
step "Clearing known stale state"

if [ -f ".git/index.lock" ]; then
  # Only safe to remove if no git process is active. We don't try to
  # detect by ps (cross-shell flakiness); we trust the user has no
  # other git operation running. If they do, this will surface as a
  # later git error.
  rm -f .git/index.lock && ok "Removed stale .git/index.lock" \
    || fail "Could not remove .git/index.lock (another git process active?)"
else
  ok "No stale .git/index.lock"
fi

if [ -f "apps/web/tsconfig.button-only.json" ]; then
  rm -f apps/web/tsconfig.button-only.json && ok "Removed scratch apps/web/tsconfig.button-only.json" \
    || warn "Could not remove apps/web/tsconfig.button-only.json (manually delete)"
else
  ok "No scratch tsconfig.button-only.json"
fi

# --- Verify expected working-tree state ----------------------------
step "Verifying expected working-tree state"

# These are the EXACT paths Phase C + polish + integrity touched.
# Anything outside this list is unexpected and should not be committed.
EXPECTED_MODIFIED=(
  "apps/api/src/server/auth.ts"
  "apps/web/src/app/dashboard/orders/page.tsx"
  "apps/web/src/app/dashboard/settings/integrations/page.tsx"
  "apps/web/src/app/providers.tsx"
  "apps/web/src/components/onboarding/activation-moments.tsx"
  "apps/web/src/components/onboarding/onboarding-checklist.tsx"
  "apps/web/src/components/shell/command-palette.tsx"
  "apps/web/src/components/shell/topbar.tsx"
  "apps/web/src/components/ui/button.tsx"
  "apps/web/tsconfig.json"
)
EXPECTED_NEW=(
  "apps/web/src/app/(embedded)/_components/session-token-bridge.tsx"
  "apps/web/src/app/(embedded)/_components/shopify-auth-context.tsx"
  "apps/web/src/app/(embedded)/embedded/page.tsx"
  "apps/web/src/app/(embedded)/layout.tsx"
  "apps/web/src/lib/embedded-token-bus.ts"
)

for f in "${EXPECTED_MODIFIED[@]}"; do
  d=$(git diff --ignore-cr-at-eol --name-only main -- "$f")
  [ -n "$d" ] || fail "Expected modified file has no real diff: $f"
done
ok "All 10 expected modified files present with real diffs"

for f in "${EXPECTED_NEW[@]}"; do
  [ -f "$f" ] || fail "Expected new file missing: $f"
  tracked=$(git ls-files -- "$f")
  [ -z "$tracked" ] || fail "Expected new file is already tracked (unexpected): $f"
done
ok "All 5 expected new files present and untracked"

# Defensive: ensure shopify.app.toml + next.config.mjs are NOT changed
# (Phase D guard rails — these would mean someone started the cutover
# accidentally).
for guard in shopify.app.toml apps/web/next.config.mjs; do
  drift=$(git diff --ignore-cr-at-eol --name-only main -- "$guard")
  [ -z "$drift" ] || fail "Phase D guard file modified — refusing to deploy: $guard"
done
ok "shopify.app.toml and next.config.mjs unchanged (Phase D guard rails intact)"

# --- Typecheck both workspaces -------------------------------------
step "Running apps/api typecheck (build config)"
npm --workspace apps/api exec -- tsc --noEmit -p tsconfig.build.json \
  || fail "apps/api typecheck FAILED — refusing to deploy"
ok "apps/api typecheck clean"

step "Running apps/web typecheck"
npm --workspace apps/web run typecheck \
  || fail "apps/web typecheck FAILED — refusing to deploy"
ok "apps/web typecheck clean"

# --- Production build ----------------------------------------------
step "Running apps/web Next.js production build"
# This catches build-only errors that typecheck doesn't (route conflicts,
# server component / client component boundary issues, missing client
# exports, etc.). Slow but mandatory.
npm --workspace apps/web run build \
  || fail "apps/web build FAILED — refusing to deploy"
ok "apps/web build clean"

# Optional: api production build (skip if you don't have a build:strict
# target wired). Uncomment if your pipeline expects pre-built api dist:
#
# step "Running apps/api production build"
# npm --workspace apps/api run build:strict \
#   || fail "apps/api build FAILED — refusing to deploy"
# ok "apps/api build clean"

# --- Stage Commit 1 — Polish patches -------------------------------
step "Staging Commit 1: H1 + H3 + M3 polish patches"

git add \
  apps/web/src/components/onboarding/onboarding-checklist.tsx \
  apps/web/src/components/onboarding/activation-moments.tsx \
  apps/web/src/app/dashboard/orders/page.tsx

# Show what's staged for the user to eyeball
echo ""
git diff --cached --stat
echo ""

# --- Stage Commit 2 will happen after Commit 1 lands. To do that
# atomically with a single user confirmation, we commit Commit 1 NOW
# and stage Commit 2 afterwards.

# Commit 1 message — explicit, no auto-author tags, no Co-Authored-By
# (pure git author from local config).
COMMIT_1_MSG="fix(dashboard): pre-Phase-C UX polish — H1 H3 M3

- H1: onboarding-checklist now requires integration.health.ok !== false
  before marking the 'Connect your store' step done. Stops merchants
  thinking Shopify is connected when Admin API is 403'ing.
- H3: FirstFlagBanner suppresses itself when the live flagged count
  is zero. Closes the 'first order flagged · 0 flagged in last 30
  days' contradiction. localStorage stamp preserved so the banner
  reappears within its 7-day TTL when new flags arrive.
- M3: orders page header + table-body branches anchor on list.data
  presence (not just isLoading) so cache-invalidation races no
  longer flash '0 total orders' alongside indefinite skeletons.

Each patch single-file, reversible, low-risk. No API change, no
schema change, no runtime infra change."

git commit -m "$COMMIT_1_MSG" \
  || fail "Commit 1 failed (perhaps nothing staged after dedup)"
COMMIT_1_SHA=$(git rev-parse HEAD)
ok "Commit 1 created: ${COMMIT_1_SHA:0:10}"

# --- Stage Commit 2 — Phase C + Button + branding integrity ---------
step "Staging Commit 2: Phase C bridge + auto-provision + Button + branding"

git add \
  apps/web/tsconfig.json \
  apps/web/src/components/ui/button.tsx \
  apps/web/src/app/providers.tsx \
  apps/web/src/app/dashboard/settings/integrations/page.tsx \
  apps/web/src/components/shell/topbar.tsx \
  apps/web/src/components/shell/command-palette.tsx \
  apps/web/src/lib/embedded-token-bus.ts \
  "apps/web/src/app/(embedded)" \
  apps/api/src/server/auth.ts

echo ""
git diff --cached --stat
echo ""

COMMIT_2_MSG="feat(shopify): Phase C — embedded bridge + auto-provision + integrity fixes

Frontend embedded shell:
- (embedded)/layout.tsx mounts App Bridge v4 + ShopifyAuthContext +
  SessionTokenBridge for any page in the route group
- _components/shopify-auth-context.tsx: React context with
  { apiToken, status, error, shop, integrationId, retry }
- _components/session-token-bridge.tsx: calls shopify.idToken(),
  POSTs to /auth/shopify/exchange, populates context + token bus
- embedded/page.tsx: diagnostic landing at /embedded with status
  pill + retry + escape link to direct dashboard
- lib/embedded-token-bus.ts: module-level token store consumed by
  the tRPC client outside of React

Dual-auth (NextAuth + embedded coexist):
- providers.tsx headers() reads apiToken from EITHER NextAuth
  session OR embedded-token-bus (NextAuth-first preference). Direct
  login path unchanged — embedded only fills in when NextAuth has
  nothing.

Auto-provision (replaces legacy 404):
- /auth/shopify/exchange now exchanges the session token for an
  offline access token, creates a synthetic Merchant + Integration
  with refreshToken + accessTokenExpiresAt encrypted, and falls
  through to JWT issuance. Idempotent via Mongo unique-email index +
  atomic Integration upsert.

Iframe-safe gates:
- integrations/page.tsx: window.open(installUrl) gated on
  isEmbedded() — uses window.top.location.assign() inside iframe
- topbar.tsx + command-palette.tsx: signOut redirects gated on
  isEmbedded() — clear apiToken instead of redirecting to /login

Workspace integrity:
- apps/web/tsconfig.json: + @ecom/branding path aliases mirroring
  apps/api. Closes a fresh-checkout build fragility.
- components/ui/button.tsx: Omit<...,'variant'> on ButtonProps to
  neutralize the global ButtonHTMLAttributes augmentation shipped
  by @shopify/app-bridge-types (transitive dep of
  @shopify/app-bridge-react). No ts-ignore, no any, no widening,
  no public-API change.

Production stability invariants preserved:
- /auth/login, /auth/signup, /auth/refresh unchanged
- NextAuth session shape unchanged
- HttpOnly cookie shape unchanged
- OAuth code-grant install flow unchanged
- shopify.app.toml: embedded = false (Phase D not yet)
- CSP / X-Frame-Options unchanged

Phase C is a complete additive surface. Direct (non-iframe) login
still works exactly as today. The embedded surface is reachable at
/embedded for manual smoke testing, but Shopify won't iframe us
until Phase D updates application_url + flips embedded = true."

git commit -m "$COMMIT_2_MSG" \
  || fail "Commit 2 failed"
COMMIT_2_SHA=$(git rev-parse HEAD)
ok "Commit 2 created: ${COMMIT_2_SHA:0:10}"

# --- Confirmation gate before push ----------------------------------
step "Ready to push to origin/main"
echo "  Commit 1: ${COMMIT_1_SHA:0:10}  fix(dashboard): pre-Phase-C UX polish"
echo "  Commit 2: ${COMMIT_2_SHA:0:10}  feat(shopify): Phase C bridge + auto-provision"
echo ""

if [ "${CONFIRM:-0}" = "1" ]; then
  ok "CONFIRM=1 — skipping interactive prompt"
else
  printf "%bPush both commits to origin/main? [y/N]:%b " "$BOLD" "$RESET"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) fail "Push cancelled by user. Run 'git reset --soft HEAD~2' to unwind both commits if you want to redo." ;;
  esac
fi

# --- Push (regular, never --force) ----------------------------------
step "Pushing to origin/main"
git push origin main \
  || fail "Push failed — check network / auth / branch protection"

# Verify remote head matches what we just pushed
git fetch origin main --quiet
remote_head_after=$(git rev-parse origin/main)
[ "$remote_head_after" = "$COMMIT_2_SHA" ] || \
  fail "Remote head ($remote_head_after) does not match Commit 2 ($COMMIT_2_SHA) after push"
ok "origin/main now at $COMMIT_2_SHA"

# --- Post-deploy verification commands -----------------------------
step "Post-deploy verification (run after Vercel + Railway redeploy, ~3 min)"

cat <<EOF

# 1. /embedded should now be 200 (was 404)
curl -sI https://confirmx.ai/embedded | head -3
# expect: HTTP/2 200

# 2. Phase B verifier still rejects forged tokens
curl -sX POST https://api.confirmx.ai/auth/shopify/exchange \\
  -H 'content-type: application/json' \\
  -d '{}'
# expect: {"error":"invalid_session_token_request"}

curl -sX POST https://api.confirmx.ai/auth/shopify/exchange \\
  -H 'content-type: application/json' \\
  -d '{"sessionToken":"a-forged-token-of-sufficient-length-aaaaaaaaaaaaaaa"}'
# expect: {"error":"invalid_session_token"}

# 3. Direct login + dashboard still work
curl -sI https://confirmx.ai/login | head -3
# expect: HTTP/2 200

# 4. Open /embedded in a normal browser tab. The page should load,
#    show "Setting up your embedded session…", then flip the status
#    pill to "ERROR" with code "app_bridge_unavailable: ..." after
#    ~500ms. Click "Open the direct dashboard instead" → /dashboard.
#    This is the correct out-of-iframe behaviour for Phase C.

# 5. Sign in to /dashboard (direct path) and confirm:
#    - /dashboard/orders renders without skeleton-vs-empty mismatch
#    - /dashboard/getting-started step 1 reflects integration health
#    - /dashboard banner has no "first order flagged · 0 flagged" line
#    - sign-out from topbar redirects to /login (direct mode)

EOF

ok "Deployment script complete."
ok "After Vercel + Railway redeploy, run the verification commands above."
ok "If any verification fails, rollback: git revert ${COMMIT_2_SHA:0:10} && git revert ${COMMIT_1_SHA:0:10} && git push origin main"
