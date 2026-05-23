---
description: Root-cause debugging rules for release, CI, packaging, and regression fixes.
applyTo: "**/*"
---
# Root-Cause Debugging and Release Verification Rules
These rules apply to failures, regressions, release issues, CI/CD workflows, packaging, and deployment problems.

## Phase 1: Investigate
1. Collect evidence before changing files: failing logs, job metadata, branch, tag, commit, workflow file, and job attempt.
2. For GitHub Actions, use concrete commands such as `gh run view <run_id> --log`, `gh run view <run_id> --job <job_id> --log`, `gh api repos/<owner>/<repo>/actions/runs/<run_id>`, and focused `grep` around the failing step. If `gh` is unavailable, unauthenticated, or fails, ask the user to authenticate it or provide the logs manually.
3. If logs have expired or are unavailable, report that fact and ask the user before triggering another run or a debug run.
4. For regressions, compare with the previous stable release tag. If that baseline is unknown, ask the user for the last known-good commit hash or tag before proceeding.
5. Separate similar execution paths when analyzing evidence. Example: creating a new GitHub Release and fetching/updating an existing Release are different paths.
6. If the root cause cannot be conclusively determined from logs, metadata, and current files, summarize the investigated paths and ask the user for additional permissions, debug logs, or context before attempting fixes.
7. Read current file contents before editing. Use file-type-specific checks before editing:
	- For YAML workflow files: use `git diff -- <path>` and focused `grep -nE '<pattern>' <path>`.
	- For lockfiles: run `pnpm install --frozen-lockfile` and targeted `grep -n` searches in `pnpm-lock.yaml`.
	- For JavaScript configuration files: load the config directly when applicable, for example `node -e "require('./packages/gui/electron-builder.config.cjs')"`.

## Phase 2: Act
1. Fix the proven root cause at the evidence-backed location in the execution pipeline or commit history, such as the first failing CI step, the bad commit that introduced the bug, divergent configuration, stale GitHub Release/tag state, or incorrect assumption.
2. Use official project workflows as the default path for building, downloading, and publishing release assets.
3. Confirm the intended tag and commit with commands such as `git rev-parse <tag>`, `git show --oneline <tag>`, and `gh release view <tag>` before release-related actions.
4. Keep upstream compatibility as the default. Ask the user before introducing local divergence from upstream.

## Phase 3: Validate
1. Verify published releases with `gh release view <tag> --json assets,tagName,targetCommitish,isDraft,isPrerelease`.
2. Compare current release assets with the previous known-good release using the same `gh release view` command for both releases.
3. In this project, determine Windows universal requirements by running `gh release view <previous_tag> --json assets`. If the previous release lists a Windows universal installer such as `*-windows-universal.exe`, the current release must also list the matching current-version asset.
4. If the user explicitly requests to verify the release build, download the published artifact and execute it to confirm successful installation or runtime.

## Reporting Template
Use this four-part summary whenever you modify code or perform pipeline runs:

1. **Root cause and comparison:** what failed, what evidence proves it, and why the known-good version/run behaved differently.
2. **Action taken:** workflow/code fix, configuration change, or verified rerun.
3. **Verification:** commands, run/job URLs, asset counts, critical artifact names, and runtime/install confirmation when available.
4. **Remaining risk:** permanent fix status, upstream compatibility, and what to watch next.
