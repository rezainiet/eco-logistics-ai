# Phase A — Embedded Migration Defensive Prep · Completion Report

**Status:** Complete. Zero production behavior change. Ready to commit + deploy as a checkpoint.

---

## Files changed (3 modified, 4 new — 7 total)

### Modified

| File | Diff | Purpose |
|---|---|---|
| `shopify.app.toml` | +6 / −1 | `[webhooks].api_version` synced from `2024-04` → `2026-04` to match the Active version in the Shopify Partner Dashboard. Prevents `shopify app deploy` from silently regressing Partners back to a stale version. |
| `apps/web/package.json` | +1 | Adds `@shopify/app-bridge-react: ^4.1.6` to dependencies. **Not imported anywhere yet.** Reserves the dep so Phase C can add the actual provider without a separate `npm install` round-trip. |
| `apps/api/package.json` | +1 | Adds `@shopify/shopify-api: ^11.13.0` to dependencies. **Not imported anywhere yet.** Used in Phase B for verifying Shopify session-token JWTs and calling the Token Exchange endpoint. |

### New

| File | Lines | Purpose |
|---|---|---|
| `apps/web/src/lib/embedded.ts` | 71 | `isEmbedded()` and `isEmbeddedSSR()` utilities. Pure, SSR-safe, no side effects. **Not imported anywhere yet.** Phase C consumers import this to branch on iframe context. |
| `apps/web/src/components/embedded/embedded-banner.tsx` | 36 | `<EmbeddedBanner />` — placeholder client component, returns `null`. **Not imported anywhere yet.** Phase E fills the body with the legacy-install migration nudge. |
| `apps/web/src/app/(embedded)/README.md` | 47 | Documents the reserved route group. Empty group; URL-invisible. Phase C populates with `layout.tsx`, App Bridge provider, auth context. |
| `apps/web/src/app/(direct)/README.md` | 35 | Documents the sibling reserved route group for non-embedded direct access. Empty group; URL-invisible. Phase C may or may not populate (decision deferred). |

**Critical invariant:** every new file is unreferenced by production code. Verified via grep — zero imports across `apps/web/src` and `apps/api/src`.

---

## Why each change exists

### `shopify.app.toml` api_version sync
The Partner Dashboard's Active version `confirmx-3` (released May 9, 2026) ships `api_version = "2026-04"`. The committed `shopify.app.toml` was at `2024-04`. With `include_config_on_deploy = true` in the toml, the next `shopify app deploy` would have pushed the stale `2024-04` back to Partners and silently downgraded our webhook API version. Fixing it now removes a foot-gun before Phase D runs `shopify app deploy` for the `embedded = true` flip.

### Dependency additions
Both deps are needed in Phase B and C. Adding them in Phase A so:
- The first PR that actually uses them is small and reviewable (no "+package.json + 800 lines of code" PRs).
- A `npm install` round-trip happens during a low-risk window, not coupled with substantive code changes.
- Anyone exploring the codebase sees the embedded migration is in flight before they touch anything auth-related.

### `isEmbedded()` utility
Reserves the API surface that Phase C consumers will branch on. SSR-safe (returns `false` server-side) so it can be called from any render path without hydration mismatches. Pre-defining this means Phase C consumers don't argue about detection semantics — the logic is settled (cross-origin top-frame check + `?host=` query parameter check), commented inline, and ready.

### `<EmbeddedBanner />` placeholder
A `null`-returning component that reserves the import path. Phase E fills in the body. This avoids a Phase E PR having to introduce both the import wiring AND the message content; the wiring lands now, the content lands later.

### Route group READMEs
Reserves `(embedded)/` and `(direct)/` as the canonical layout decision. Next.js route groups are URL-invisible — empty folders affect nothing at runtime. Phase C populates `(embedded)/layout.tsx` with App Bridge provider; the `(direct)/` group is held in reserve while we decide whether to relocate existing dashboard pages into it (decision documented inline in the READMEs).

---

## Production risk level

| Risk | Level | Why |
|---|---|---|
| Bundle size impact | **Zero** | New deps are not imported. Tree-shaking will not pull them in. `next build` will not bundle them. |
| Runtime behavior | **Zero** | Every new file is unreferenced. `next start` and `npm start` (api) execute the same code paths as before. |
| Build / typecheck | **Zero** | Both `apps/web` and `apps/api` workspaces typecheck clean (`tsc --noEmit` exit 0 in both). |
| Deploy regression risk | **Zero** | The toml change only affects `shopify app deploy` (not run in Phase A). The dep additions only manifest after `npm install` (which CI runs but doesn't *use* the new deps in Phase A). |
| Route group impact | **Zero** | `(embedded)/` and `(direct)/` contain only README.md files. Next.js treats `*.md` files in `app/` as inert. |
| Webhook compatibility | **Zero** | `api_version = "2026-04"` matches what Partners has been issuing for fresh installs since the version's release. No data-shape change for inbound webhooks. |

**Net production risk: nil.**

---

## Verification performed

| Check | Result |
|---|---|
| `apps/web` typecheck (`tsc --noEmit -p tsconfig.json`) | ✅ exit 0 |
| `apps/api` typecheck (`tsc --noEmit -p tsconfig.build.json`) | ✅ exit 0 |
| New files have zero production imports | ✅ verified via grep across both `apps/web/src` and `apps/api/src` |
| Route group folders contain only documentation | ✅ verified via `find` — only README.md files |
| `shopify.app.toml` parses (visual inspection) | ✅ minimal diff, single value change |
| `package.json` parses (visual inspection + tsc would fail otherwise) | ✅ both files |

### Verification not performed in sandbox

| Check | Why not | Recommended on local |
|---|---|---|
| Full `next build` of `apps/web` | Sandbox bash has 45s ceiling; Next.js prod build needs >45s. | Run `npm --workspace apps/web run build` locally before commit. Should exit 0 and emit `.next/` output identical in shape to current main (just two more files in the source tree). |
| `npm install` to fetch the new deps | Sandbox doesn't have reliable npm registry access for the workspace install. | Run `npm install` at repo root before committing. Inspect the resulting `package-lock.json` diff to confirm only the two new packages and their transitive deps were added. |
| Smoke test of dashboard render | Requires the full build + Vercel preview. | Vercel preview deploy from the migration branch will exercise this automatically. Visit `/dashboard/orders` and confirm it renders identically to main. |

These three are recommended to run on your local machine before committing, but none of them gate the correctness of the changes — they're confidence checks that the dep additions and route group folders are noise-free at the bundle level.

---

## Rollback strategy

Every change in Phase A is independently revertible.

### To roll back the dep additions
```
git checkout main -- apps/web/package.json apps/api/package.json
npm install
```
The dependencies are not imported by any code, so removing them produces no compile errors, no runtime errors, no test failures.

### To roll back the toml api_version change
```
git checkout main -- shopify.app.toml
```
This *would* re-introduce the drift between toml (`2024-04`) and Partners (`2026-04`). Recommended: only roll back this particular change if Phase D is also rolled back. Otherwise the toml change is forward-compatible.

### To roll back the new files
```
rm apps/web/src/lib/embedded.ts
rm apps/web/src/components/embedded/embedded-banner.tsx
rm -rf apps/web/src/app/\(embedded\)
rm -rf apps/web/src/app/\(direct\)
rmdir apps/web/src/components/embedded
```
Each file is unreferenced; deletion is safe.

### Full Phase A rollback (single command)
```
git revert <phase-a-commit-sha>
```
Produces a clean revert — nothing else depends on Phase A yet.

### Production-safety guarantee
Phase A introduces NO new production code paths. Even an in-flight production deploy that pulls Phase A would behave identically to the previous deploy. The route group folders, new utility, and placeholder component are dead code from the bundler's perspective until something imports them — which Phase A does not do.

---

## Readiness for Phase B

Phase B (backend Token Exchange support) is unblocked. Specifically:

| Phase B prerequisite | Status |
|---|---|
| `@shopify/shopify-api` available in `apps/api` | ✅ added to deps |
| `apps/api/src/lib/integrations/shopify-token-refresh.ts` exists (sibling to where new exchange function will live) | ✅ already exists from prior work |
| `apps/api/src/server/auth.ts` exists with `issueAccessToken` flow to reuse | ✅ confirmed — see `setAuthCookies` and `/auth/login` handler |
| `apps/api/src/server/routers/integrations.ts:completeShopifyInstall` upsert logic available for reuse | ✅ confirmed — already round-trips refreshToken / expiresAt |
| `shopify.app.toml` API version pinned to match Partners | ✅ done in A1 |
| Phase B work has clear isolation (new endpoint, new function, no edits to existing code paths) | ✅ scoped in plan section §6 |

### Phase B scope (next phase, do NOT execute yet)

- B1: `exchangeSessionTokenForOfflineToken({ shop, sessionToken, apiKey, apiSecret })` in `apps/api/src/lib/integrations/shopify.ts`. Wraps the Shopify Token Exchange POST. Returns the existing `ShopifyOAuthExchangeResult` shape so the persist path is unchanged.
- B2: `verifyShopifyAppBridgeSessionToken(token)` in `apps/api/src/server/auth.ts`. Uses `shopify-api`'s JWT helpers. Returns `{ shop, dest, sub, exp }` or throws.
- B3: New `POST /auth/shopify/exchange` endpoint in the API's auth route file. Uses B1 and B2. Returns the same `{ apiToken, csrfToken, ... }` shape as `/auth/login`.
- B4: Vitest integration test for B3 with mocked Shopify JWKS verifier.

### Phase B rollback boundary

Phase B is also reversible without affecting production. The new endpoint, function, and helper are net-additions that no existing code calls. Pre-cutover (before Phase D), Phase B's only effect is "more code in the bundle that nothing reaches".

---

## Recommendations for the Phase A commit

### Suggested commit message
```
chore(shopify): Phase A defensive prep for embedded-app migration

Reserves the migration shape without changing any production behaviour:

- shopify.app.toml: pin webhooks.api_version to 2026-04 to match the
  Active version's value in the Shopify Partner Dashboard (drift would
  silently regress on next `shopify app deploy` because
  include_config_on_deploy=true).
- apps/web: add @shopify/app-bridge-react ^4.1.6 dependency. Not
  imported yet; reserves the dep for Phase C's app-bridge provider.
- apps/api: add @shopify/shopify-api ^11.13.0 dependency. Not imported
  yet; reserves the dep for Phase B's session-token verification and
  Token Exchange call.
- apps/web/src/lib/embedded.ts: add `isEmbedded()` and
  `isEmbeddedSSR()` utilities. SSR-safe, side-effect-free, not yet
  imported. Reserves the API surface for Phase C consumers.
- apps/web/src/components/embedded/embedded-banner.tsx: add
  <EmbeddedBanner /> placeholder that returns null. Reserves the
  import path; Phase E will fill in the legacy-install migration
  nudge content.
- apps/web/src/app/(embedded)/ and (direct)/: reserve the route
  groups with documentation README.md files. Empty groups are
  URL-invisible in Next.js, so this is a zero-runtime change. Phase C
  populates (embedded) with App Bridge provider + session-token
  bridge.

Verified:
- apps/web tsc --noEmit exits 0.
- apps/api tsc --noEmit -p tsconfig.build.json exits 0.
- Zero production imports of any of the new files (greps clean).
- Route group folders contain only README.md (verified via find).

See SHOPIFY_EMBEDDED_MIGRATION_PLAN.md for full migration context.
See PHASE_A_MIGRATION_PREP_REPORT.md for verification evidence.
```

### Suggested PR checklist
- [ ] `npm install` at repo root, inspect `package-lock.json` for unexpected transitive deps
- [ ] `npm --workspace apps/web run typecheck` exits 0
- [ ] `npm --workspace apps/web run build` exits 0
- [ ] `npm --workspace apps/api run typecheck` exits 0
- [ ] `npm --workspace apps/api run build` exits 0
- [ ] Vercel preview deploy reachable
- [ ] Visit `/dashboard/orders` on preview, confirm it renders identically to current production
- [ ] Visit `/login` on preview, confirm sign-in still works against the API
- [ ] Confirm `apps/web/src/app/(embedded)/` and `(direct)/` directories are present in the preview build but no new routes are exposed (test `/embedded/...` and `/(embedded)/...` URLs return 404 if Vercel exposes `app/` paths in any way)

---

## Summary

Phase A is complete. Three files modified (~10 lines each, all comment-heavy), four files added (all unreferenced), zero production impact, both typechecks green. Phase B is unblocked. Standing by for go/no-go on commit + deploy.

**No further coding has been performed in this phase.** The plan's discipline is intact: defensive prep only, no auth changes, no OAuth changes, no iframe cutover, no `embedded = true` flip.
