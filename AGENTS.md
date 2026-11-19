## Design rule: robots.txt is advisory

**trawl does not gate a user-directed page read.** Loading a page at a human
pace on a user's instruction is the same act as that user opening it in a
browser. `robots.txt` is advisory by default (`--respect-robots`, library
`respectRobots: true`, MCP `respect_robots` is the opt-in strict mode;
`--ignore-robots` is a no-op), and no change may make a single paced read fail
because of it. Abuse is limited by rate and volume: the per-origin pace, the
per-origin budget, back-off on 429/503 and block pages, and the absence of any
crawl mode. A proposal to add a new refusal on the fetch path needs an
operator decision, recorded in an issue, before it is built. See
[#140](https://github.com/2AMLogic/trawl/issues/140); the named test
"default flags fetch a page on a Disallow: / origin" in `tests/render.test.mjs`
fails if the refusal comes back.

<!-- BEGIN LOOM ORCHESTRATION (AGENTS) -->
This repository uses [Loom](https://github.com/rjwalters/loom) for AI-powered development orchestration (dual-runtime: Claude Code reads `CLAUDE.md`; OpenAI Codex CLI and other AGENTS.md-aware runtimes read this file). See the Loom repository for the full guide (roles, labels, worktrees, configuration). When installed, Loom also writes a locally-substituted copy of the runtime-neutral guide to `.loom/AGENTS.md`.

Work is coordinated through `loom:` labels on issues and pull requests, and the same roles run either under `loom-daemon` or by hand in an attended session — daemon mode is optional. Create the labels once with `.loom/scripts/sync-labels.sh` (an install ships `.github/labels.yml` but does not create the labels on the forge). A pull request ready for review carries `loom:review-requested`; Judge reviews it and applies `loom:pr` (approved) or `loom:changes-requested`; Doctor fixes a `loom:changes-requested` pull request and returns it to `loom:review-requested`. Only a `loom:pr` pull request gets merged, and always via this repo's merge script (`.loom/scripts/merge-pr.sh`) — never a raw forge merge command such as `gh pr merge`. Full state machine: `.loom/docs/label-state-machine.md`.
<!-- END LOOM ORCHESTRATION (AGENTS) -->
