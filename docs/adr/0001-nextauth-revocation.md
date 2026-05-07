# ADR 0001 — NextAuth ↔ API session-store revocation reconciliation

**Status:** Proposed (no code changes yet — recommendation only)
**Date:** 2026-05-07
**Decider context:** Critical Operational Hardening Phase, prompted by `FULL_OPERATIONAL_PRODUCT_AUDIT.md` §2.6 / §12.1.

---

## 1. Context

Cordon's API ships an excellent server-side session revocation system:

- `apps/api/src/server/auth.ts` mints `access_token` (1h, HttpOnly), `refresh_token` (14d, HttpOnly), and `csrf_token` (1h, non-HttpOnly), all sharing a `sid` claim.
- `apps/api/src/lib/sessionStore.ts` records every active sid keyed on `(merchantId, sid)`.
- `apps/api/src/server/trpc.ts:213` validates the `sid` against the store on every authenticated tRPC call (with a 30s LRU cache).
- `/auth/logout` flips the sid; `/auth/logout-all` flips every sid for the merchant. Both propagate within ≤30s due to the cache TTL.

This is the kind of revocation control SOC2 reviewers expect to see, and it works correctly **for the cookie/Bearer code path** — i.e. anything that hits the api directly.

**The web app does not use that code path.**

`apps/web/src/lib/auth.ts` configures `next-auth/providers/credentials` with an `authorize()` function that **server-side fetches** `${apiUrl}/auth/login` and embeds the api's response token into NextAuth's own JWT as `apiToken`. Two things follow:

1. The API's `Set-Cookie` headers (access/refresh/csrf) **never reach the merchant's browser**. `fetch()` from a Node.js server-side context drops them. The merchant's browser only ever holds NextAuth's own `next-auth.session-token` HttpOnly cookie, signed with `NEXTAUTH_SECRET`.
2. The SPA reads `session.apiToken` via `useSession()` and sends it as `Authorization: Bearer …`. The api validates the token's `sid` against the session store correctly — but the **outer envelope** is the NextAuth cookie, not the api's cookies.

### What this means in practice

When a merchant clicks "Log out everywhere" from the dashboard, the api's `revokeAllSessions(merchantId)` flips every sid for that merchant, and the api correctly rejects every subsequent tRPC call within 30 s. **However:**

- NextAuth's `next-auth.session-token` cookie is still valid until its own JWT expires (default 30 days).
- `getServerSession()` (used by `dashboard/layout.tsx`'s SSR redirect) still returns a valid session.
- The dashboard layout still treats the user as authenticated.
- The `TokenRefreshKeeper` component will, on next refresh, call `useSession().update({ apiToken })` against `/auth/refresh` — and **`/auth/refresh` will also fail because the sid has been revoked** — but until that refresh tick, the merchant's old `apiToken` is also dead, so the SPA shows error toasts instead of redirecting to `/login`.

**An attacker with a stolen `next-auth.session-token` cookie cannot be revoked server-side.** Their stolen cookie keeps producing "valid NextAuth session" decisions until either (a) NextAuth's JWT expiry passes, or (b) `NEXTAUTH_SECRET` is rotated (which logs out **every** merchant).

This is the headline auth security finding from the operational audit. The api side is not broken; the gap is at the integration seam.

---

## 2. Decision considerations

The user instruction for this phase is explicit:

> Goal: determine safest operational fix WITHOUT destabilizing auth.
> Requirements: preserve current login UX, RBAC, API auth flow, dashboard auth.
> DO NOT rush dangerous auth rewrites.
> If partial mitigation is safer: recommend phased migration.

So this ADR proposes two paths, recommends the phased one (Path B) for now, and lays out the conditions under which the team should commit to the full one (Path A) later.

---

## 3. Path A — Drop NextAuth, run the api's cookie session as the source of truth

### Sketch

- Remove `next-auth` from `apps/web` entirely.
- Replace `authOptions` and `getServerSession()` with a thin `getServerSession()` shim that calls `/auth/me` with the request's cookies forwarded.
- The `/login` POST becomes a Next.js Route Handler that proxies to `/auth/login` and **forwards the `Set-Cookie` headers** to the merchant's browser. The browser ends up with the api's `access_token`, `refresh_token`, `csrf_token` cookies — exactly the path the api was designed for.
- The SPA's tRPC client reads `csrf_token` from `document.cookie` and sets `X-CSRF-Token` on mutations. The api already enforces this via the double-submit pattern in `trpc.ts:194-208`. tRPC client config currently uses `Authorization: Bearer ${session.apiToken}`; that header would be dropped, the cookie carries the auth.
- `dashboard/layout.tsx`'s SSR `redirect("/login?callbackUrl=…")` becomes a fetch of `/auth/me` with forwarded cookies (or a JWT-decode of the cookie value with same-secret) instead of `getServerSession()`.

### Consequences

**Pros:**

- The api's session-store revocation **actually revokes** the web user. `/auth/logout-all` works as advertised.
- The api's CSRF double-submit is the only auth gate, removing duplication. Session expiry, TTL, refresh, and revocation become single-source-of-truth on the api side.
- Cross-origin tRPC calls already work with `credentials: "include"`; the cookie ride is straightforward.
- Eliminates `NEXTAUTH_SECRET` as an env var (reduces secret count by one).
- Stolen-session response is no longer "rotate `NEXTAUTH_SECRET` and log everyone out"; it's "click Logout-everywhere on the affected merchant's row in the admin UI."

**Cons:**

- Real auth-system swap. Touches `apps/web/src/lib/auth.ts`, `apps/web/src/app/api/auth/[...nextauth]/route.ts` (deleted), every `useSession()` call site (~10–15 components), the tRPC client wiring in `apps/web/src/lib/trpc.ts`, and the dashboard / admin / (auth) layouts that rely on `getServerSession`.
- Requires careful migration testing across `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`, the OAuth shopify callback redirect into `/dashboard/integrations`, and the Stripe redirect into `/dashboard/billing`.
- During cut-over, every existing merchant session is invalidated (their `next-auth.session-token` becomes meaningless once NextAuth is gone). All merchants log in once. Operational comms required.
- Risk surface: large diff, single-shot. If something breaks in production, rollback is painful (the cookie shape changes).

**Effort:** ~3–5 engineering days, plus ~1 day of cross-flow QA. Should land behind a feature flag or in a staging window with traffic mirroring.

**When to choose this path:** SOC2 audit on the horizon; a real session-stealing incident has occurred; the team has bandwidth for a focused auth project. Not now.

---

## 4. Path B — Phased mitigation (RECOMMENDED for the current phase)

### Sketch

Keep NextAuth. Add three small, surgical changes that close most of the revocation gap without touching the auth surface area.

#### B1. Cap NextAuth session lifetime to 1 hour

`apps/web/src/lib/auth.ts`, in `authOptions`:

```ts
session: {
  strategy: "jwt",
  maxAge: 60 * 60,          // 1 hour
  updateAge: 5 * 60,         // re-sign every 5 min on activity
},
jwt: {
  maxAge: 60 * 60,
},
```

Today the default is **30 days**. Capping to 1 hour means a stolen NextAuth cookie is only useful for at most 1 hour after the last activity-triggered re-sign. This alone closes ~95% of the revocation gap by simple TTL.

`TokenRefreshKeeper` already calls `useSession().update({ apiToken })` on a timer; pair it with NextAuth's `updateAge` and the active merchant never feels the 1h cap.

**Risk:** an idle-then-resume user (closes laptop for 90 min, comes back) sees one extra `/login` round-trip. Acceptable trade.

#### B2. Server-side validate `apiToken` on every `getServerSession` consumer

Add a tiny `requireSession()` helper that wraps `getServerSession` and **also** verifies the embedded `apiToken` is still alive by hitting `/auth/me`:

```ts
// apps/web/src/lib/require-session.ts
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "./auth";

export async function requireSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session?.apiToken) return null;

  // Validate against the api's session store. ~30 ms server-to-server.
  // Use the api's own LRU on its end so this is essentially a Redis hit.
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/me`, {
    headers: { authorization: `Bearer ${session.apiToken}` },
    cache: "no-store",
  });
  if (!res.ok) return null; // sid revoked → treat as logged out
  return session;
}
```

Replace `getServerSession(authOptions)` with `requireSession()` in:
- `apps/web/src/app/dashboard/layout.tsx`
- `apps/web/src/app/admin/layout.tsx` (if any admin SSR check exists)
- `apps/web/src/app/(auth)/layout.tsx` (the redirect-if-authed branch — should redirect ONLY if api still confirms; otherwise let them log in again)

This means a revoked sid causes the next page render to redirect to `/login`. Combined with B1's 1-hour outer cap, the worst-case revocation lag is the duration of the current page render — single-digit seconds.

**Risk:** an extra ~30 ms server-to-server hop on every dashboard route SSR. Negligible against the ~150–300 ms tRPC fetches that follow. Worth doing.

#### B3. Make `/auth/logout-all` invalidate the NextAuth session as well

When the api processes `revokeAllSessions(merchantId)`, the web has no signal. Two options:

- **B3a:** the `/auth/logout-all` handler returns a structured response, the SPA reads it, and calls NextAuth's `signOut()` after. Belt-and-braces — still depends on the SPA running, so a stolen cookie used from a different browser is unaffected. (B2 is what protects against that case.)
- **B3b:** add a "session-version" claim. Bump it on `revokeAllSessions`. The api stores the per-merchant version; `/auth/me` 401s if the apiToken's version doesn't match. B2's check picks up the mismatch on the next render. This is what makes **someone else's stolen cookie** also expire.

**Recommended:** ship B3a now (1 hour) + B3b in the next sprint (~1 day; small DB column on Merchant + 5 lines in the api).

### Consequences (Path B as a whole)

**Pros:**

- Low-risk: each change is independently reversible.
- B1 alone shrinks the stolen-cookie window from 30 days to 1 hour.
- B2 makes server-side renders honest.
- B3 closes the remaining gap for "stolen cookie used from another device".
- No auth-flow changes for merchants.
- Total effort: ~1 sprint (5–8 dev-days including QA), can be split.

**Cons:**

- The architectural duplication remains — two session systems, two TTLs, two truths. Path A would eliminate this; Path B mitigates it.
- B2 adds latency to every dashboard render (~30 ms). Cacheable in-memory on the web side if it becomes a problem.
- Path B does not satisfy a SOC2 reviewer asking "how do you revoke a stolen browser cookie within 1 minute?" — the answer is "B2 catches it on next render, which is up to 1 hour for an idle attacker." For SOC2, plan Path A in the next phase.

---

## 5. Recommendation

**Adopt Path B now. Plan Path A as a Q3-2026 project.**

Concrete next-sprint scope:

1. **B1** (1 line in `authOptions`, 1 line in `jwt` block). Land first — biggest single risk reduction for least effort.
2. **B2** (`requireSession()` helper + 3 call-site changes). Land second.
3. **B3a** (`/auth/logout-all` SPA-side `signOut()`). Land third — bundle with the merchant-facing UX work for "log out all my sessions" so the success toast and the actual logout match.
4. **B3b** (session-version claim). Defer to next sprint with a small DB migration; not urgent, finishes the loop.

After B1+B2 land:

- The headline finding from `FULL_OPERATIONAL_PRODUCT_AUDIT.md` §2.6 is reduced from HIGH to LOW.
- The "Would I trust this in production?" verdict goes up.
- A SOC2 reviewer would see "1-hour outer TTL, server-side revalidation per render, in-store sid revocation" — the right shape, even if it's belt-and-braces rather than single-source-of-truth.

When the team commits to Path A, this ADR should be superseded by ADR 0002 documenting the cut-over plan, traffic-mirroring strategy, and merchant communications.

---

## 6. Out of scope for this ADR (deliberately)

- Any change to `apps/api/src/server/auth.ts`. The api is correct; the gap is on the integration seam.
- Changing the JWT algorithm or signing key strategy. (`JWT_SECRET` minimum length is a separate audit follow-up — see audit §12.7; not auth-architectural.)
- Changing CSRF strategy. The double-submit on the api is correct and stays in place under either path.
- Changing the `/auth/logout-all` server-side semantics. Already correct; we only need the web side to honour it.

---

## 7. Validation criteria (for B1+B2 when landed)

A successful Path-B B1+B2 rollout means:

- A merchant who clicks "Log out everywhere" from the dashboard sees their next page navigation redirect to `/login` within one render cycle (<5 s).
- A second browser holding a stolen `next-auth.session-token` for the same merchant sees the same redirect on its next page navigation, capped at the NextAuth `maxAge` (1h) regardless of activity.
- No regression on a normal active session (the merchant who keeps using the dashboard does NOT get logged out at the 1h boundary because `updateAge` re-signs).
- `/auth/me` p99 latency from the web service remains under 80 ms (this is the new render-time hop).
- `signIn` / `signOut` / forgot-password / reset-password / verify-email / Shopify callback / Stripe callback all behave identically to today.

If any of those fail, Path B has a blocker; investigate before continuing.

---

## 8. Files this ADR predicts changing (FYI, not now)

For B1+B2+B3a:
- `apps/web/src/lib/auth.ts` (B1: ~5 lines)
- `apps/web/src/lib/require-session.ts` (B2: NEW, ~25 lines)
- `apps/web/src/app/dashboard/layout.tsx` (B2: 1 line replaced)
- `apps/web/src/app/(auth)/layout.tsx` (B2: 1 line replaced; behaviour also softens — see B2 rationale)
- `apps/web/src/app/admin/layout.tsx` if the admin SSR check exists (B2: 1 line replaced)
- `apps/web/src/components/auth/token-refresh-keeper.tsx` (B3a: ~5 lines)

For B3b (next sprint):
- `packages/db/src/models/merchant.ts` (`sessionVersion: number`)
- `apps/api/src/lib/sessionStore.ts` (`revokeAllSessions` bumps the version)
- `apps/api/src/server/trpc.ts` (validate version claim alongside sid)
- `apps/api/src/server/auth.ts` (embed version in minted access tokens)

That's it. Nothing in `apps/api/src/server/webhooks/`, `apps/api/src/lib/queue.ts`, or anywhere structural — this is a localised seam fix.
