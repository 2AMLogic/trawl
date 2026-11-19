# Work Plan

Roadmap generated from current GitHub label state by the Loom Guide role.
The region between the markers is machine-generated and overwritten wholesale.

<!-- guide:plan-body:start -->
_Generated: 2026-11-19T07:40:31Z (snapshot; compare against live labels)_
## Operator Attention: Merge-Risk-Hold Pileup

Judge-approved PRs under a hold (`loom:blocked` or `loom:operator`) — only a human merge decision is missing.

_None._

## Very Important

`loom:very-important` (one counts per workspace); every stage takes these first.

_None._

## Important

`loom:important`; taken before unlabelled work.

_None._

## Ready

Human-approved issues (`loom:issue`) ready for implementation — excluding held (`loom:blocked`/`loom:operator`/`loom:frozen`), `loom:building`, and issues closed by an open `loom:pr` PR (listed under Approved).

_None._

## In Progress

Issues currently being built (`loom:building`).

- **#153**: Scroll-step polish: MCP result metadata field, unreachable bottom-timeout message, implicit scrollsPerformed invariant
- **#154**: Scroll seam tests fail instead of skipping on a Chromium-less host
- **#156**: CLAUDE.md still says the per-origin page budget is "planned, not built"

## PRs Awaiting Review

PRs waiting on Judge (`loom:review-requested`).

- **#157**: test: give scroll seam tests an existing executablePath so they run without Chromium

## Approved (Awaiting Merge)

PRs that passed review and are queued for Champion auto-merge (`loom:pr`).

- **#155**: Move MCP scroll count into _meta; drop dead bottom-timeout wording; name message-less step failures — closes #153

## Proposed

Issues carrying `loom:curated`.

- **#153**: Scroll-step polish: MCP result metadata field, unreachable bottom-timeout message, implicit scrollsPerformed invariant *(curated)*
- **#154**: Scroll seam tests fail instead of skipping on a Chromium-less host *(curated)*
- **#156**: CLAUDE.md still says the per-origin page budget is "planned, not built" *(curated)*

## Proposed (Architect / Hermit)

_None._

## Epics

_None._

## Backlog Balance

| Bucket | Count |
|------|-------|
| Operator merge-risk holds | 0 |
| Very important | 0 |
| Important | 0 |
| Ready (`loom:issue`, net of holds/building/merge-pending) | 0 |
| In Progress (`loom:building`) | 3 |
| PRs awaiting review | 1 |
| Approved PRs awaiting merge | 1 |
| Curated | 3 |
| Architect / Hermit proposals | 0 |
| Active epics | 0 |
<!-- guide:plan-body:end -->
