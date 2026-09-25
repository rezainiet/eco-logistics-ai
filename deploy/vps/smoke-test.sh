#!/usr/bin/env bash
#
# ConfirmX deployment smoke test. Read-only HTTP checks; exits non-zero on failure.
#
#   bash smoke-test.sh                                   # internal (on the VPS, loopback ports)
#   WEB=https://app-vps.confirmx.ai API=https://api-vps.confirmx.ai bash smoke-test.sh   # staging hostnames
#   WEB=https://app.confirmx.ai API=https://api.confirmx.ai bash smoke-test.sh           # after cutover
#
# Optional: SITES=http://127.0.0.1:3002  LANDING_HOST=<slug>.<landing-domain> (DOMAIN phase)

set -uo pipefail
WEB="${WEB:-http://127.0.0.1:3001}"
API="${API:-http://127.0.0.1:4000}"
SITES="${SITES:-http://127.0.0.1:3002}"
fail=0

check() { # name url expected-status [grep-pattern]
  local name="$1" url="$2" want="$3" pattern="${4:-}"
  local body code
  body="$(curl -sS -m 10 -w '\n%{http_code}' "$url" 2>&1)" || true
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" != "$want" ]; then
    printf 'FAIL  %-28s %s → %s (want %s)\n' "$name" "$url" "$code" "$want"; fail=1; return
  fi
  if [ -n "$pattern" ] && ! grep -qE "$pattern" <<<"$body"; then
    printf 'FAIL  %-28s %s → body did not match /%s/\n' "$name" "$url" "$pattern"; fail=1; return
  fi
  printf 'ok    %-28s %s → %s\n' "$name" "$url" "$code"
}

check "api liveness"             "$API/health"   200 '"ok":true'
check "api readiness (mongo+redis)" "$API/ready" 200 '"mongo":\{"ok":true'
check "api tRPC public"          "$API/trpc/publicLanding.resolveByHost?input=%7B%22host%22%3A%22does-not-exist.invalid%22%7D" 200 'not_found'
check "api auth enforced"        "$API/trpc/merchants.getProfile" 401
check "web liveness"             "$WEB/api/health" 200 '"service":"web"'
check "web login page"           "$WEB/login"    200 '<html'
check "web marketing"            "$WEB/"         200 '<html'
check "sites liveness"           "$SITES/healthz" 200 '"service":"sites"'
check "sites readiness (→ api)"  "$SITES/readyz" 200 '"api":true'
if [ -n "${LANDING_HOST:-}" ]; then
  check "landing page"           "https://$LANDING_HOST/" 200 'data-landing-root'
fi

# Security headers on the dashboard
hdr="$(curl -sSI -m 10 "$WEB/login" 2>/dev/null)"
grep -qi '^x-frame-options: DENY' <<<"$hdr" && echo "ok    web X-Frame-Options" || { echo "FAIL  web X-Frame-Options"; fail=1; }
grep -qi '^content-security-policy' <<<"$hdr" && echo "ok    web CSP present" || echo "warn  web CSP header (report-only?)"

exit $fail
