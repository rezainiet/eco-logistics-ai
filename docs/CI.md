# CI & branch protection (private beta)

Minimal, startup-sized merge safety. Two workflows:

| Workflow | Jobs | Role |
|---|---|---|
| `ci.yml` | **API strict build**, **Web typecheck**, **API tests** | Fast, deterministic — **required** to merge. |
| `e2e.yml` | Golden path (build + typecheck + api tests + Playwright) | Slower, broader — **advisory** (not required; Playwright can be flaky and shouldn't block a hotfix). |

Both run on `pull_request` → `main` and `push` → `main`.

## Required status checks

In **GitHub → Settings → Branches → Branch protection rules → Add rule**
for branch `main`:

- **Require a pull request before merging**: ON
  - Require approvals: **1** (or 0 if solo founder — see note below)
  - Dismiss stale approvals on new commits: ON
- **Require status checks to pass before merging**: ON
  - Require branches to be up to date before merging: ON
  - Required checks (search by these exact names):
    - `API strict build`
    - `Web typecheck`
    - `API tests`
  - Do **not** add `Golden path` (e2e) as required — keep it advisory.
- **Require conversation resolution before merging**: ON
- **Do not allow bypassing the above settings**: ON
  (uncheck "Allow administrators to bypass" once the team is >1)
- **Restrict who can push to matching branches**: leave default; the
  rule below already blocks direct pushes via "require a PR".
- Allow force pushes: **OFF**. Allow deletions: **OFF**.

> The required-check names only appear in the GitHub picker **after the
> workflow has run at least once** on a PR/commit. Open the beta-ops PR
> first, let `ci.yml` run, then add the three checks to the rule.

## Merge strategy recommendation

- **Squash merge only.** Enable "Allow squash merging", disable merge
  commits and rebase merging (GitHub → Settings → General → Pull
  Requests). Keeps `main` history one-commit-per-change, which is what
  the rollback guidance in `BETA_RUNBOOK.md` §5 (`git revert <sha>`)
  assumes.
- Auto-merge is fine to enable **per-PR** once required checks exist —
  it will then actually wait for the checks (it didn't before, because
  there were none, which is why PR #2 merged instantly).

## Direct-push policy

- **No direct pushes to `main`.** "Require a pull request before
  merging" enforces this for everyone.
- Solo-founder note: even at 1 person, keep PR-required but you may set
  approvals to 0 and self-merge after green checks. The value is the
  **checks**, not the second pair of eyes, until the team grows.
- `wip/sms-migration` and feature branches: no protection, push freely.

## Practicality / cost

- Three small jobs, Node 20, ubuntu-22.04, npm + mongo-binary caching.
  Typical wall time is a few minutes, parallel. No containers, no
  matrix, no Kubernetes — intentionally.
- If CI minutes become a concern later, the first lever is dropping
  `push: [main]` triggers (keep `pull_request` only). Don't add
  complexity before there's a real bill.
