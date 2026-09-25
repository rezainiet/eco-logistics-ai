#!/usr/bin/env bash
#
# Asterisk / PBX full backup — READ-ONLY on the live system.
#
#   sudo bash pbx-backup.sh [output-dir]          (default /root/pbx-backups)
#
# Produces   pbx-SENSITIVE-<host>-<UTC stamp>.tar.gz  (+ .sha256)
# containing
#   files/…   copies of every config/state path below (ownership + modes kept)
#   state/…   what the running system reports: versions, loaded PJSIP objects,
#             transports, registrations, ports, firewall, fail2ban, services,
#             cron, permissions/ownership listing
#   MANIFEST.sha256   checksum of every file in the archive
#
# The archive CONTAINS SECRETS (SIP/trunk passwords, AMI credentials, TLS
# keys). Store it encrypted, outside git, and never paste its contents.
#
# Nothing is modified: no restarts, no reloads, no config writes. Asterisk
# is only queried through read-only CLI commands ("show …").
#
# INCLUDE_RECORDINGS=1 also copies /var/spool/asterisk/monitor (can be large).

set -uo pipefail
umask 077

OUT_DIR="${1:-/root/pbx-backups}"
HOST="$(hostname -s 2>/dev/null || hostname)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="pbx-SENSITIVE-$HOST-$STAMP"
WORK="$(mktemp -d)"
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/files" "$STAGE/state" "$OUT_DIR"

log() { printf '[pbx-backup] %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
ast() { asterisk -rx "$1" 2>&1; }

# ── Paths to copy (only those that exist) ────────────────────────────────────
PATHS=(
  /etc/asterisk
  /etc/pjsip
  /etc/pjsip.d
  /var/lib/asterisk/astdb.sqlite3
  /var/lib/asterisk/keys
  /var/lib/asterisk/agi-bin
  /var/lib/asterisk/sounds/custom
  /var/lib/asterisk/sounds/en/custom
  /var/lib/asterisk/moh/custom
  /var/spool/asterisk/voicemail
  /var/spool/asterisk/outgoing
  /etc/default/asterisk
  /etc/logrotate.d/asterisk
  /lib/systemd/system/asterisk.service
  /etc/systemd/system/asterisk.service
  /etc/systemd/system/asterisk.service.d
  /etc/ufw
  /etc/fail2ban
  /etc/nginx
  /etc/letsencrypt
  /etc/ssl/asterisk
  /etc/cron.d
  /etc/cron.daily
  /etc/crontab
  /var/spool/cron/crontabs
  /usr/local/bin
  /usr/local/sbin
  /opt/pbx
  /etc/sysctl.conf
  /etc/sysctl.d
  /etc/netplan
  /etc/hosts
  /etc/hostname
  /etc/iptables
  /etc/ssh/sshd_config
  /etc/ssh/sshd_config.d
)
[ "${INCLUDE_RECORDINGS:-0}" = "1" ] && PATHS+=(/var/spool/asterisk/monitor)
# Source build options — needed to rebuild the SAME Asterisk (menuselect).
for d in /usr/src/asterisk*; do
  [ -f "$d/menuselect.makeopts" ] && PATHS+=("$d/menuselect.makeopts")
done

present=()
for p in "${PATHS[@]}"; do [ -e "$p" ] && present+=("$p"); done
log "copying ${#present[@]} paths"
# tar preserves owner/group/mode/mtime; --numeric-owner keeps uid/gid exact.
tar --numeric-owner -cpf - "${present[@]}" 2>"$STAGE/state/tar-warnings.txt" | tar -xpf - -C "$STAGE/files"

# ── State (read-only queries) ────────────────────────────────────────────────
S="$STAGE/state"
{ cat /etc/os-release; echo; uname -a; } >"$S/os.txt"
{ hostnamectl 2>/dev/null; timedatectl 2>/dev/null; } >"$S/host.txt"
{ nproc; free -h; df -hT -x tmpfs -x devtmpfs; } >"$S/resources.txt"
ip -brief addr >"$S/ip-addr.txt" 2>&1
ip route >"$S/ip-route.txt" 2>&1

if have asterisk; then
  asterisk -V >"$S/asterisk-version.txt" 2>&1
  ast "core show version"        >"$S/ast-core-version.txt"
  ast "core show settings"       >"$S/ast-core-settings.txt"
  ast "core show build options"  >"$S/ast-build-options.txt"
  ast "core show uptime"         >"$S/ast-uptime.txt"
  ast "module show"              >"$S/ast-modules.txt"
  ast "pjsip show transports"    >"$S/pjsip-transports.txt"
  ast "pjsip show endpoints"     >"$S/pjsip-endpoints.txt"
  ast "pjsip show aors"          >"$S/pjsip-aors.txt"
  ast "pjsip show contacts"      >"$S/pjsip-contacts.txt"
  ast "pjsip show registrations" >"$S/pjsip-registrations.txt"
  ast "pjsip show identifies"    >"$S/pjsip-identifies.txt"
  ast "pjsip show auths"         >"$S/pjsip-auths.txt"   # usernames only; passwords stay in files/
  ast "dialplan show"            >"$S/dialplan.txt"
  ast "voicemail show users"     >"$S/voicemail-users.txt"
  ast "manager show users"       >"$S/ami-users.txt"
  ast "rtp show settings"        >"$S/rtp-settings.txt"
  ast "sip show peers"           >"$S/chan_sip-peers.txt"  # empty/error when chan_sip is not loaded
  ast "database show"            >"$S/astdb.txt"
fi
dpkg -l 2>/dev/null | grep -Ei 'asterisk|pjsip|fail2ban|ufw|nginx|certbot' >"$S/packages.txt"
dpkg --get-selections >"$S/dpkg-selections.txt" 2>/dev/null
apt-mark showmanual >"$S/apt-manual.txt" 2>/dev/null

ss -tulpn >"$S/ports.txt" 2>&1
systemctl list-unit-files --state=enabled --type=service >"$S/services-enabled.txt" 2>&1
systemctl status asterisk --no-pager >"$S/asterisk-service-status.txt" 2>&1
systemctl cat asterisk >"$S/asterisk-unit-effective.txt" 2>&1
have ufw && ufw status verbose >"$S/ufw-status.txt" 2>&1
have ufw && ufw show added >"$S/ufw-added.txt" 2>&1
have iptables-save && iptables-save >"$S/iptables-save.txt" 2>&1
have ip6tables-save && ip6tables-save >"$S/ip6tables-save.txt" 2>&1
have nft && nft list ruleset >"$S/nft-ruleset.txt" 2>&1
if have fail2ban-client; then
  fail2ban-client status >"$S/fail2ban-status.txt" 2>&1
  for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:\s*//p' | tr ',' ' '); do
    fail2ban-client status "$j" >"$S/fail2ban-jail-$j.txt" 2>&1
  done
fi
crontab -l -u root >"$S/crontab-root.txt" 2>&1
for u in $(cut -d: -f1 /etc/passwd); do crontab -l -u "$u" >/dev/null 2>&1 && crontab -l -u "$u" >"$S/crontab-$u.txt" 2>&1; done
getent passwd asterisk >"$S/asterisk-user.txt" 2>&1
id asterisk >>"$S/asterisk-user.txt" 2>&1

# Permissions + ownership of everything copied (mode, user, group, size, path).
find "${present[@]}" -printf '%m %u %g %s %p\n' >"$S/permissions.txt" 2>/dev/null

# Recent errors that would matter on restore (last 400 lines).
[ -f /var/log/asterisk/messages ] && tail -n 400 /var/log/asterisk/messages >"$S/asterisk-messages-tail.txt"
[ -f /var/log/asterisk/full ] && tail -n 400 /var/log/asterisk/full >"$S/asterisk-full-tail.txt"

{
  echo "backup_name=$NAME"
  echo "created_utc=$STAMP"
  echo "host=$HOST"
  echo "asterisk=$(asterisk -V 2>/dev/null)"
  echo "os=$(. /etc/os-release; echo "$PRETTY_NAME")"
  echo "paths_copied=${#present[@]}"
  echo "pjsip_endpoints=$(grep -c '^ *Endpoint:' "$S/pjsip-endpoints.txt" 2>/dev/null)"
  echo "pjsip_registrations=$(grep -cE 'Registered|Rejected|Unregistered' "$S/pjsip-registrations.txt" 2>/dev/null)"
} >"$STAGE/BACKUP-INFO.txt"

( cd "$STAGE" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum >MANIFEST.sha256 )

tar --numeric-owner -czpf "$OUT_DIR/$NAME.tar.gz" -C "$WORK" "$NAME"
( cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )
rm -rf "$WORK"

# Self-check: the archive lists and its manifest verifies.
tar -tzf "$OUT_DIR/$NAME.tar.gz" >/dev/null || { log "ARCHIVE LIST FAILED"; exit 1; }
log "archive: $OUT_DIR/$NAME.tar.gz"
cat "$OUT_DIR/$NAME.tar.gz.sha256"
