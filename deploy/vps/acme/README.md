# Wildcard TLS for merchant landing pages (`*.confirmx.ai`)

Let's Encrypt only issues wildcard certificates over DNS-01, so these certbot
hooks write the `_acme-challenge` TXT record through the Hostinger DNS API.

| File | Installed as | Purpose |
|---|---|---|
| `confirmx-hostinger-dns` | `/usr/local/sbin/` (root, 0700) | `add-txt` / `del-txt` / `wait-txt`; only `_underscore` names, never overwrites other records |
| `confirmx-acme-dns-auth` | `/usr/local/sbin/` (root, 0700) | certbot `--manual-auth-hook` |
| `confirmx-acme-dns-cleanup` | `/usr/local/sbin/` (root, 0700) | certbot `--manual-cleanup-hook` |

The API token lives in `/etc/confirmx/hostinger.token` (root, 0600, never in git,
never printed). Create it in hPanel → API; it needs DNS access to `confirmx.ai`.

## Issue (once)

```bash
certbot certonly --manual --preferred-challenges dns \
  --manual-auth-hook /usr/local/sbin/confirmx-acme-dns-auth \
  --manual-cleanup-hook /usr/local/sbin/confirmx-acme-dns-cleanup \
  --cert-name wildcard.confirmx.ai -d '*.confirmx.ai' --key-type ecdsa
```

The hooks are stored in `/etc/letsencrypt/renewal/wildcard.confirmx.ai.conf`, so
`certbot.timer` renews it unattended; the existing deploy hook reloads Nginx.

## Verify renewal

```bash
certbot renew --cert-name wildcard.confirmx.ai --dry-run
```

The challenge TXT uses TTL 60. When dry runs are repeated back to back, wait for
at least that TTL; otherwise Let's Encrypt's resolvers may still serve the previous
value and report "Incorrect TXT record".
