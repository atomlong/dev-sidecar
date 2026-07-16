---
description: "Review private/public changes in this repo and run the submit.sh submit workflow"
name: "submit"
argument-hint: "private/public commit or push request"
agent: "agent"
---
When the user wants to submit code for this repository:

1. Run [submit.sh](../../submit.sh) from the repository root.
2. Start with prerequisites:
   - `./submit.sh --check-prerequisites`
3. Inspect both change sets before committing:
   - private view: `./submit.sh --print-private-show`
   - public view: `./submit.sh --print-public-show`
4. Use Conventional Commits style messages.
   - private commit: `COMMIT_MSG_PRIVATE="..." ./submit.sh --commit-private`
   - public commit: `COMMIT_MSG_PUBLIC="..." ./submit.sh --commit-public`
5. Generate commit messages from the inspected changes. If one side has no changes, do not create an empty commit for that side.
6. Only push when the user explicitly asks:
   - `./submit.sh --push-private`
   - `./submit.sh --push-public`
7. If the user asks to sync upstream or release, use the matching workflow commands:
   - `./submit.sh --sync-upstream`
   - `./submit.sh --release`
8. Do not bypass this workflow with raw `git commit`, `git push`, or manual branch juggling unless the user explicitly asks for that deviation.
9. Always report:
   - current branch
   - private/public commit hashes and messages
   - remote sync or push status
   - any warnings, skipped operations, or manual follow-up steps
10. If prerequisites fail, stop and tell the user whether they should repair the branch state or recreate it with `/newdev`.
