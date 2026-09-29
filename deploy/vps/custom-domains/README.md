# Custom domains per landing page — server helper

A merchant connects their own domain (e.g. `shop.example.com`) to ONE published
landing page. The API owns the state; this helper is the only thing that touches
certificates or Nginx for those domains. **Nothing here is active until an
operator performs the installation below. A normal `deploy.sh` release installs
none of it.**

## Flow

1. Merchant adds the domain in the page settings → `pending_verification`.
2. Merchant adds the DNS records shown (TXT `_confirmx-verify.<domain>` for
   ownership; A → `CUSTOM_DOMAIN_TARGET_IPV4`, or CNAME → `CUSTOM_DOMAIN_CNAME_TARGET`
   for a subdomain) and clicks **Check DNS** → `verified`, then `ssl_pending`
   once the domain points at the server.
3. Every 2 minutes the helper (systemd timer) pulls
   `GET http://127.0.0.1:4000/internal/custom-domains/desired`, issues a
   certificate `cx-<domain>` with `certbot certonly --webroot` (HTTP-01 through the
   existing port-80 ACME location), writes `/etc/nginx/confirmx-custom-domains/domains.conf`,
   runs `nginx -t` and `systemctl reload nginx`, then reports to
   `POST /internal/custom-domains/report` → `live` (or `error` with a merchant-safe message).
4. Renewal: `certbot.timer` renews `cx-*` certificates like every other one
   (its deploy hook reloads Nginx). The helper re-issues only a missing/expired one.
5. Removal (or page archive): the row is deleted; the next run drops the server
   block, reloads Nginx and `certbot delete`s only that `cx-<domain>` certificate.

### Retry backoff after a failed issuance

Let's Encrypt allows only a few failed validations per hostname per hour, so a
failing domain must not be retried on every timer tick. The API persists
`customDomain.sslFailures` (consecutive) and `sslFailedAt`; the next attempt is
allowed 15 min after the first failure, doubling per consecutive failure, capped
at 6 h. The desired list carries `issueAllowed: false` (+ `retryAfter`) during the
backoff and the helper then makes no certbot call for that domain (an existing
certificate keeps being served; nothing is reported). The merchant's **Check DNS**
retry is gated by the same backoff. A successful issuance resets it.

## What the helper can do (and nothing else)

| Action | Exact command / file |
|---|---|
| issue | `/usr/bin/certbot certonly --webroot -w /var/www/certbot --non-interactive -d <d> --cert-name cx-<d> --agree-tos --keep-until-expiring` |
| delete | `/usr/bin/certbot delete --cert-name cx-<d> --non-interactive` (only `cx-` names) |
| test | `/usr/sbin/nginx -t` |
| reload | `/usr/bin/systemctl reload nginx` (graceful; never restart) |
| write | `/etc/nginx/confirmx-custom-domains/domains.conf` (+ `.bak`, `.tmp`) |

Every argv is checked against this allowlist (`commandAllowed` in `helper-lib.mjs`)
and run with `execFile` (no shell). Hostnames are re-validated strictly
(lowercase ASCII, public TLD, never `confirmx.ai` or below). If `nginx -t` fails the
previous file is restored and Nginx is not reloaded. A run that would drop more
than half of the served domains (and more than 3) is refused unless run manually
with `--allow-mass-removal`. It never touches Asterisk, the firewall, SSH, DNS,
Redis, other Nginx files, application code, or the platform's own certificates.

The internal API endpoints answer only loopback requests without proxy headers
that carry `Authorization: Bearer $CUSTOM_DOMAIN_HELPER_TOKEN`; everything else
gets 404. The API vhost additionally returns 404 for `/internal/`.

## Trust model — why the helper is installed outside the release tree

Releases under `/opt/confirmx/releases/*` are built by the unprivileged `confirmx`
user (`deploy.sh` → `as_confirmx`), and the API/web/sites processes run as that
user. If the root unit executed code from there, anyone who compromised an app
process could edit the helper and get root on the next timer tick.

Therefore:

- The unit executes **only** `/usr/local/lib/confirmx/domains-helper/confirmx-domains-helper.mjs`.
- That directory and its files are `root:root`, not group/other-writable, and so
  are all parent directories — `confirmx` cannot modify, replace or rename them.
- The helper checks this itself at start (`trustedInstallProblems`): if any of its
  files or any parent directory is not root-owned, is group/other-writable, or lies
  under `/opt/confirmx`, `/home`, `/tmp` or `/var/tmp`, it exits (code 3) before
  contacting the API or running anything.
- The copy is updated only by an operator, from a reviewed commit (below) — never
  automatically by a release.
- `UnsetEnvironment=NODE_OPTIONS NODE_PATH`: nothing in the environment can make
  node preload other code. The helper imports only `node:*` built-ins and its
  sibling `helper-lib.mjs` (no `node_modules`).

## Installation (operator, when approved — NOT done by any deploy)

Run as root on the server. `<SHA>` = the reviewed commit.

```bash
# 0. Get the two files from a reviewed commit into a root-only staging dir
#    (never copy from a directory the confirmx user can write while you copy).
#    A fresh root-owned clone — NOT the release under /opt/confirmx (confirmx-owned).
install -d -o root -g root -m 0700 /root/cx-helper-src
git clone --quiet https://github.com/rezainiet/eco-logistics-ai.git /root/cx-helper-src   # same URL as deploy.sh (CONFIRMX_REPO)
git -C /root/cx-helper-src checkout --quiet --detach <SHA>
test "$(git -C /root/cx-helper-src rev-parse HEAD)" = "<SHA>" && echo SHA_OK
sha256sum /root/cx-helper-src/deploy/vps/custom-domains/*.mjs   # compare with the reviewed commit

# 1. Root-owned install directory and files
install -d -o root -g root -m 0755 /usr/local/lib/confirmx
install -d -o root -g root -m 0755 /usr/local/lib/confirmx/domains-helper
install -o root -g root -m 0644 /root/cx-helper-src/deploy/vps/custom-domains/confirmx-domains-helper.mjs \
                               /root/cx-helper-src/deploy/vps/custom-domains/helper-lib.mjs \
        /usr/local/lib/confirmx/domains-helper/

# 2. Units (root-owned, 0644)
install -o root -g root -m 0644 /root/cx-helper-src/deploy/vps/custom-domains/confirmx-domains-helper.service \
                               /root/cx-helper-src/deploy/vps/custom-domains/confirmx-domains-helper.timer \
        /etc/systemd/system/

# 3. Nginx include directory (the helper's only writable Nginx path)
install -d -o root -g root -m 0755 /etc/nginx/confirmx-custom-domains

# 4. Secrets: helper env file (root only)
install -o root -g root -m 0600 /dev/null /etc/confirmx/domains-helper.env
#   CUSTOM_DOMAIN_HELPER_TOKEN=<openssl rand -hex 32>
#   CONFIRMX_API_URL=http://127.0.0.1:4000
```

Then:

5. Install the updated `deploy/vps/nginx/confirmx.conf` (adds the include and the
   `/internal/` block), `nginx -t`, `systemctl reload nginx`.
6. `/etc/confirmx/api.env`: `CUSTOM_DOMAIN_HELPER_TOKEN=` (same value),
   `CUSTOM_DOMAIN_TARGET_IPV4=<server IPv4>`, optionally
   `CUSTOM_DOMAIN_CNAME_TARGET=domains.confirmx.ai` (needs that DNS name),
   `LANDING_CUSTOM_DOMAINS=on`. `/etc/confirmx/sites.env`: `LANDING_CUSTOM_DOMAINS=on`.
7. Restart the API; rebuild + restart sites through a normal release (the Next
   middleware reads `LANDING_CUSTOM_DOMAINS` at build time).
8. `systemctl daemon-reload`, `systemd-analyze verify /etc/systemd/system/confirmx-domains-helper.service`.
9. Dry run (prints the plan, changes nothing):
   `set -a; . /etc/confirmx/domains-helper.env; set +a; node /usr/local/lib/confirmx/domains-helper/confirmx-domains-helper.mjs --dry-run`
10. `systemctl start confirmx-domains-helper.service`, check
    `journalctl -u confirmx-domains-helper -n 50`, then
    `systemctl enable --now confirmx-domains-helper.timer`.

Updating the helper later = repeat steps 0–2 from the new reviewed commit, then
`systemctl daemon-reload`.

### Verification checklist (after install, and after every helper update)

| Check | Command | Expected |
|---|---|---|
| Owner/group/mode of files | `stat -c '%U:%G %a %n' /usr/local/lib/confirmx/domains-helper/*` | `root:root 644` for both `.mjs` |
| Install dirs | `stat -c '%U:%G %a %n' /usr/local/lib/confirmx /usr/local/lib/confirmx/domains-helper` | `root:root 755` |
| Every parent | `namei -l /usr/local/lib/confirmx/domains-helper/helper-lib.mjs` | every line `root root`, no `w` for group/other (Debian's historical `staff`-writable `/usr/local` would fail — fix it first) |
| Unit points at the root copy | `systemctl cat confirmx-domains-helper.service \| grep ^ExecStart` | `/usr/bin/node /usr/local/lib/confirmx/domains-helper/confirmx-domains-helper.mjs` |
| confirmx cannot modify | `sudo -u confirmx sh -c 'test -w /usr/local/lib/confirmx/domains-helper/helper-lib.mjs \|\| test -w /usr/local/lib/confirmx/domains-helper' && echo WRITABLE \|\| echo OK` | `OK` |
| confirmx cannot replace | `sudo -u confirmx touch /usr/local/lib/confirmx/domains-helper/x` | `Permission denied` |
| Env file | `stat -c '%U:%G %a' /etc/confirmx/domains-helper.env` | `root:root 600` |
| Unit/timer files | `stat -c '%U:%G %a %n' /etc/systemd/system/confirmx-domains-helper.*` | `root:root 644` |
| Self-check works | temporarily `chmod g+w` a copy in a scratch root-owned dir and run it | exits 3, `untrusted_install` |

## systemd sandbox (confirmx-domains-helper.service)

| Directive | Why |
|---|---|
| `Type=oneshot`, timer every 2 min | One reconciliation per run; no long-lived root process. |
| `User=root` | certbot writes `/etc/letsencrypt`; `systemctl reload nginx` needs root. |
| `EnvironmentFile=/etc/confirmx/domains-helper.env` | Token + loopback API URL, root-only file. |
| `UnsetEnvironment=NODE_OPTIONS NODE_PATH` | No preloading/other module paths via the environment. |
| `ExecStart=/usr/bin/node /usr/local/lib/confirmx/domains-helper/…` | Root-owned copy only (trust model above). |
| `UMask=0022` | Generated config is 0644, never group/other-writable. |
| `ProtectSystem=strict` | Whole filesystem read-only except the paths below — cannot touch app code, SSH, UFW, Asterisk, Redis, other Nginx files. |
| `ReadWritePaths=/etc/nginx/confirmx-custom-domains` | Its single config file (+ .bak/.tmp). |
| `… /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt` | certbot: certificates, renewal config, locks, logs. |
| `… /var/www/certbot` | certbot webroot: writes the HTTP-01 challenge file. |
| `… /var/log/nginx` | `nginx -t` opens the configured log files for writing; fails on a read-only FS. |
| `… -/var/lib/nginx` | `nginx -t` checks/creates its temp paths (optional: `-` = ignore if absent). |
| (no `/run`) | Not needed: talking to systemd over its unix socket works on a read-only mount. **Staging must confirm** `systemctl reload nginx` works (see below). |
| `ProtectHome=true` | `/root`, `/home` invisible. |
| `PrivateTmp=true` | Own `/tmp` (certbot temp files), nothing shared. |
| `PrivateDevices=true` | Only pseudo devices (`/dev/null`, `/dev/urandom`). |
| `NoNewPrivileges=true` | No setuid escalation from anything it runs (certbot/nginx/systemctl need none). |
| `CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER` | Root keeps only file-permission capabilities: `nginx -t` as root opens `www-data`-owned logs (DAC_OVERRIDE) and may chown temp paths (CHOWN); certbot manages file modes (FOWNER). No NET_ADMIN, SYS_ADMIN, KILL, SETUID… — it cannot change firewall rules, mount, or kill processes. |
| `RestrictSUIDSGID=true` | Cannot create setuid/setgid files. |
| `ProtectKernelTunables/Modules/Logs=true`, `ProtectControlGroups=true`, `ProtectClock=true`, `ProtectHostname=true` | No sysctl, module loading, kernel log, cgroup, clock or hostname changes. |
| `RestrictNamespaces=true`, `RestrictRealtime=true`, `LockPersonality=true`, `SystemCallArchitectures=native` | Closes namespace/realtime/personality/foreign-ABI tricks. |
| `SystemCallFilter=@system-service` | systemd's standard allowlist for service processes (node, python/certbot, nginx -t fit in it). |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` | Unix socket (systemd), IPv4/IPv6 (loopback API + Let's Encrypt over HTTPS). No raw/netlink/packet sockets. IP-level allowlisting is not possible: Let's Encrypt's addresses are not fixed. |
| (no `MemoryDenyWriteExecute`) | Deliberately absent: node's JIT needs W+X memory and would crash. |
| (no `PrivateNetwork`) | It must reach the API (loopback) and Let's Encrypt. |

`apps/api/tests/custom-domain-helper.test.ts` statically asserts the ExecStart
location, the writable-path set, the capability set and the key sandbox
directives, so a future change can't silently point ExecStart back into
`/opt/confirmx/app` or widen the sandbox.

## Staging validation (NOT yet performed — no Nginx/systemd available locally)

What is proven locally: the helper's logic with fake side effects, the command
allowlist, the trust check, the unit file's directives (static), and the
generated config's structure (balanced blocks, known directives, fixed paths).
**Not** proven: that real Nginx 1.24 accepts it, that the sandbox lets certbot and
the reload work. Before production, on a non-production VPS with the same OS:

1. Install per the steps above against a staging API (flag on, test merchant only).
2. `systemd-analyze verify` the unit; `systemctl daemon-reload`.
3. Render a config with a test domain and run `nginx -t` (checks the
   `ssl_session_cache shared:confirmx_tls:10m` reuse and `listen … ssl http2`).
4. Run the helper `--dry-run`, then `systemctl start` it with a domain pointing at
   the staging box, using Let's Encrypt **staging** first (temporarily add
   `--test-cert` in a scratch copy — never in the installed one) to avoid rate limits.
5. Confirm under the sandbox: certbot writes `/etc/letsencrypt`, `nginx -t` passes,
   `systemctl reload nginx` succeeds (if it fails with a read-only error on `/run`,
   add `ReadWritePaths=/run/systemd` only — nothing broader), and existing
   connections survive the reload (graceful).
6. Rollback test: put an invalid line in a copy of the generated config path via a
   deliberately broken snippet, run the helper, confirm `nginx -t` fails, the
   previous `domains.conf` is restored byte-for-byte, and no reload happened.
7. Failure/backoff: point a test domain away, confirm one certbot attempt, Error
   in the dashboard, and no further attempts until `retryAfter`.
8. Trust check: run a copy from a `chmod g+w` directory → exit 3.
9. Confirm `*.confirmx.ai`, app, api and preview still answer as before.

## Rollback

`systemctl disable --now confirmx-domains-helper.timer`, set
`LANDING_CUSTOM_DOMAINS=off` for API and sites (sites: rebuild) and restart them.
Custom hosts then resolve to "not found"; to stop Nginx serving them at all,
empty `/etc/nginx/confirmx-custom-domains/domains.conf`, `nginx -t`, reload.
`*.confirmx.ai`, app, api and preview are unaffected throughout.
