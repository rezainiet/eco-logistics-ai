# apps/web — Next.js conventions

Inherits root `CLAUDE.md`. App Router, NextAuth, tRPC, Tailwind.

## Routing

### Route-group convention
- `(marketing)` — public landing. **Ships zero auth/tRPC weight.** Never wrap it in `<Providers>`.
- `(auth)` — `/login` and `/signup`. Layout wraps in `<Providers>` and redirects authenticated sessions to `/dashboard`.
- Top-level routes (no parens) — pages that must work for both signed-in and signed-out users (`/forgot-password`, `/reset-password`, `/verify-email`). They each ship their own layout that wraps in `CordonAuthShell` and (where needed) `<Providers>`. They do **NOT** redirect authenticated users.

### The route-group / top-level overlap rule
Next.js refuses to compile when `app/foo/page.tsx` AND `app/(group)/foo/page.tsx` both exist — they resolve to the same `/foo` URL. If you move a page into a route group, **delete the old folder in the same change**. Don't leave a redirect stub: stubs still register as a colliding page and break the build. (We have shipped this bug at least once; see git history for `(auth)/forgot-password` and `(auth)/reset-password`.)

### Auth shell
- One shell for all auth-flavored pages: `components/shell/cordon-auth-shell.tsx`.
- Used by `(auth)/layout.tsx`, `forgot-password/layout.tsx`, `reset-password/layout.tsx`, `payment-success/layout.tsx`, `payment-failed/layout.tsx`, `verify-email-sent/layout.tsx`.
- The legacy `account-shell.tsx` (blue "L" logo, "Logistics" wordmark) is **deprecated** and should be removed. Don't use it for new pages.

## Providers

### Where they live
- **Not in `app/layout.tsx`.** The root layout is html/body + fonts only. Putting providers here ships tRPC/NextAuth into the marketing bundle.
- `<Providers>` (SessionProvider + tRPC + QueryClient) is wrapped at the route-group / segment layout level: `(auth)/layout.tsx`, `dashboard/layout.tsx`, `admin/layout.tsx`, etc.
- Pages that don't need a session (e.g. `/forgot-password` POSTs straight to the API with plain `fetch`) deliberately omit `<Providers>` — keep them light.
- **Hydration trap:** any component that calls `useSession()`, `trpc.x.useQuery()`, or `useQueryClient()` must live under a `<Providers>` ancestor. Wrap them or move the call. `useSession()` outside `SessionProvider` returns `{ status: "loading" }` forever and never hydrates.

## Components
- `components/ui/` — primitives (Button, Card, Input). kebab-case files.
- `components/shell/` — layout chrome (CordonAuthShell, AccountShell *deprecated*, Topbar, Sidebar).
- `components/sidebar/`, `components/onboarding/`, `components/integrations/`, etc. — feature folders. Use kebab-case for new files. PascalCase filenames are a legacy quirk and should not be added.

## Design system
- Tokens live in `tailwind.config.ts` and `globals.css` (CSS variables). Use Tailwind utility classes against tokens (`bg-brand`, `text-fg-muted`).
- Don't introduce a parallel TS palette object. The previous `lib/design-system.ts` (blue-Logistics palette) was deleted on the Cordon rebrand; don't re-create it.
- `landing.module.css` is the only place hex literals are acceptable, and only because the marketing surface runs hot on bundle size and the values are stable.

## Bundling
- The marketing route group ships ~zero JS that touches auth/tRPC — preserve this. If you find yourself adding `import { trpc } from ...` to a `(marketing)` component, stop and re-think.
- Watch out for fat single-use deps (e.g. `framer-motion` for one toast). Replace with CSS / lighter alternative when possible.

## Tests
- E2E: Playwright (`apps/web/e2e/`). Requires the api + web stack running.
- No unit-test runner configured here; logic-heavy code lives in `apps/api`.
