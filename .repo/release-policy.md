# Release policy — trawl

Package name: **`@rjwalters/trawl`** (npm rejects `trawl-cli` as too close to
`trash-cli`, and bare `trawl` is taken — see `CLAUDE.md`). There is **no
publish workflow**: `.github/workflows/ci.yml` (CI only) is the sole workflow,
so the npm publish at the end is a manual operator step, not something CI does.

Releases land through a **release PR, never a direct push to `main`**
(precedent: 0.4.0 #103, 0.5.0 #161). The annotated `vX.Y.Z` tag goes on
main's **merge commit**, not on the version commit.

## seam: pre-push (replace)

Replace the default `git push --follow-tags` to the default branch with the
release-branch + PR + merge-commit-tag flow:

1. Delete the local `v$NEW` tag Phase 5 created — it points at the version
   commit, but this repo tags the merge commit after the PR merges:
   `git tag -d "v$NEW"`.
2. Put the version commit on a release branch instead of `main`:
   `git branch "release/$NEW"`, then reset the current branch back to
   `origin/main` (`git reset --hard origin/main`).
3. Push the release branch (no tag): `git push -u origin "release/$NEW"`.
4. Open a PR `release/$NEW` → `main` titled `chore: release $NEW`, labelled
   `loom:operator` for the operator to merge, with the CHANGELOG entry as the
   body. Use `./.loom/scripts/create-pr.sh` per repo convention.
5. **Stop.** The operator merges the PR; do not push any tag yet.
6. After the merge: `git fetch origin main`, create the annotated tag on
   main's merge commit (the `Merge pull request #N` commit that
   `git rev-parse origin/main` now names), and push only the tag:
   `git tag -a "v$NEW" -m "v$NEW" origin/main && git push origin "v$NEW"`.

## seam: post-summary

npm publish is **manual** and belongs to the operator: `npm publish` requires
browser-based 2FA, so a non-interactive agent shell fails with `EOTP` and
cannot finish it. Hand off with these steps:

1. Operator runs `npm publish --access public` from merged `main`.
2. Verify it took: `npm view @rjwalters/trawl version` prints the new version.
3. Refresh the global install so the `PATH` binary reflects the release —
   the global install is a registry copy, not a link into a checkout:
   `npm i -g @rjwalters/trawl` (see `CLAUDE.md`).
