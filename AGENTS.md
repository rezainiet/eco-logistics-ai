# Cordon — repo conventions

This is the monorepo root. Per-app conventions live in `apps/web/AGENTS.md` and `apps/api/AGENTS.md` and override anything here.

## Layout
- `apps/web` — Next.js 14 App Router, NextAuth, tRPC client, Tailwind. Port 3001 in dev.
- `apps/api` — Express + tRPC server, BullMQ workers, Mongoose. Port 4000 in dev.
- `packages/db` — Mongoose models. Consumed via `@ecom/db` (built to `dist/`).
- `packages/types` — shared TS types + tRPC `AppRouter` re-export. Consumed via `@ecom/types`.
- `packages/config` — shared TS/ESLint config.

## Workspaces
- npm workspaces (`package.json` `workspaces: ["apps/*", "packages/*"]`).
- `npm run dev` boots api + web in parallel. From the root, never `cd apps/web && npm install` — use `npm --workspace apps/web ...`.

## Build artifacts
- `apps/api/dist`, `packages/*/dist`, `apps/web/.next`, `apps/web/test-results`, `apps/web/tsconfig.tsbuildinfo` are gitignored. **Don't commit them.** If `@ecom/db` import fails after a clean checkout, run `npm --workspace packages/db run build` (and same for `packages/types`).
- `.Codex-staging/` is gitignored. Use it for one-shot scratch only; never reference its files from the build.

## Commits
- Don't commit per-commit message bodies (`commit-msg.txt`, `_commit-message.txt`) — use HEREDOC or `git commit -m`.
- Don't commit one-off helper scripts (`_commit-and-push.bat`, `push-fix-N.bat`). Use rebases.

## Stuck-build first aid
If `next build` reports route conflicts ("two parallel pages resolve to the same path"), look for stub `page.tsx` files in route groups created by aborted refactors — see `apps/web/AGENTS.md` § Routing.
