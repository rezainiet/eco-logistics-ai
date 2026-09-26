#!/usr/bin/env bash
#
# ConfirmX release on the VPS. Run as ROOT (it restarts systemd units and feeds
# the root-only env files to the build); every git/npm/build step runs as the
# unprivileged `confirmx` user, which has no sudo.
#
#   bash deploy.sh <branch|tag|sha> [--expect <full-sha>] [--dry-run]
#   bash deploy.sh --rollback [--dry-run]
#
#   <ref>      REQUIRED — what to deploy (no default: never deploys by accident)
#   --expect   refuse unless <ref> resolves to exactly this commit
#   --dry-run  print the plan (resolved commit, paths, services) and change nothing
#
# Builds a new release next to the running one and only switches the `app`
# symlink after every build succeeded, so a failed build never takes the site
# down. The previous release is kept for instant rollback.
#
# Layout:
#   /opt/confirmx/releases/<timestamp>-<sha7>/   full checkout + build (owned by confirmx)
#   /opt/confirmx/app -> releases/<current>      what systemd runs
#   /etc/confirmx/{api,web,sites}.env            secrets (root, 0600, not in git)
#
# Restarts only the ConfirmX services that are enabled. Never touches Asterisk,
# Nginx or the firewall.

set -euo pipefail
ROOT=/opt/confirmx
REPO="${CONFIRMX_REPO:-https://github.com/rezainiet/eco-logistics-ai.git}"
SERVICES=(confirmx-api confirmx-web confirmx-sites)
KEEP=5

die() { echo "deploy: $*" >&2; exit 1; }
log() { echo "deploy: $*"; }

REF="" EXPECT="" DRY=0 ROLLBACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) ROLLBACK=1 ;;
    --dry-run) DRY=1 ;;
    --expect) shift; EXPECT="${1:-}"; [ -n "$EXPECT" ] || die "--expect needs a commit sha" ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$REF" ] || die "only one ref"; REF="$1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run as root (builds run as the confirmx user; confirmx has no sudo)"
id confirmx >/dev/null 2>&1 || die "user confirmx missing"

as_confirmx() {
  runuser -u confirmx -- env HOME="$ROOT/shared/home" GIT_TERMINAL_PROMPT=0 \
    npm_config_update_notifier=false NEXT_TELEMETRY_DISABLED=1 MONGOMS_DISABLE_POSTINSTALL=1 "$@"
}
# Build with a root-only env file: root opens it and hands it to confirmx on stdin.
build_with_env() { # <env-file> <workspace>
  local envf="$1" ws="$2"
  as_confirmx bash -c "set -a; source <(cat); set +a; cd '$dest'; nice -n 10 npm --workspace $ws run build" < "$envf"
}
enabled_services() {
  local s out=()
  for s in "${SERVICES[@]}"; do systemctl is-enabled --quiet "$s" 2>/dev/null && out+=("$s"); done
  echo "${out[@]:-}"
}
restart() {
  local svc; svc="$(enabled_services)"
  [ -n "$svc" ] || { log "no ConfirmX service enabled — nothing to restart"; return 0; }
  log "restarting: $svc"
  # shellcheck disable=SC2086
  systemctl restart $svc
  sleep 6
  bash "$ROOT/app/deploy/vps/smoke-test.sh" || log "WARNING: smoke test reported failures (see above)"
}

current="$(readlink -f "$ROOT/app" 2>/dev/null || true)"

if [ "$ROLLBACK" -eq 1 ]; then
  prev="$(ls -1dt "$ROOT"/releases/*/ 2>/dev/null | sed 's:/*$::' | grep -vx "$current" | head -1 || true)"
  [ -n "$prev" ] || die "no previous release to roll back to"
  log "rollback: $current -> $prev ($(as_confirmx git -C "$prev" rev-parse --short HEAD 2>/dev/null || echo '?'))"
  [ "$DRY" -eq 1 ] && { log "dry run — would switch the symlink and restart: $(enabled_services)"; exit 0; }
  ln -sfn "$prev" "$ROOT/app"
  restart
  exit 0
fi

[ -n "$REF" ] || die "missing <ref> (branch, tag or commit sha). Refusing to guess."

# Resolve the ref to a commit up front (branch/tag via ls-remote; a sha is used as given).
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  sha="$REF"
else
  sha="$(as_confirmx git ls-remote "$REPO" "refs/heads/$REF" "refs/tags/$REF" | awk 'NR==1{print $1}')"
  [ -n "$sha" ] || die "ref '$REF' not found in $REPO"
fi
[ -z "$EXPECT" ] || [ "$sha" = "$EXPECT" ] || die "ref '$REF' is $sha, expected $EXPECT"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$ROOT/releases/$stamp-${sha:0:7}"
log "ref $REF -> $sha"
log "current release: ${current:-none}"
log "new release:     $dest"
log "services:        $(enabled_services)"
if [ "$DRY" -eq 1 ]; then log "dry run — nothing changed"; exit 0; fi

tmp="$ROOT/releases/.building-$stamp"
as_confirmx git clone --quiet "$REPO" "$tmp"
as_confirmx git -C "$tmp" checkout --quiet --detach "$sha"
[ "$(as_confirmx git -C "$tmp" rev-parse HEAD)" = "$sha" ] || die "checkout mismatch"
mv "$tmp" "$dest"
cd "$dest"

as_confirmx npm ci --no-audit --no-fund --loglevel=error
# Shared packages first (apps import their dist/).
as_confirmx npm --workspace packages/db run build
as_confirmx npm --workspace packages/types run build
as_confirmx npm --workspace packages/branding run build --if-present
as_confirmx npm --workspace packages/landing run build
as_confirmx npm --workspace apps/api run build:strict
# Next.js inlines NEXT_PUBLIC_* / reads LANDING_* at build time.
build_with_env /etc/confirmx/web.env apps/web
build_with_env /etc/confirmx/sites.env apps/sites

ln -sfn "$dest" "$ROOT/app"
chown -h confirmx:confirmx "$ROOT/app"
log "switched to $dest ($sha)"
restart

# Keep the $KEEP newest releases; never delete the current or the previous one.
keep_prev="$current"
ls -1dt "$ROOT"/releases/*/ | sed 's:/*$::' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$dest" ] || [ "$old" = "$keep_prev" ] || rm -rf "$old"
done
