# Asterisk / PBX — disaster recovery

Restore the PBX onto a brand-new Ubuntu VPS from the backup produced by
`ops/backup/pbx-backup.sh` (`pbx-SENSITIVE-<host>-<stamp>.tar.gz`).
**Passwords never appear in this document** — they are inside the encrypted
archive only; placeholders look like `<TRUNK_PASSWORD>`.

Inside the archive:
```
files/…            exact copies (owner/group/mode kept): /etc/asterisk, /var/lib/asterisk/{astdb,keys,agi-bin,custom sounds},
                   /var/spool/asterisk/{voicemail,outgoing}, systemd unit + overrides, /etc/ufw, /etc/fail2ban,
                   /etc/letsencrypt (if any), cron, /usr/local/{bin,sbin}, sysctl, netplan, sshd_config, menuselect.makeopts
state/…            what was running: asterisk-version.txt, os.txt, ast-build-options.txt, pjsip-{transports,endpoints,
                   aors,contacts,registrations,identifies,auths}.txt, dialplan.txt, rtp-settings.txt, ports.txt,
                   ufw-status.txt, iptables-save.txt, fail2ban-*.txt, services-enabled.txt, crontab-*.txt, permissions.txt
MANIFEST.sha256    checksum of every file
BACKUP-INFO.txt    host, time, Asterisk + OS version, endpoint/registration counts
```
Record from `BACKUP-INFO.txt` and `state/` before starting:
`ASTERISK_VERSION=<e.g. 20.x.y>`, `OS=<e.g. Ubuntu 22.04>`, public IP, RTP range, trunk name.

## 0. Verify the backup (on your PC)
```bash
bash ops/backup/verify-pbx-backup.sh pbx-SENSITIVE-<host>-<stamp>.tar.gz     # must end with no FAIL lines
```

## 1. Install Ubuntu
Same major release as `state/os.txt` (e.g. Ubuntu 22.04/24.04 LTS, 64-bit). Note the new public IP.

## 2. Update system
```bash
apt update && apt -y full-upgrade && reboot
timedatectl set-timezone Asia/Dhaka
```

## 3. Install required packages
```bash
apt -y install build-essential git curl wget subversion pkg-config libedit-dev libjansson-dev libxml2-dev \
  uuid-dev libsqlite3-dev libssl-dev libsrtp2-dev libncurses-dev ufw fail2ban sngrep tcpdump
```
Packages the old host had: `state/packages.txt` / `state/apt-manual.txt`.

## 4. Install the exact Asterisk version
Use the version in `state/asterisk-version.txt` and the module selection in
`files/usr/src/asterisk-*/menuselect.makeopts` (if built from source):
```bash
cd /usr/src && wget https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-<ASTERISK_VERSION>.tar.gz
tar xzf asterisk-<ASTERISK_VERSION>.tar.gz && cd asterisk-<ASTERISK_VERSION>
contrib/scripts/install_prereq install
./configure --with-jansson-bundled --with-pjproject-bundled
cp /root/restore/files/usr/src/asterisk-*/menuselect.makeopts . 2>/dev/null || make menuselect
make -j"$(nproc)" && make install && make config && ldconfig
```
If the old host used the distro package instead (`state/packages.txt` lists `asterisk` from apt), install that same package version.
Check: `asterisk -V` equals the backup's version; compare `asterisk -rx "core show build options"` with `state/ast-build-options.txt`.

## 5. Stop Asterisk
```bash
systemctl stop asterisk || true
```

## 6. Restore configuration
```bash
mkdir -p /root/restore && tar -xzpf pbx-SENSITIVE-<host>-<stamp>.tar.gz -C /root/restore --strip-components=1
cd /root/restore && sha256sum -c --quiet MANIFEST.sha256
cp -a files/etc/asterisk/. /etc/asterisk/
cp -a files/var/lib/asterisk/. /var/lib/asterisk/
cp -a files/var/spool/asterisk/. /var/spool/asterisk/
[ -d files/etc/pjsip ] && cp -a files/etc/pjsip /etc/
[ -d files/etc/pjsip.d ] && cp -a files/etc/pjsip.d /etc/
```
If the public IP changed, update `external_media_address` / `external_signaling_address`
(and `local_net`) on the PJSIP transport(s) in `/etc/asterisk/pjsip*.conf`.

## 7. Restore permissions
```bash
id asterisk || adduser --system --group --home /var/lib/asterisk asterisk      # compare with state/asterisk-user.txt
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk 2>/dev/null
# Exact modes/owners of every file are in state/permissions.txt ("mode user group size path"):
awk '{print $1, $2":"$3, $5}' state/permissions.txt | while read m o p; do [ -e "$p" ] && chmod "$m" "$p" && chown "$o" "$p"; done
```

## 8. Restore systemd configuration
```bash
[ -f files/etc/systemd/system/asterisk.service ] && cp files/etc/systemd/system/asterisk.service /etc/systemd/system/
[ -d files/etc/systemd/system/asterisk.service.d ] && cp -a files/etc/systemd/system/asterisk.service.d /etc/systemd/system/
[ -f files/etc/default/asterisk ] && cp files/etc/default/asterisk /etc/default/
systemctl daemon-reload && systemctl enable asterisk
```
Compare with `state/asterisk-unit-effective.txt`.

## 9. Restore firewall
Re-apply the rules recorded in `state/ufw-status.txt` (don't copy iptables raw
files between different hosts/IPs blindly):
```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH
ufw allow 5060/udp                        # SIP (only from the provider's IPs if the old rules did so)
ufw allow <RTP_START>:<RTP_END>/udp       # from rtp.conf / state/rtp-settings.txt
# + every other rule listed in state/ufw-status.txt (e.g. 5061/tcp TLS, restricted sources)
ufw enable && ufw status verbose
```

## 10. Restore fail2ban
```bash
cp -a files/etc/fail2ban/. /etc/fail2ban/
systemctl enable --now fail2ban && fail2ban-client status        # jails as in state/fail2ban-status.txt
```

## 11. Restore SIP / PJSIP
Configuration came back in step 6 (`pjsip.conf` and any `pjsip_*.conf` includes,
`extensions.conf`, `rtp.conf`, `modules.conf`, `manager.conf`).
AMI must stay bound to `127.0.0.1` (`manager.conf` → `bindaddr = 127.0.0.1`).

## 12. Restore custom scripts
```bash
cp -a files/usr/local/bin/. /usr/local/bin/ 2>/dev/null; cp -a files/usr/local/sbin/. /usr/local/sbin/ 2>/dev/null
cp -a files/etc/cron.d/. /etc/cron.d/ 2>/dev/null
crontab -u root state/crontab-root.txt   # review first; skip lines that reference paths that no longer exist
[ -d files/etc/letsencrypt ] && cp -a files/etc/letsencrypt /etc/      # TLS for SIP/WSS, if used
```

## 13. Start Asterisk
```bash
systemctl start asterisk && systemctl status asterisk --no-pager
asterisk -rx "core show uptime"
```

## 14. Validate PJSIP
```bash
asterisk -rx "module show like pjsip" | tail -1           # modules loaded
grep -iE "error|unable|failed" /var/log/asterisk/messages | tail -20
```

## 15. Validate transports
```bash
asterisk -rx "pjsip show transports"      # same transports/ports as state/pjsip-transports.txt
ss -ulpn | grep 5060
```

## 16. Validate endpoints
```bash
asterisk -rx "pjsip show endpoints"       # same endpoint list/count as state/pjsip-endpoints.txt
```

## 17. Validate trunk
```bash
asterisk -rx "pjsip show registrations"   # trunk shows "Registered"
asterisk -rx "pjsip show contacts"        # trunk contact "Avail" with RTT
```

## 18. Validate RTP
```bash
asterisk -rx "rtp show settings"          # port range as before
# during a test call:
asterisk -rx "rtp set debug on"; sngrep   # media flows both ways; then "rtp set debug off"
```

## 19. Test inbound
Call the DID from a mobile phone → it must ring the destination in `extensions.conf`
(inbound context of the trunk). Watch: `asterisk -rvvv`.

## 20. Test outbound
From an extension, dial a mobile number (with the dial prefix used in the outbound
context). Check caller ID and two-way audio.

## 21. Test extension-to-extension
Register two softphones (e.g. extensions `<EXT_A>`, `<EXT_B>`) and call between them:
ringing, answer, two-way audio, hang-up from either side.

## 22. Verify logs
```bash
tail -n 100 /var/log/asterisk/messages
fail2ban-client status asterisk 2>/dev/null
journalctl -u asterisk -n 50 --no-pager
```
No `Unable to`/`ERROR` lines about PJSIP, RTP or modules; fail2ban has not banned your own IPs.

## Restoring the Brilliant SIP trunk (Brilliant Connect / Jogajog)

The trunk objects are in the restored `pjsip.conf` (or `pjsip_trunk*.conf`) —
`state/pjsip-registrations.txt` names the registration and `state/pjsip-endpoints.txt`
the trunk endpoint. A trunk definition has this shape (placeholders only):

```ini
[brilliant-reg]
type = registration
transport = transport-udp
outbound_auth = brilliant-auth
server_uri = sip:<PROVIDER_SIP_HOST>
client_uri = sip:<TRUNK_USERNAME>@<PROVIDER_SIP_HOST>
retry_interval = 60

[brilliant-auth]
type = auth
auth_type = userpass
username = <TRUNK_USERNAME>
password = <TRUNK_PASSWORD>          ; from the encrypted backup — never from chat/email

[brilliant]
type = aor
contact = sip:<PROVIDER_SIP_HOST>

[brilliant]
type = endpoint
transport = transport-udp
context = <INBOUND_CONTEXT>
disallow = all
allow = ulaw,alaw
outbound_auth = brilliant-auth
aors = brilliant
from_user = <TRUNK_USERNAME>
direct_media = no

[brilliant]
type = identify
endpoint = brilliant
match = <PROVIDER_SIGNALING_IPS>
```

Steps:
1. Compare the restored trunk sections with the shape above — do not retype values; they came back from the archive.
2. **If the server's public IP changed, tell the provider first.** Brilliant trunks are commonly IP-whitelisted: send the new IP and wait for confirmation, otherwise registration and inbound calls fail.
3. Update `external_media_address` / `external_signaling_address` on the transport to the new IP.
4. Firewall: allow SIP (5060/udp) and the RTP range from the provider's signalling/media IPs.
5. `asterisk -rx "pjsip reload"` → `pjsip show registrations` shows `Registered`.
6. Inbound test to the DID, outbound test to a mobile (steps 19–20).

## Safety notes
- Never publish or paste the archive's `files/etc/asterisk/pjsip*.conf`, `manager.conf`, or `/etc/letsencrypt` contents.
- ConfirmX (web/api/sites) must not be installed until the PBX passes steps 13–22; see CONFIRMX-RECOVERY.md.
