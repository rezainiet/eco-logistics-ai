#!/usr/bin/env bash
#
# ConfirmX release on the VPS. Run as the `confirmx` user:
#   bash /opt/confirmx/app/deploy/vps/deploy.sh [git-ref]
#
# Builds a new release next to the running one and only switches the
# `app` symlink after every build succeeded, so a failed build never takes
# the site down. The previous release is kept for instant rollback:
#   bash deploy.sh --rollback
#
# Layout:
#   /opt/confirmx/releases/<timestamp>-<sha>/   full checkout + build
#   /opt/confirmx/app -> releases/<current>     what systemd runs
#   /etc/confirmx/{api,web,sites}.env           secrets (not in git)
#
# Never touches Asterisk, Nginx or the firewall.

set -euo pipefail
ROOT=/opt/confirmx
REPO="${CONFIRMX_REPO:-https://github.com/rezainiet/eco-logistics-ai.git}"
REF="${1:-main}"
SERVICES=(confirmx-api confirmx-web confirmx-sites)

restart() {
  sudo systemctl restart "${SERVICES[@]}"
  sleep 5
  bash "$ROOT/app/deploy/vps/smoke-test.sh"
}

if [ "$REF" = "--rollback" ]; then
  prev="$(ls -1dt "$ROOT"/releases/*/ | sed -n 2p)"
  [ -n "$prev" ] || { echo "no previous release"; exit 1; }
  ln -sfn "$prev" "$ROOT/app"
  echo "rolled back to $prev"
  restart
  exit $?
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$ROOT/releases/.building-$stamp"
git clone --quiet --depth 50 --branch "$REF" "$REPO" "$tmp" 2>/dev/null || {
  git clone --quiet "$REPO" "$tmp" && git -C "$tmp" checkout --quiet "$REF"
}
sha="$(git -C "$tmp" rev-parse --short HEAD)"
dest="$ROOT/releases/$stamp-$sha"
mv "$tmp" "$dest"
cd "$dest"

npm ci --no-audit --no-fund
# Shared packages first (apps import their dist/).
npm --workspace packages/db run build
npm --workspace packages/types run build
npm --workspace packages/branding run build --if-present
npm --workspace packages/landing run build
npm --workspace apps/api run build:strict
# Next.js inlines NEXT_PUBLIC_* / reads LANDING_* at build time.
( set -a; . /etc/confirmx/web.env;   set +a; npm --workspace apps/web run build )
( set -a; . /etc/confirmx/sites.env; set +a; npm --workspace apps/sites run build )

ln -sfn "$dest" "$ROOT/app"
echo "switched to $dest"
restart

# Keep the 5 newest releases.
ls -1dt "$ROOT"/releases/*/ | tail -n +6 | xargs -r rm -rf
