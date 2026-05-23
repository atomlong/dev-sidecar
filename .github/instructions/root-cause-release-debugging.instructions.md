---
description: Root-cause debugging rules for release, CI, packaging, and regression fixes.
applyTo: "**/*"
---
# Root-Cause Debugging and Release Verification Rules
These rules apply to failures, regressions, release issues, CI/CD workflows, packaging, and deployment problems.

## Phase 1: Investigate
1. Use available CLI tools to gather evidence before changing files: failing logs, job metadata, branch, tag, commit, workflow file, and job attempt. Ask the user when tools cannot retrieve evidence, when permission is required for a rerun or debug run, or when later phases require approval.
2. If the CI/CD workflow is not hosted on GitHub Actions, do not use `gh` commands. Ask the user for the platform-specific logs or command-line tools available in the current environment.
3. For GitHub Actions without supplied logs, run `gh auth status` before any `gh run` command. If authentication fails, instruct the user to complete the `gh` authentication flow before proceeding.
4. Use `grep` and `tail` on Unix-like environments. On Windows without Coreutils, use PowerShell equivalents such as `Select-String` instead of `grep` and `Select-Object -Last` instead of `tail`.
5. If the run ID is unknown, run `gh run list --limit 10` and identify the most recent workflow run for the specific branch and workflow file under investigation.
6. Inspect run metadata with `gh api repos/<owner>/<repo>/actions/runs/<run_id>` before fetching logs.
7. On Unix-like environments, execute `gh run view <run_id> --log | tail -n 50`; on Windows without Coreutils, execute `gh run view <run_id> --log | Select-Object -Last 50`.
8. Evaluate the log output from the previous step:
	- Step A: Identify the exact error string if one is present.
	- Step B: If an exact error string is present, run `gh run view <run_id> --log | grep -F -C 15 -- '<exact_error_string>'` or the PowerShell equivalent with `Select-String -SimpleMatch`.
	- Step C: If no exact error string is present, run `gh run view <run_id> --log | grep -iE 'error|failed|exception' -C 5` or the PowerShell equivalent with `Select-String`.
9. If logs have expired or are unavailable, report that fact and ask the user before triggering another run or a debug run.
10. For regressions, find stable release tags with `git tag --sort=-v:refname | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n 2`, select the older tag from the two results, then run `git diff <selected_tag>...HEAD`. If the command fails or returns fewer than two tags, ask the user for the last known-good commit hash or tag before proceeding.
11. When analyzing multiple CI jobs, matrix runs, or release API paths in a workflow, include the path-by-path comparison inside the **Root cause and comparison** section of the Reporting Template.
12. If the root cause cannot be conclusively determined from logs, metadata, and current files, summarize the investigated paths and ask the user for additional permissions, debug logs, or context before attempting fixes.
13. Read current file contents before editing. For lockfiles, check size first with `wc -l <file>` and `wc -c <file>`; if the file exceeds 1000 lines or 1 MB, inspect the relevant dependency or error with `grep -C 5 '<dependency_or_error_name>' <file>` and ask the user before reading the entire file.

## Phase 2: Act
1. Fix the proven root cause at the evidence-backed location in the execution pipeline or commit history, such as the first failing CI step, the bad commit that introduced the bug, divergent configuration, stale GitHub Release/tag state, unmet pipeline dependency, or missing environment variable.
2. Use official project workflows as the default path for building, downloading, and publishing release assets.
3. Confirm the intended tag and commit with commands such as `git rev-parse <tag>`, `git show --oneline <tag>`, and `gh release view <tag>` before release-related actions.
4. Review modifications after editing with `git diff -- <path>`.
5. Check whether this workspace is a fork before introducing repository-level divergence.
6. If this workspace is a fork, do not modify files that exist in the upstream repository without user approval, unless the change is strictly isolated to local workflows or configuration.
7. Regardless of repository origin, ask the user before modifying exported function signatures, REST API route definitions, or CLI argument schemas.

## Phase 3: Validate
1. Verify published releases with `gh release view <tag> --json assets,tagName,targetCommitish,isDraft,isPrerelease`.
2. Compare current release assets with the previous known-good release using the same `gh release view` command for both releases.
3. If validating Windows assets, run `gh release view` for both current and previous tags. If the previous tag contains `*-windows-universal.exe` but the current tag does not, halt validation, summarize the missing and expected asset names, and ask the user whether the build pipeline needs to be rerun.
4. If the user explicitly requests to verify the release build, download the published artifact only after confirming its target OS and architecture match the local environment. If they do not match, inform the user that local execution is not possible.

## Reporting Template
Use this four-part summary whenever you modify code or perform pipeline runs:

1. **Root cause and comparison:** what failed, what evidence proves it, and why the known-good version/run behaved differently.
2. **Action taken:** workflow/code fix, configuration change, or verified rerun.
3. **Verification:** commands, run/job URLs, asset counts, critical artifact names, and runtime/install confirmation when available.
4. **Remaining risk:** permanent fix status, compatibility with the upstream base repository or unchanged exported function signatures, REST API route definitions, and CLI argument schemas, and what to watch next.
