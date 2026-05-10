# `(direct)` route group — reserved for non-embedded dashboard access

This route group is empty by design (Phase A of the embedded-app migration).

## Why it exists now

Sibling to `apps/web/src/app/(embedded)/`. Next.js route groups are URL-invisible, so adding this folder while empty does not affect routing.

The "direct" path is the standalone, non-iframe access route at `https://app.confirmx.ai/dashboard/*`. After the embedded migration completes, two parallel access modes exist:

- **Embedded** — merchant inside Shopify Admin's iframe; auth is App Bridge → session token exchange.
- **Direct** — ops, support, or merchant accessing the dashboard outside Shopify; auth is NextAuth credentials (email + password) — i.e. exactly today's flow.

## Phase A intent

Reserve the path. No files inside yet. The current dashboard tree at `app/dashboard/*` continues to serve all traffic exactly as today — Phase A explicitly does not move existing pages.

## Phase C+ migration plan for this group

Two options under consideration; the call has not been made yet:

**Option 1 — Move existing pages.** `app/dashboard/*` becomes `app/(direct)/dashboard/*`. URLs are unchanged (route groups are invisible). Pro: explicit path-level isolation between direct and embedded. Con: a lot of file moves, risk surface for merge conflicts, and every `page.tsx` shows up in PRs that move it.

**Option 2 — Keep existing pages where they are.** `app/dashboard/*` stays as the direct path; `(embedded)/dashboard/*` is the embedded path with its own layout that wraps the same page components. Pro: minimal disruption, current pages keep working. Con: the "direct" path is just `dashboard/`, not `(direct)/dashboard/`, which is slightly less self-documenting.

The migration plan recommends Option 2 — minimum churn, clearer rollback. This `(direct)/` directory is reserved either way; if Option 2 wins, this folder gets deleted in Phase F cleanup. If Option 1 wins, `(direct)/` becomes the new home for the entire dashboard tree.

## Rules for files inside this group (when populated)

- **Never import from `(embedded)/`**. Cross-group imports defeat the isolation the migration plan depends on.
- **Use NextAuth (`useSession`, `signIn`, `signOut`) freely**. This is the auth surface for direct-access merchants.
- **No App Bridge imports.** This path runs outside Shopify Admin.
