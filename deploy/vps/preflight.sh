#!/usr/bin/env bash
#
# ConfirmX VPS preflight — READ-ONLY. Changes nothing on the host.
#
# Run on the target VPS (the one that also runs Asterisk) BEFORE installing
# anything:   sudo bash preflight.sh > preflight-$(hostname)-$(date +%F).txt
#
# It answers: what is already listening (SIP/RTP/HTTP), is Asterisk healthy,
# is there room (CPU/RAM/disk) for ConfirmX, and would any ConfirmX port
# collide. Output contains no secrets (no config file contents are printed).

set -uo pipefail

CONFIRMX_PORTS=(80 443 3001 3002 4000 6379 27017)
section() { printf '\n==== %s ====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "Host"
hostnamectl 2>/dev/null || hostname
cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|VERSION_ID)='
uname -r
uptime

section "Resources"
nproc
free -h
df -hT -x tmpfs -x devtmpfs

section "Listening sockets (all)"
ss -tulpnH 2>/dev/null | awk '{print $1, $5, $7}' | sort -u

section "ConfirmX port collision check"
for p in "${CONFIRMX_PORTS[@]}"; do
  if ss -tulnH "( sport = :$p )" 2>/dev/null | grep -q .; then
    printf 'IN USE  %-6s %s\n' "$p" "$(ss -tulpnH "( sport = :$p )" 2>/dev/null | awk '{print $7}' | head -1)"
  else
    printf 'free    %s\n' "$p"
  fi
done

section "SIP / RTP"
ss -ulpnH 2>/dev/null | grep -E ':(5060|5061)\b' || echo "no UDP listener on 5060/5061"
ss -tlpnH 2>/dev/null | grep -E ':(5060|5061|5038|8088|8089)\b' || echo "no TCP listener on 5060/5061/5038/8088/8089"
if [ -r /etc/asterisk/rtp.conf ]; then grep -E '^\s*rtp(start|end)\s*=' /etc/asterisk/rtp.conf; fi

section "Asterisk"
if have asterisk; then
  asterisk -V 2>/dev/null
  systemctl is-active asterisk 2>/dev/null
  asterisk -rx "core show uptime" 2>/dev/null
  asterisk -rx "pjsip show transports" 2>/dev/null | grep -E 'Transport:|^ *[A-Za-z0-9_-]+ +(udp|tcp|tls|ws|wss)' | head -20
  asterisk -rx "pjsip show registrations" 2>/dev/null | head -20
  asterisk -rx "pjsip show endpoints" 2>/dev/null | grep -E '^ *Endpoint:' | awk '{print $2, $3, $4}' | head -40
else
  echo "asterisk binary not found"
fi

section "Web servers already present"
for s in nginx apache2 httpd caddy lighttpd; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^$s\.service"; then echo "$s: $(systemctl is-active "$s" 2>/dev/null)"; fi
done
have nginx && nginx -v 2>&1
[ -d /etc/nginx/sites-enabled ] && ls -l /etc/nginx/sites-enabled

section "Firewall"
if have ufw; then ufw status verbose 2>/dev/null; fi
if have iptables; then iptables -S 2>/dev/null | head -60; fi
if have nft; then nft list ruleset 2>/dev/null | head -80; fi

section "fail2ban"
if have fail2ban-client; then fail2ban-client status 2>/dev/null; fi

section "Runtimes"
for b in node npm pnpm mongod mongosh redis-server certbot git; do
  if have "$b"; then printf '%-13s %s\n' "$b" "$("$b" --version 2>/dev/null | head -1)"; else printf '%-13s -\n' "$b"; fi
done

section "Enabled services"
systemctl list-unit-files --state=enabled --type=service 2>/dev/null | awk 'NR>1 && $1 ~ /\.service$/ {print $1}'

section "Cron"
ls -l /etc/cron.d 2>/dev/null
crontab -l -u root 2>/dev/null | grep -v '^#' | sed '/^$/d' || true

echo
echo "preflight complete — nothing was changed."
