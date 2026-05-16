---
description: "Sync the local public branch from upstream and merge it back into develop with submit.sh"
name: "sync-upstream"
argument-hint: "sync upstream public branch"
agent: "agent"
---
When the user wants to sync this repository from the upstream public repository:

1. Run [submit.sh](../../submit.sh) from the repository root.
2. Prefer doing this on `develop`.
3. Start with `./submit.sh --check-prerequisites` if branch state looks unclear.
4. Run:
   - `./submit.sh --sync-upstream`
5. Do not push anything automatically after sync unless the user explicitly asks.
6. Report:
   - current branch
   - whether upstream fetch and merge succeeded
   - whether local public branch and `develop` were updated
   - any conflicts, skipped operations, or manual follow-up steps
7. If the repository is in the wrong branch state for sync, stop and tell the user how to correct it before retrying.
