# Tags Master repository

This repository is the active side of the cross-repository release test. All workflows,
scripts, approvals, secrets and workflow runs live here. The passive target is
`Imperia-Rminana/tags-slave-repo`.

## GitHub configuration

Before running the workflows:

1. Create a fine-grained PAT with `Imperia-Rminana` as resource owner.
2. Select only `tags-slave-repo` and grant `Contents: Read and write`.
3. Add the PAT to this repository as `SCP_STUDIO_DEVELOPMENT_PAT`.
4. Create the `release` and `release-override` Environments. Required reviewers are
   optional for this laboratory, but enabling them tests the approval pause.
5. Push these files to the default `main` branch so `workflow_dispatch` is available.

## Test sequence

Prepare and push the passive branches from the Slave repository first. Then:

1. Run **Release Core** with `release_line=1.0` and `dry_run=true`.
2. Confirm that the preview selects `release/1.0` and proposes `core/1.0.0`.
3. Run it again with `dry_run=false` and approve the `release` Environment if enabled.
4. Confirm that the annotated tag, GitHub Release and `release-metadata.json` exist in
   `tags-slave-repo`, not in this repository.
5. Run **Release Booster** with `booster_name=demo`, `release_line=1.0` and the same
   dry-run-first sequence. The expected first tag is `boost/demo/1.0.0`.

The workflows use Octokit with the PAT for all Git and Release API operations. The
automatic token of this repository remains read-only.
