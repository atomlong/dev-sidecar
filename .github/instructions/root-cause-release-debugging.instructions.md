---
description: Root-cause debugging rules for release, CI, packaging, and regression fixes.
applyTo: "**/*"
---
# Root-Cause Debugging and Release Verification Rules
These rules apply to failures, regressions, release issues, CI/CD workflows, packaging, and deployment problems.

## Phase 1: Investigate
1. Collect evidence before changing files: failing logs, job metadata, branch, tag, commit, workflow file, and job attempt.
2. For GitHub Actions, use concrete commands such as `gh run view <run_id> --log`, `gh run view <run_id> --job <job_id> --log`, `gh api repos/<owner>/<repo>/actions/runs/<run_id>`, and focused `grep` around the failing step.
3. If logs have expired or are unavailable, report that fact and ask the user before triggering another run or a debug run.
4. For regressions, compare with the last known-good version, tag, run, workflow file, lockfile, configuration, and upstream implementation. Explain what changed.
5. Separate similar execution paths when analyzing evidence. Example: creating a new GitHub Release and fetching/updating an existing Release are different paths.
6. Read current file contents before editing.

## Phase 2: Act
1. Fix the earliest proven source of the problem: first failing step, bad commit, divergent configuration, stale GitHub Release/tag state, or incorrect assumption.
2. Use official project workflows as the default path for building, downloading, and publishing release assets.
3. Confirm the intended tag and commit with commands such as `git rev-parse <tag>`, `git show --oneline <tag>`, and `gh release view <tag>` before release-related actions.
4. Keep upstream compatibility as the default. Ask the user before introducing local divergence from upstream.

## Phase 3: Validate
1. Verify published releases with `gh release view <tag> --json assets,tagName,targetCommitish,isDraft,isPrerelease`.
2. Compare current release assets with the previous known-good release using the same `gh release view` command for both releases.
3. In this project, determine Windows universal requirements by running `gh release view <previous_tag> --json assets`. If the previous release lists a Windows universal installer such as `*-windows-universal.exe`, the current release must also list the matching current-version asset.
4. When YAML or lockfiles are involved, use explicit terminal checks before editing: `git show <ref>:<path>`, `git diff -- <path>`, `grep -nE '<pattern>' <path>`, `node -e "require('./packages/gui/electron-builder.config.cjs')"`, `pnpm install --frozen-lockfile`, and targeted `grep -n` searches in `pnpm-lock.yaml`.
5. If a usable release is required, verify runtime or installation of the published artifact when possible.

## Reporting Template
Use this four-part summary for complex debugging work:

1. **Root cause and comparison:** what failed, what evidence proves it, and why the known-good version/run behaved differently.
2. **Action taken:** workflow/code fix, configuration change, or verified rerun.
3. **Verification:** commands, run/job URLs, asset counts, critical artifact names, and runtime/install confirmation when available.
4. **Remaining risk:** permanent fix status, upstream compatibility, and what to watch next.
