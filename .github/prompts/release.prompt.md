---
description: "Create and push the release branch and tag for this repo with submit.sh"
name: "release"
argument-hint: "release version from CHANGELOG"
agent: "agent"
---
When the user wants to publish a new release for this repository:

1. Run [submit.sh](../../submit.sh) from the repository root.
2. Verify the release is ready before execution:
   - required package versions are updated
   - `CHANGELOG.md` contains the target release entry
3. Explain clearly that `./submit.sh --release` will create and push a release branch plus a git tag.
4. Only run the release command after the user has explicitly asked for the release action.
5. Run:
   - `./submit.sh --release`
6. Report:
   - release branch name
   - tag name
   - push status
   - any CI/release follow-up steps
7. If release prerequisites are missing, stop and list exactly what still needs to be prepared.
