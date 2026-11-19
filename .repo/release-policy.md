# Release policy — trawl

Package name: **`@rjwalters/trawl`** (npm rejects `trawl-cli` as too close to
`trash-cli`, and bare `trawl` is taken — see `CLAUDE.md`). Publishing is
**automated, not manual** (operator ruling on #166): `.github/workflows/
release.yml` fires on `release: published`, checks out the released tag and
runs `npm publish --provenance --access public` with `id-token: write` — npm
**trusted publishing** (OIDC, no stored token, no interactive 2FA).
Publishing the GitHub Release in `pre-github-release` below is what triggers
it. It needs the owner's one-time trusted-publisher registration on npmjs.com
(see `post-summary`); until that is done the workflow's publish fails and the
fallback there is a manual `npm publish`.

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
   body — extracted **from the release branch**: step 2 reset this checkout
   to pre-release `main`, whose `CHANGELOG.md` does not carry the entry yet
   (`extract_release_notes` below reads any given revision). The checkout is
   on `main` at this point, so name both branches explicitly — `create-pr.sh`
   resolves a missing `--head` from the checkout and a missing `--base` from
   the repo default, which would resolve to `main` → `main` and be rejected.
   Keep `$REL_PR` for step 6:
   ```bash
   NOTES_FILE="$(mktemp)"
   extract_release_notes "release/$NEW" "$NEW" > "$NOTES_FILE"
   [ -s "$NOTES_FILE" ] || { echo "ERROR: empty release notes extracted from release/$NEW" >&2; exit 1; }
   ./.loom/scripts/create-pr.sh --head "release/$NEW" --base main \
     --title "chore: release $NEW" --body-file "$NOTES_FILE" --label "loom:operator"
   REL_PR=$(gh pr list --head "release/$NEW" --state open --json number --jq '.[0].number')
   ```
5. **Stop.** The operator merges the PR; do not push any tag yet.
6. After the merge, tag **the release PR's merge commit** — not
   `origin/main`: a later resumption would otherwise tag whichever commit is
   newest, and an unrelated merge in between drags foreign code into the
   release (after 0.5.0 the very next first-parent merge, `f8f24c3`, was
   unrelated). Confirm the PR merged, take its merge SHA, tag that, then
   create the GitHub Release per `pre-github-release` below:
   ```bash
   git fetch origin main
   [ "$(gh pr view "$REL_PR" --json state --jq .state)" = "MERGED" ] \
     || { echo "ERROR: release PR #$REL_PR is not merged — no tag" >&2; exit 1; }
   MERGE_SHA=$(gh pr view "$REL_PR" --json mergeCommit --jq '.mergeCommit.oid')
   git tag -a "v$NEW" -m "v$NEW" "$MERGE_SHA" && git push origin "v$NEW"
   ```

## seam: pre-github-release (replace)

Every release to date has a GitHub Release cut from the CHANGELOG entry
(`v0.1.0`-`v0.5.0`, e.g. #161's "GitHub Release from the changelog entry").
`.github/workflows/release.yml` does **not** create the Release — it is the
npm publish step that fires when one is published — so create it here,
replacing the default `gh release create`. Runs after the tag push in the
`pre-push` steps above. Extract the notes **from the release revision**
(`$MERGE_SHA` from `pre-push` step 6 — the tag `v$NEW` names the same tree):
the checkout is still pre-release `main` (step 2 of `pre-push` reset it
there), so its own `CHANGELOG.md` lacks the entry and reading the working
tree would hit the empty-notes guard even after the merge. Use the portable
`awk` helper — not `sed \?`, a GNU extension that silently yields an empty
body on BSD/macOS (full rationale in `.claude/commands/repo/release.md`,
Phase 6):

```bash
extract_release_notes() {   # <rev> <version> -> matching CHANGELOG range at <rev> to stdout
  git show "$1:CHANGELOG.md" | awk -v v="$2" '
    $0 ~ "^##[[:space:]]+v?\\[?" v "([[:space:]]|\\]|$)" {f=1; next}
    /^##[[:space:]]/ {f=0}
    f'
}
NOTES_FILE="$(mktemp)"
extract_release_notes "$MERGE_SHA" "$NEW" > "$NOTES_FILE"
[ -s "$NOTES_FILE" ] || { echo "ERROR: extracted release notes are empty — CHANGELOG header for $NEW not matched at $MERGE_SHA" >&2; exit 1; }
gh release create "v$NEW" --title "v$NEW" --notes-file "$NOTES_FILE" \
  || { echo "gh release create failed — retrying once after a short pause (tag-propagation lag)"; sleep 10; \
       gh release create "v$NEW" --title "v$NEW" --notes-file "$NOTES_FILE"; }
```

## seam: post-summary

npm publish is **automated**: publishing the GitHub Release in
`pre-github-release` triggers `.github/workflows/release.yml`
(`on: release: published`), which checks out the released tag and runs
`npm publish --provenance --access public` under `id-token: write`. Hand off
with these steps:

1. Approve the deployment: the publish job runs in the protected
   `npm-publish` environment, so the run pauses here until the owner approves
   it in GitHub (Actions → the run → Review deployments).
2. Watch the publish workflow finish:
   `gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"`
   (or `gh run list --workflow=release.yml --limit 1` for a one-shot look).
3. Verify it took: `npm view @rjwalters/trawl version` prints the new version.
4. Refresh the global install so the `PATH` binary reflects the release —
   the global install is a registry copy, not a link into a checkout:
   `npm i -g @rjwalters/trawl` (see `CLAUDE.md`).

**One-time operator setup (owner, npmjs.com):** register the trusted
publisher for `@rjwalters/trawl` against this repository
(`2AMLogic/trawl`), the workflow filename `release.yml` and the environment
`npm-publish`, before the first release published this way:
`npm trust github @rjwalters/trawl --file release.yml --repo 2AMLogic/trawl --env npm-publish --allow-publish`. Until that is done the workflow's publish fails
and the **manual fallback** applies — from the tagged tree, not `main`
(the tag is the verified release revision):

- `git worktree add "$(mktemp -d)" "v$NEW"` (or `git checkout "v$NEW"`),
  then `npm publish --access public` from it. This needs browser-based 2FA:
  a non-interactive agent shell fails with `EOTP` and cannot finish it, so
  it belongs to the operator.
