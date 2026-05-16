---
description: "Create a new private/public paired dev branch for this repo with submit.sh"
name: "newdev"
argument-hint: "<feature-name> <base>"
agent: "agent"
---
When the user wants to create a new development branch for this repository:

1. If `feature-name` or `base` is missing, ask for the missing value first.
2. Treat `feature-name` as the bare feature name only; do not prepend `dev/` yourself in the argument.
3. Run everything from the repository root. Do not manually create git branches if [submit.sh](../../submit.sh) can do it.
4. Run [submit.sh](../../submit.sh) from the repository root in this order:
   - `./submit.sh --new-dev-branch <feature-name> <base>`
   - `./submit.sh --restore-private`
   - `COMMIT_MSG_PRIVATE='chore: initialize private context' ./submit.sh --commit-private`
5. Do not push any branch unless the user explicitly asks.
6. Report:
   - the current checked out branch
   - the paired public branch name `feature/<feature-name>`
   - whether private files were restored successfully
   - the private initialization commit hash and message
7. If any command fails, stop immediately and explain the exact failing command plus the next corrective action.
