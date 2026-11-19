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
   `git fetch origin main`, then `git branch "release/$NEW"` and reset the
   current branch back to the freshly fetched `origin/main`
   (`git reset --hard origin/main`).
3. Push the release branch (no tag): `git push -u origin "release/$NEW"`.
4. Open a PR `release/$NEW` → `main` titled `chore: release $NEW`, labelled
   `loom:operator` for the operator to merge, with the CHANGELOG entry as the
   body. The checkout is on `main` at this point (step 2 reset it there), so
   name both branches explicitly — `create-pr.sh` resolves a missing `--head`
   from the checkout and a missing `--base` from the repo default, which
   would resolve to `main` → `main` and be rejected:
   `./.loom/scripts/create-pr.sh --head "release/$NEW" --base main --title "chore: release $NEW" --body-file <changelog-entry> --label "loom:operator"`
   (`<changelog-entry>` = the notes file from `extract_release_notes` in the
   `pre-github-release` section below, or any file holding the entry).
5. **Stop.** The operator merges the PR; do not push any tag yet.
6. After the merge: `git fetch origin main`, create the annotated tag on
   main's merge commit (the `Merge pull request #N` commit that
   `git rev-parse origin/main` now names), and push only the tag:
   `git tag -a "v$NEW" -m "v$NEW" origin/main && git push origin "v$NEW"`.
   Then create the GitHub Release per `pre-github-release` below.

## seam: pre-github-release (replace)

Every release to date has a GitHub Release cut from the CHANGELOG entry
(`v0.1.0`-`v0.5.0`, e.g. #161's "GitHub Release from the changelog entry"),
and this repo has no release workflow to make one — so create it here,
replacing the default `gh release create` (which only fires when
`.github/workflows/release.yml` exists). Runs after the tag push in the
`pre-push` steps above. Extract the notes with the portable `awk` helper —
not `sed \?`, a GNU extension that silently yields an empty body on
BSD/macOS (full rationale in `.claude/commands/repo/release.md`, Phase 6):

```bash
extract_release_notes() {   # <version> -> writes matching CHANGELOG range to stdout
  awk -v v="$1" '
    $0 ~ "^##[[:space:]]+v?\\[?" v "([[:space:]]|\\]|$)" {f=1; next}
    /^##[[:space:]]/ {f=0}
    f' CHANGELOG.md
}
NOTES_FILE="$(mktemp)"
extract_release_notes "$NEW" > "$NOTES_FILE"
[ -s "$NOTES_FILE" ] || { echo "ERROR: extracted release notes are empty — CHANGELOG header for $NEW not matched" >&2; exit 1; }
gh release create "v$NEW" --title "v$NEW" --notes-file "$NOTES_FILE" \
  || { echo "gh release create failed — retrying once after a short pause (tag-propagation lag)"; sleep 10; \
       gh release create "v$NEW" --title "v$NEW" --notes-file "$NOTES_FILE"; }
```

## seam: post-summary

npm publish is **manual** and belongs to the operator: `npm publish` requires
browser-based 2FA, so a non-interactive agent shell fails with `EOTP` and
cannot finish it. Hand off with these steps:

1. Operator runs `npm publish --access public` from merged `main`.
2. Verify it took: `npm view @rjwalters/trawl version` prints the new version.
3. Refresh the global install so the `PATH` binary reflects the release —
   the global install is a registry copy, not a link into a checkout:
   `npm i -g @rjwalters/trawl` (see `CLAUDE.md`).
