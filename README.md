# Ecommerce Logistics

Unified logistics management SaaS platform for e-commerce merchants.

## Stack

| Layer      | Technology                                   |
| ---------- | -------------------------------------------- |
| Frontend   | Next.js 14 (App Router), TypeScript, Tailwind, shadcn/ui |
| Backend    | Express, tRPC, Node.js 20+                   |
| Database   | MongoDB with Mongoose                        |
| Cache      | Redis (ioredis)                              |
| Auth       | NextAuth.js (Credentials) + JWT to backend   |
| Workspaces | npm workspaces                               |

## Folder Structure

```
ecommerce-logistics/
├── apps/
│   ├── web/              Next.js frontend (port 3000)
│   └── api/              Express + tRPC backend (port 4000)
├── packages/
│   ├── types/            Shared TypeScript types
│   ├── db/               Shared Mongoose models
│   └── config/           Shared Tailwind preset
├── docker-compose.yml    MongoDB + Redis
├── .env.example          Root env template
└── package.json          Workspace root
```

## Prerequisites

- Node.js 20+
- npm 10+
- Docker Desktop (for MongoDB + Redis)

## Setup

1. **Install dependencies** (from the repo root):

   ```bash
   npm install
   ```

2. **Create env files:**

   ```bash
   cp .env.example .env
   cp apps/web/.env.local.example apps/web/.env.local
   ```

   Generate a real secret for `JWT_SECRET` and `NEXTAUTH_SECRET` (e.g. `openssl rand -base64 32`).

3. **Start MongoDB + Redis:**

   ```bash
   docker compose up -d
   ```

4. **Run both apps in dev mode:**

   ```bash
   npm run dev
   ```

   - Web: http://localhost:3001
   - API: http://localhost:4000 (tRPC at `/trpc`, health at `/health`)

## Scripts

| Command              | What it does                                |
| -------------------- | ------------------------------------------- |
| `npm run dev`        | Runs `apps/web` and `apps/api` in parallel  |
| `npm run dev:web`    | Web only                                    |
| `npm run dev:api`    | API only                                    |
| `npm run build`      | Build every workspace that has a build step |
| `npm run typecheck`  | Typecheck every workspace                   |
| `npm run lint`       | Lint every workspace                        |

## Auth Flow

- `apps/web` uses NextAuth's Credentials provider.
- On login, NextAuth POSTs `{email, password}` to `apps/api` at `POST /auth/login`.
- The API verifies against the `Merchant` collection (bcrypt) and returns a signed JWT.
- NextAuth stores the JWT in the session; the tRPC client forwards it in `Authorization: Bearer …`.
- `POST /auth/signup` creates a new merchant with a hashed password.

## Adding shadcn/ui Components

```bash
cd apps/web
npx shadcn@latest add <component>
```

`components.json`, the Tailwind theme tokens, and `cn()` helper are already wired up.

## Environment Variables

Root `.env` (used by `apps/api`):

| Variable       | Purpose                                        |
| -------------- | ---------------------------------------------- |
| `API_PORT`     | API listen port (default `4000`)               |
| `MONGODB_URI`  | MongoDB connection string                      |
| `REDIS_URL`    | Redis connection string                        |
| `JWT_SECRET`   | Signing secret for API-issued JWTs             |
| `CORS_ORIGIN`  | Allowed origin for the web app                 |

`apps/web/.env.local`:

| Variable              | Purpose                           |
| --------------------- | --------------------------------- |
| `NEXT_PUBLIC_API_URL` | Base URL the browser uses for API |
| `NEXTAUTH_URL`        | Canonical web URL for NextAuth    |
| `NEXTAUTH_SECRET`     | NextAuth session encryption key   |
