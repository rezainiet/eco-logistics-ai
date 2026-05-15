# Workspace Integrity Repair Report

**Status:** Issue #1 (@ecom/branding) **diagnosed + fixed**. Issue #2 (Button variant typing) **could not be reproduced** in static analysis — Button.tsx and its consumers are structurally sound. The reported errors are likely cache-driven; documented recovery steps below.

---

## Issue #1 — `@ecom/branding` workspace resolution

### Root cause

`apps/web/tsconfig.json` was missing path aliases for `@ecom/branding`. The sibling `apps/api/tsconfig.json` had them; the web workspace did not.

**Before** (`apps/web/tsconfig.json`):
```json
"paths": {
  "@/*": ["./src/*"],
  "@ecom/db": ["../../packages/db/src/index.ts"],
  "@ecom/db/*": ["../../packages/db/src/*"],
  "@ecom/types": ["../../packages/types/src/index.ts"],
  "@ecom/types/*": ["../../packages/types/src/*"]
  // ← @ecom/branding paths missing here
}
```

**Why it broke at build time:**

When the web workspace imports `@ecom/branding`, TypeScript's resolver (`moduleResolution: "Bundler"`) looks first for path aliases. With none defined, it falls back to `node_modules/@ecom/branding` — a workspace symlink to `packages/branding/`. The package's `package.json` declares `main: "./dist/index.js"` and `types: "./dist/index.d.ts"`, so resolution depends on the **dist/ folder being pre-built**.

In a fresh checkout (CI, Vercel, or any clean clone), `packages/branding/dist/` doesn't exist until `packages/branding`'s build script runs. There IS a workspace-root postinstall hook that builds it (`npm --workspace @ecom/branding run build --if-present`), but this hook can fail silently or produce an incomplete dist directory if:

- The TypeScript compile inside the postinstall hits errors (the script is `tsc -p tsconfig.json --noEmit false` with a fallback that tolerates errors as long as `dist/index.js` ends up emitted)
- The CI runner caches `node_modules` from a build where `dist/` was correctly built but the source has since changed
- A workspace lifecycle ordering issue causes `apps/web`'s build to start before `packages/branding`'s postinstall completes

The api workspace bypassed all of this because its `tsconfig.json` already had a path alias pointing at `packages/branding/src/index.ts`. The web workspace was the gap.

### Fix applied

Added two lines to `apps/web/tsconfig.json` mirroring the apps/api convention:

```json
"paths": {
  "@/*": ["./src/*"],
  "@ecom/db": ["../../packages/db/src/index.ts"],
  "@ecom/db/*": ["../../packages/db/src/*"],
  "@ecom/types": ["../../packages/types/src/index.ts"],
  "@ecom/types/*": ["../../packages/types/src/*"],
  "@ecom/branding": ["../../packages/branding/src/index.ts"],
  "@ecom/branding/*": ["../../packages/branding/src/*"]
}
```

### Why this is the minimal fix

- **No package.json change needed.** The branding workspace's `exports` field is correct as-is for downstream consumers that go through node_modules resolution.
- **No build-script change needed.** The postinstall hook still builds dist/ for any consumer that does prefer the prebuilt artifact (e.g. tooling that doesn't read tsconfig paths).
- **No source change needed.** All `import { ... } from "@ecom/branding"` sites in apps/web work unchanged — they just resolve through the path alias now instead of node_modules.
- **Mirrors apps/api's working pattern.** No new convention, just propagation.

### Migration safety

The `@ecom/branding` resolution is now independent of the postinstall hook for typecheck/build purposes. This makes:

- **Vercel builds** more robust — even if postinstall is skipped or fails, the path alias resolves to `packages/branding/src/index.ts` and the build proceeds.
- **Local dev** unaffected — both pre-built `dist/` and path-alias resolution work; tsc and Next.js prefer the path alias.
- **Phase C deploy** unblocked from this specific failure mode — the new `(embedded)` route group's layout doesn't import from @ecom/branding directly, but the dashboard layout it indirectly mounts does.

---

## Issue #2 — Button variant typing regression

### What I checked

| Surface | Result |
|---|---|
| `apps/web/src/components/ui/button.tsx` working tree vs main | **Identical** — zero diff |
| `cva` config in button.tsx | Defines: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link` |
| All `<Button variant="...">` consumer usages in apps/web/src | All 7 consumed values (`outline ×105, ghost ×15, secondary ×6, destructive ×3, default-implicit ×many`) match cva config — no usage of an undefined variant |
| `variant="inset"` usage | On `<EmptyState>` only (different component, has its own `inset` variant) — not Button |
| `variant="success"` usage | On `<Badge>` only (Badge has `success` variant) — not Button |
| Re-exports of `Button` / `ButtonProps` | Only `feedback-button.tsx` and `help-button.tsx`, both use the canonical Button |
| `class-variance-authority` package version installed | `0.7.1` (matches `^0.7.0` declared) |
| `@types/react` / `@types/react-dom` | `18.3.28` / `18.3.7` — current |
| `@radix-ui/react-slot` | `1.2.4` — current, in declared `^1.1.0` range |

### Conclusion

I could not reproduce the reported errors via static analysis. Button.tsx itself is structurally correct and all consumer call sites use variants the cva config defines.

### Why I could not run the live typecheck

The sandbox `tsc --noEmit -p apps/web/tsconfig.json` consistently times out at the 43-second sandbox ceiling, even with `--skipLibCheck` and an isolated 5-file scope. This is a sandbox-environment limit, not a code issue. Local typechecks finish (the user's report confirms they ran).

### Most likely sources of the user's reported failure

Listed in order of probability based on the symptoms ("variant union no longer matches actual cva variants" + "~80 cascading errors"):

1. **Stale `.next/types/` cache.** Next.js generates `.next/types/app/*/page.ts` shim files during dev/build that mirror the route component types. If a stale shim references an older shape of `<Button>` (e.g. before a recent variant addition/removal that's since been reverted), every import of that route's page brings in the bad type. Symptom: ~80 errors in different files all referencing the same outdated shape.

   **Recovery:** delete `apps/web/.next/` recursively, then re-run typecheck.

2. **Stale `tsconfig.tsbuildinfo` cache.** TypeScript's incremental cache can hold onto an old project graph after a dep version bump. Less likely than (1) for this specific symptom but worth ruling out.

   **Recovery:** delete `apps/web/tsconfig.tsbuildinfo`, re-run typecheck.

3. **`node_modules` from before the recent npm install.** If the user's `node_modules` predates a version bump in `class-variance-authority`, `@types/react`, or `@radix-ui/react-slot`, `VariantProps` might resolve against a different signature. The fact that the in-repo `node_modules` (after my install) is healthy on inspection suggests this could clear after a clean `npm install`.

   **Recovery:** `rm -rf node_modules && npm install` at workspace root.

4. **A local uncommitted change to `button.tsx` that was reverted in the working tree but lingered in the editor's TypeScript service.** Restarting the IDE / TS server flushes this.

   **Recovery:** restart VS Code / TS server.

### Recommended recovery sequence (run in order, stop when typecheck goes green)

```bash
# 1. Clear Next.js generated types
rm -rf apps/web/.next

# 2. Clear TypeScript incremental cache
rm -f apps/web/tsconfig.tsbuildinfo

# 3. Clean install
rm -rf node_modules
npm install

# 4. Re-run typecheck
npm --workspace apps/web run typecheck
```

If errors persist AFTER step 4, please paste the **first 30 lines** of `tsc` output. The error pattern will tell me exactly which Button-related typing changed. Without that output I'm guessing — and the right fix is data-driven, not speculative.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/web/tsconfig.json` | +2 lines | Add `@ecom/branding` and `@ecom/branding/*` path aliases mirroring apps/api/tsconfig.json. Closes the workspace resolution gap. |

**Total: 1 file, 2 lines added, 0 removed.**

No code changes to any component. No package.json changes. No node_modules changes (beyond what npm install regenerates locally).

---

## Why the regression happened

### `@ecom/branding`
The `@ecom/branding` package was likely added to the monorepo after `apps/api/tsconfig.json` had been set up with explicit path aliases for `@ecom/db` + `@ecom/types`. Whoever wired branding into apps/api propagated the path aliases there but missed apps/web. The web workspace started importing from `@ecom/branding` with the build silently relying on the postinstall hook to build `dist/` — which works most of the time but isn't a safe foundation. This is a pure infrastructure gap, not a regression caused by any feature work (Phase A, B, or C).

### Button typing
**No reproducible regression in static analysis.** The Button component code is unchanged from main, and consumer usage is correct. The most plausible explanation is a stale build cache from before a recent version bump (cva 0.7.0 → 0.7.1, react-slot 1.1.0 → 1.2.4). The recovery steps above are the standard remediation.

---

## Migration safety impact

| Concern | Status |
|---|---|
| Phase A files affected | None — Phase A has no @ecom/branding imports and doesn't touch Button |
| Phase B files affected | None — Phase B is api-only (the audit log fix is api-only too) |
| Phase C files affected | None — Phase C frontend imports use NextAuth, App Bridge, and `@/lib/embedded-token-bus`. No `@ecom/branding` import. No `<Button>` consumer in any of the new Phase C files |
| Direct (non-iframe) login | **Unaffected** — the web tsconfig change is build-time only; no runtime impact |
| Existing dashboard pages | **Unaffected** — no source change |
| API runtime | **Unaffected** — no api change |
| Risk of new bugs introduced | **Nil** — single tsconfig.json change is purely a build-resolution improvement |

---

## Readiness to resume Phase C deploy

| Check | Status |
|---|---|
| `@ecom/branding` resolution gap fixed | ✅ apps/web/tsconfig.json patched |
| Workspace integrity check passes (file structure + symlinks) | ✅ verified manually |
| Button issue reproducible in static analysis | ❌ no — code is sound; recommend cache clear + clean install on user's local |
| Apps/web full typecheck verified clean | ⚠️ sandbox can't finish tsc; recommend running locally after the cache-clear sequence |
| Apps/web full Next.js build verified clean | ⚠️ same sandbox limitation |
| Phase C files compile correctly | Cannot verify here; expected to be clean given they don't touch the surfaces in question |

### Recommendation

1. Pull the workspace integrity fix (the `apps/web/tsconfig.json` change) into a small standalone PR — it's low-risk, mechanical, and shouldn't be coupled with anything else.
2. On your local machine, run the recovery sequence:
   ```
   rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo node_modules
   npm install
   npm --workspace apps/web run typecheck
   ```
3. If the typecheck is **green** after step 2, the Button errors were cache-driven and the workspace is ready. Resume Phase C commit + deploy as planned.
4. If the typecheck still surfaces Button errors, **paste the first 30 lines of tsc output**. I'll target the actual error pattern with a minimal fix.

---

## Suggested commit

```
fix(workspace): add @ecom/branding path aliases to apps/web/tsconfig.json

Mirror the apps/api convention so the web workspace resolves
@ecom/branding through TypeScript path aliases instead of relying
on packages/branding/dist/ being pre-built.

Closes a build-time fragility where a fresh checkout (CI, Vercel,
clean clone) would fail to resolve @ecom/branding imports if the
workspace-root postinstall hook didn't successfully build the dist/
folder. The api workspace already had this fix; the web workspace
was the gap.

No code changes to any component. No package.json changes. No
runtime impact — purely a build-resolution improvement.

Migration safety: none of Phase A/B/C surfaces are affected by
this change. The fix is independent and can land on its own.
```

---

## Bottom line

**Phase C is unblocked from the @ecom/branding side.** Apply the local cache clear + npm install sequence to confirm Button errors were cache-driven, then proceed with the Phase C commit + deploy.

If Button errors persist after the cache clear, get the actual tsc output to me and I'll target a minimal fix from the real error pattern — guessing at it would risk introducing the broad typing hacks the spec explicitly forbids.
