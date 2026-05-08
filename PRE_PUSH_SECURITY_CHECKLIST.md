# PRE_PUSH_SECURITY_CHECKLIST.md

**Run before EVERY push, not just the design-partner launch.**

This checklist is mechanical. The point is to catch a class of mistake
("oops, I committed an .env") that's costly to recover from on a
public GitHub repo. Every check below is grep-able and shell-friendly.

---

## 0. Quick gate (3 commands; 30 seconds)

```bash
# 1. No tracked .env files
git ls-files | grep -E '(^|/)\.env(\..+)?(\.local)?$' && echo "STOP: .env file is tracked" || echo "ok: no tracked .env"

# 2. No tracked secrets-shaped filenames
git ls-files | grep -E '(\.pem|\.key|id_rsa|\.p12|secrets\.|credentials\.)' && echo "STOP: secret-shaped file" || echo "ok: no secret-shaped files"

# 3. No staged secrets in this push (search the diff)
git diff --cached -U0 | grep -iE 'sk_live_|pk_live_|whsec_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|(api|secret|token|password)_?key.{0,5}=.{8,}' \
  && echo "STOP: possible secret in staged diff" \
  || echo "ok: no obvious secret in staged diff"
```

If any of these three echoes "STOP", **do not push**. Investigate.

---

## 1. Tracked-file inspection

### 1.1 `.env` files MUST be gitignored, not tracked

```bash
git ls-files .env apps/web/.env.local 2>&1 | grep -v "^error:"
# Expected output: NOTHING. If you see any path printed, that file is tracked.
```

**Verified at audit time:** `.env` and `apps/web/.env.local` are NOT
tracked. `git ls-files .env` returned `error: pathspec '.env' did not
match any file(s) known to git`.

### 1.2 Example files MAY be tracked, but must contain placeholders

```bash
git ls-files | grep -E '\.env\.example$|\.env\.local\.example$'
# Expected:
#   .env.example
#   apps/web/.env.local.example
```

**Inspect the contents** (run before EACH push, not just first time):

```bash
grep -niE '(secret|password|api[_-]?key|token).{0,5}=' .env.example apps/web/.env.local.example | grep -vE '=$|=replace-me|=your-|=example|=changeme|=local'
# Expected: NO output. Any line returned looks like a real value.
```

### 1.3 Standard credential filename patterns

```bash
git ls-files | grep -iE '(\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed|id_ecdsa|secrets\.|credentials\.|aws_credentials|gcp.*\.json)'
# Expected: NO output.
```

---

## 2. Staged-content secret scan

This catches "I copy-pasted a real key into a test fixture" type
mistakes.

### 2.1 Common provider key prefixes

```bash
git diff --cached -U0 | grep -E 'sk_live_[a-zA-Z0-9]{20,}'                    # Stripe live secret
git diff --cached -U0 | grep -E 'whsec_[a-zA-Z0-9]{20,}'                      # Stripe webhook secret
git diff --cached -U0 | grep -E 'AKIA[0-9A-Z]{16}'                            # AWS access key
git diff --cached -U0 | grep -E 'shpss_[a-f0-9]{32}'                          # Shopify access token
git diff --cached -U0 | grep -E 'shppa_[a-f0-9]{32}'                          # Shopify partner access token
git diff --cached -U0 | grep -E 'gh[pousr]_[A-Za-z0-9_]{30,}'                 # GitHub token
git diff --cached -U0 | grep -E 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.' # JWT-shaped token
```

Each command should return NOTHING. Any hit → investigate the line.

### 2.2 Mongo connection strings

```bash
git diff --cached -U0 | grep -E 'mongodb(\+srv)?://[^:]+:[^@/]+@' | grep -v 'localhost'
# Expected: NO output. Any printed line is a Mongo URI with embedded
# credentials pointing at a remote host.
```

### 2.3 Redis connection strings with auth

```bash
git diff --cached -U0 | grep -E 'redis(s)?://[^:]+:[^@/]+@' | grep -v 'localhost'
# Expected: NO output.
```

### 2.4 Generic "high entropy" string check (manual review)

```bash
git diff --cached -U0 | grep -oE '[A-Za-z0-9+/]{40,}' | sort -u | head -20
```

Inspect the output by eye. Most matches are legitimate (test fixture
ObjectIds, base64-encoded test bodies). A real secret usually looks
"too random and too long for the surrounding context."

---

## 3. File / build-artifact safety

### 3.1 No `node_modules` or `dist` accidentally added

```bash
git diff --cached --name-only | grep -E '(^|/)node_modules/|(^|/)dist/|(^|/)\.next/|(^|/)\.turbo/|(^|/)build/|(^|/)coverage/'
# Expected: NO output.
```

If any path returns, run:

```bash
git rm -r --cached <path>
# Then commit the un-stage. Verify .gitignore covers it.
```

### 3.2 No giant binary blobs

```bash
git diff --cached --stat | awk '$3 > 5000 { print }'
# Anything > 5000 lines in a single file is suspicious.
# Expected for this push: large markdown files (PROJECT_ARCHITECTURE.md
# etc.) are normal. A *.zip, *.tar.gz, or *.png with 30000+ lines is not.
```

### 3.3 Local Claude state

```bash
git diff --cached --name-only | grep -E '\.claude/|\.claude-staging/|claude-cache/'
# Expected: NO output. .claude/settings.local.json must NOT be staged.
```

---

## 4. .gitignore sanity check

Confirm `.gitignore` still covers the ignore-required paths:

```bash
grep -E '^\.env$|^\.env\.local$|^node_modules|^dist$|^\.next$|^\.claude-staging' .gitignore
# Expected: each pattern matches at least one line. If any is missing,
# add it to .gitignore in a separate commit BEFORE proceeding.
```

The current `.gitignore` (verified at audit time) covers:
- `node_modules`
- `.next`
- `dist`
- `build`
- `coverage`
- `.env` / `.env.local` / `.env.*.local`
- `*.secrets`
- `.claude-staging/`
- `*.log`
- `.DS_Store`
- `.turbo`
- `.vercel`
- `*.tsbuildinfo`
- Playwright artifacts

---

## 5. Hooks-disabled push detection

The Cordon repo has pre-commit hooks. **NEVER skip them.**

If a previous run accidentally pushed with `--no-verify` or
`--no-gpg-sign`, the symptom is a commit that didn't go through the
standard format. To check the last 5 commits respected hooks:

```bash
git log -5 --pretty=format:'%H %s' | head -5
# Inspect the format. Any commit message that looks malformed,
# truncated, or is an obvious "fix typo amend" should be re-reviewed.
```

---

## 6. Documentation cross-check

The 13 markdown files in this push reference each other. Confirm no
broken references:

```bash
grep -ohE '`[A-Z_]+\.md`' *.md | sort -u
```

Expected output: every `.md` filename mentioned anywhere should
correspond to a real file. A reference to a non-existent file means
either the file was forgotten or the link is wrong.

---

## 7. Final pre-push gate

Right before `git push`:

```bash
# 1. typecheck
npm --workspace apps/api run typecheck && \
npm --workspace apps/web run typecheck && \
echo "✓ typecheck"

# 2. tests
npm --workspace apps/api test && echo "✓ vitest"

# 3. production build
npm run build && echo "✓ build"
```

All three must pass. If any fail, the push is held.

---

## 8. After-push verification

GitHub now sees the commits. **Within 5 minutes of pushing:**

1. Pull up the GitHub UI for the branch.
2. Sample-inspect at least 3 of the new files for visible secrets.
3. Click the "history" tab. Confirm the commit messages render the way
   you expect.
4. If a tag was pushed, click the Releases sidebar and confirm the tag
   shows up.

If anything looks wrong, **don't panic-rewrite history**. Open an
incident in Slack / playbook the response. Force-pushing to a branch
other people pull from is its own incident.

---

## 9. Public-repo incident response

If a credential makes it past these checks AND lands on a public repo:

1. **Rotate the credential immediately.** This is more important than
   removing the commit. The credential is on the internet the moment
   it pushed; assume it's compromised even if you delete the file
   1 minute later.
2. Use `git filter-repo` (NOT `git filter-branch` — deprecated) to
   purge the secret from history. This is a force-push event; coordinate
   with every contributor.
3. Audit logs on the credential's provider to see if it was used.
4. File a post-mortem in the operational playbook system.
5. Add a regex for the leak shape to the §2 checks above so the same
   class can't recur.

---

## 10. Quick reference — what's "ok to commit" vs "stop"

| Path / pattern | Status |
|---|---|
| `*.env.example` with placeholder values like `replace-me-...` | OK |
| `*.env` (real) | STOP |
| Connection string to `localhost:27017` in a test fixture | OK |
| Connection string to `cluster0.xxxxx.mongodb.net` with embedded password | STOP |
| `mongodb-memory-server` ephemeral URI in test setup | OK |
| API base URL like `https://api.stripe.com/v1` (public host) | OK |
| `STRIPE_SECRET_KEY=sk_test_...` in `.env.example` | OK if `sk_test_` is the literal string `sk_test_replaceme` or similar; STOP if it's a real test-mode key |
| Hardcoded JWT token in a test file | STOP — use a generator |

---

**End of pre-push security checklist.**

*This checklist is meant to be checked into the repo and run from the
shell. Every command above is copy-paste safe; nothing modifies state.*
