#!/usr/bin/env bash
#
# Verify a PBX backup archive WITHOUT touching any live system:
#   bash verify-pbx-backup.sh pbx-SENSITIVE-<host>-<stamp>.tar.gz
#
# Checks the outer checksum, extracts into a temporary directory, verifies
# every file against MANIFEST.sha256 and confirms the files a restore
# depends on are present. Prints names only — never file contents.

set -uo pipefail
ARCHIVE="$1"
fail=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }

[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE"; exit 2; }
if [ -f "$ARCHIVE.sha256" ]; then
  want="$(awk '{print $1}' "$ARCHIVE.sha256")"
  got="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  [ "$want" = "$got" ] && ok "archive sha256 matches" || bad "archive sha256 mismatch"
else
  bad "missing $ARCHIVE.sha256"
fi

tar -tzf "$ARCHIVE" >/dev/null 2>&1 && ok "archive lists ($(tar -tzf "$ARCHIVE" | wc -l) entries)" || bad "archive does not list"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP" 2>/dev/null
ROOT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$ROOT" ] || { bad "empty archive"; exit 1; }

( cd "$ROOT" && sha256sum --quiet -c MANIFEST.sha256 ) && ok "all files match MANIFEST.sha256 ($(wc -l <"$ROOT/MANIFEST.sha256") files)" || bad "manifest verification failed"

need() { [ -e "$ROOT/$1" ] && ok "present: $1" || bad "missing: $1"; }
need files/etc/asterisk/asterisk.conf
need files/etc/asterisk/extensions.conf
need files/etc/asterisk/modules.conf
[ -e "$ROOT/files/etc/asterisk/pjsip.conf" ] || ls "$ROOT"/files/etc/asterisk/pjsip*.conf >/dev/null 2>&1 && ok "present: PJSIP config" || bad "missing: PJSIP config"
need files/etc/asterisk/rtp.conf
need state/asterisk-version.txt
need state/os.txt
need state/pjsip-endpoints.txt
need state/pjsip-transports.txt
need state/pjsip-registrations.txt
need state/ports.txt
need state/permissions.txt
need state/services-enabled.txt
[ -e "$ROOT/files/etc/ufw" ] && ok "present: ufw rules" || echo "info  no /etc/ufw in backup (ufw not used?)"
[ -e "$ROOT/files/etc/fail2ban" ] && ok "present: fail2ban config" || echo "info  no /etc/fail2ban in backup"

echo
echo "Asterisk : $(head -1 "$ROOT/state/asterisk-version.txt" 2>/dev/null)"
echo "OS       : $(grep '^PRETTY_NAME=' "$ROOT/state/os.txt" 2>/dev/null | cut -d= -f2)"
echo "Endpoints: $(grep -c '^ *Endpoint:' "$ROOT/state/pjsip-endpoints.txt" 2>/dev/null)"
echo "Transports:"; grep -E '^ *Transport:' "$ROOT/state/pjsip-transports.txt" 2>/dev/null | awk '{print "  ", $2, $3, $4}'
exit $fail
