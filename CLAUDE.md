<!-- BEGIN REPO-SKILLS -->
This repository has [Repo Skills](https://github.com/rjwalters/repo) v0.26.1 installed —
general repository hygiene and environment commands invoked as `/repo:<command>`. Run
`/repo:help` for the command list, or see `.claude/skills/repo/SKILL.md` for the full
guide. Hygiene commands apply safe, reversible fixes by default and report each
change; run with `--ask` to review first, and `--prune` to allow irreversible
removals. Managed by `install.sh` — edit outside the markers only.
<!-- END REPO-SKILLS -->

## Project conventions

Small codebase, few rules — but these were each learned from a shipped bug.

**`FORMATS` in `src/render.mjs` is the single source of truth for output
formats.** Never hand-write the format list anywhere else. The MCP JSON schema
had an `enum: [...FORMATS]` sitting directly above a hand-written `description`
listing the same formats; adding `markdown` updated the enum and silently left
the prose denying it. Derive from `FORMATS` (`FORMATS.join(", ")`) or import it.
The README's usage block and MCP tool table are the remaining hand-maintained
copies — `tests/readme.test.mjs` now enforces both (flags vs `--help`, tool
arguments and `FORMATS` vs the MCP table); a failure names the flag or argument
to update.

**Detect "am I the entry point?" by real path, never by an `argv[1]` filename
suffix.** A suffix test (`argv[1].endsWith("cli.mjs")`) fails for every
symlinked launcher, which is exactly how npm installs a `bin`. The result is
the worst failure shape available: the CLI loads, matches nothing, and exits 0
having done nothing. Compare resolved real paths instead.

**`src/cli.mjs` must stay mode `100755`.** It is the `bin` target and has a
shebang. A registry install chmods it for you, which is exactly why the bug
hides — but `npm link` symlinks into the working tree and inherits the repo's
mode, where `100644` means `permission denied` before Node ever starts. If git
reports the file mode-dirty, `100755` is the correct resolution.

**Verify runtime changes through the `PATH` binary**, not `node src/cli.mjs`.
The direct-node invocation is precisely the shape that hid both bugs above: it
bypasses the bin symlink and never consults the exec bit. Note the published
package is `@rjwalters/trawl` (npm rejects `trawl-cli` as too close to
`trash-cli`; bare `trawl` is taken), and the global install is a registry copy
— so `npm i -g @rjwalters/trawl` is required before the `PATH` binary reflects
anything merged here.

**trawl does not gate a user-directed page read.** Loading a page at a human
pace on a user's instruction is the same act as that user opening it in a
browser. `robots.txt` is advisory by default (`--respect-robots`, library
`respectRobots: true`, MCP `respect_robots` is the opt-in strict mode;
`--ignore-robots` is a no-op), and no change may make a single paced read fail
because of it. Abuse is limited by rate and volume: the per-origin pace,
cooldowns on blocks (403/429/503 and challenge pages served with 200,
[#142](https://github.com/2AMLogic/trawl/issues/142)), and the absence of any
crawl mode. A shared per-origin page budget is built: 60 renders per origin
per rolling hour, 200 per rolling day, shared by the CLI, library and MCP
entry points through the same state directory. Past either limit a call is
refused before any request is made, with exit code 5, until a slot rolls
free; `--ignore-budget` (library `ignoreBudget: true`) skips the refusal
only. See [#141](https://github.com/2AMLogic/trawl/issues/141), which built
it. A proposal to add a new refusal on the fetch path needs an operator
decision, recorded in an issue, before it ships. See
[#140](https://github.com/2AMLogic/trawl/issues/140); the named test
"default flags fetch a page on a Disallow: / origin" in `tests/render.test.mjs`
fails if the refusal comes back.

**Tests are `node --test`, no framework.** `npm test` runs `tests/*.test.mjs`.
Tests that need a browser skip cleanly when none is present, so a green local
run does not always mean the render path was exercised — CI installs Chromium
to keep them meaningful.

**A PR that changes user-visible behaviour ships its `CHANGELOG.md`
`[Unreleased]` entry in the same PR.** A `feat:`/`fix:` change to CLI flags,
defaults, exit codes, or the library or MCP surface adds or updates an
`[Unreleased]` entry, creating the section if it does not exist yet;
internal-only changes need none. If a PR changes behaviour an existing
`[Unreleased]` entry already describes, edit that entry rather than adding a
contradicting one, and keep a single heading per type (`### Changed` etc.).
For Judge this is a review finding: a user-visible behaviour change with no
matching changelog edit does not pass review. 0.5.0 shipped missing entries
for two of its biggest changes (#141, #145) and carried two entries later
PRs had made untrue, all caught by hand at release time (#161).

<!-- BEGIN LOOM ORCHESTRATION -->
This repository uses [Loom](https://github.com/rjwalters/loom) for AI-powered development orchestration — see the Loom repository for the full guide (roles, labels, worktrees, configuration). When installed, Loom also writes a locally-substituted copy of that guide to `.loom/CLAUDE.md`.

Work is coordinated through `loom:` labels on issues and pull requests, and the same roles run either under `loom-daemon` or by hand in an attended session — daemon mode is optional. Create the labels once with `.loom/scripts/sync-labels.sh` (an install ships `.github/labels.yml` but does not create the labels on the forge). A pull request ready for review carries `loom:review-requested`; Judge reviews it and applies `loom:pr` (approved) or `loom:changes-requested`; Doctor fixes a `loom:changes-requested` pull request and returns it to `loom:review-requested`. Only a `loom:pr` pull request gets merged, and always via this repo's merge script (`.loom/scripts/merge-pr.sh`) — never a raw forge merge command such as `gh pr merge`. Full state machine: `.loom/docs/label-state-machine.md`.
<!-- END LOOM ORCHESTRATION -->
