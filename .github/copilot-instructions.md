# DevSidecar Copilot Instructions

## Branching and Submit Workflow

- In this repository, prefer [submit.sh](../submit.sh) over ad-hoc git branch/commit/push commands when the task is about branching, submitting, syncing upstream, or releasing.
- Create new development branches with `./submit.sh --new-dev-branch <feature-name> <base>` from the repository root, then restore private files and initialize the private context commit.
- Treat branch pairs as:
  - `develop` ↔ `main` / `master`
  - `dev/<name>` ↔ `feature/<name>`
  - `release-vX.Y.x` for release automation
- Before repository submission work, run `./submit.sh --check-prerequisites` and inspect both private and public change sets.
- Use Conventional Commits style messages for `COMMIT_MSG_PRIVATE` and `COMMIT_MSG_PUBLIC`.
- Do not push private or public branches unless the user explicitly asks.

## Private/Public Separation

- Respect this repository's private/public split; do not assume all tracked files belong in the public branch.
- Prefer `./submit.sh --print-private-show` and `./submit.sh --print-public-show` to understand what will land on each side before committing.

## Build and Validation

- Run repository scripts from the repository root unless a package-level command clearly belongs in a subpackage.
- GUI rebuilds for deployment use `cd packages/gui && pnpm electron:build`.
- When changing the Xray cache logic, prefer targeted validation first, for example `cd packages/core && pnpm test -- test/xrayCacheOrdering.test.js`.