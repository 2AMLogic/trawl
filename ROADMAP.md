# trawl roadmap

`trawl` fetches client-rendered web pages from the command line, as a library
and as a read-only MCP server, and behaves politely by default while doing it.

Status as of 2026-11-19, `main` @ `57860d5`.

This file is the hand-written direction. `WORK_PLAN.md` is the generated view
of the tracker's label state and `WORK_LOG.md` the generated record of what
merged; neither is edited by hand.

## Where it stands

Released: **0.5.0** (tag `v0.5.0`, on npm as `@rjwalters/trawl@0.5.0`,
`CHANGELOG.md`). It moved abuse limits from `robots.txt` to rate and volume:
`robots.txt` is advisory, default pacing is slower, a shared per-origin page
budget caps volume, and block pages are refused with a cooldown. Everything in
the table is on `main` and covered by `npm test`, which CI runs on Node 22 and
Node 24 (`.github/workflows/ci.yml`, Ubuntu).

| Area | State | Evidence |
| --- | --- | --- |
| Rendering: text, HTML, links, title, Markdown; `--selector`, `--wait-for`, screenshots | done | `src/render.mjs`, `tests/render.test.mjs` |
| `networkidle` timeout retried once with `domcontentloaded` | done | `src/render.mjs`, README "Pages that never go idle" |
| Click steps (`--click`, `--then-wait`) on the CLI and library | done | #56, `tests/click.test.mjs` |
| HAR capture, `--har-omit-content`, `--har-redact` | done | #84 / PR #85, `tests/har-redact.test.mjs` |
| `robots.txt` consulted for every `http(s)` fetch; advisory by default (`Crawl-delay` applies), `--respect-robots` for strict refusal | done | #37, #143, `src/robots.mjs` |
| `robots.txt` rule paths honour `*` and a trailing `$` (RFC 9309 §2.2.3) | done | #109 / PR #114, `tests/robots.test.mjs` |
| Per-origin pacing across runs (3,000 ms default floor plus jitter), `Crawl-delay` honored | done | #38, #141, `src/pacing.mjs` |
| Shared per-origin page budget, 60/hour and 200/day (exit code 5, `--ignore-budget`) | done | #141, `src/budget.mjs`, `tests/budget.test.mjs` |
| Per-origin cooldown after 403/429/503 (exit code 4); main-frame `403` and challenge pages refused | done | #39 / PR #61, #142, #149, `src/cooldown.mjs` |
| Scroll steps (`--scroll`, `--max-scrolls`) on the CLI, library and MCP | done | #145, #153, `tests/scroll.test.mjs` |
| Auth-wall detection, `--profile`, `trawl login` (headed, finishes on window close) | done | #22, #24, #95, #96 / PR #98 |
| Cookie import from HAR, `cookies.txt` or copy-as-cURL; `--cookies` for one fetch | done | #36, #76 to #79 / PRs #81, #82, #83, #86 |
| Cookies sent on the `robots.txt` request, header-safe and kept out of errors | done | #87, #89, #91, #93 / PRs #88, #90, #92, #94 |
| MCP server: `fetch_page`, `fetch_links`, output budget | done | `src/mcp.mjs`, `tests/mcp.test.mjs` |
| MCP load controls: `wait_until`, `settle_ms`, `timeout_ms` on both tools | done | #110 / PR #117, `tests/mcp.test.mjs` |
| README usage block and MCP tool table pinned to `--help` and the tool schema | done | #74 / PR #80, `tests/readme.test.mjs` |
| Shared test helpers (browser skip guard, `runBin`, `assertNoValue`) | done | #115 / PR #121, `tests/helpers.mjs` |

The tracker holds one open issue, #106, the Champion's hold digest (zero
holds), which is not work. There are no open pull requests.

## Now

Nothing is in flight. The 0.5.0 work (#140 to #145) and its follow-ons
(#149, #152 to #156) have all merged and shipped.

## Next

- **Help downstream callers adopt 0.5.0.** The new defaults change behaviour
  for anything running trawl unattended; the 2AMLogic marketing repo's
  screenshot script and its `pulse` tool are tracked in marketing#625.
  Done when: that issue closes.

## Later

Direction, each with the question to answer first.

- **Check `robots.txt` before the browser starts on the `--profile` path.**
  Matters only under `--respect-robots` now. Today a refused run still creates the profile directory and, with `--har`,
  an empty HAR (README, Etiquette). Question: can the profile's cookies for
  `<origin>/robots.txt` be read without launching the browser that owns the
  jar?
- **Stop a redirect into a cooling-down origin.** The cooldown check looks
  only at the origin asked for (README, Etiquette). Question: can the
  navigation's redirect chain be checked before the request leaves, without
  also intercepting subresources?
- **Partitioned cookies under a parent domain on the `robots.txt` request.**
  They are left out although the browser would send them (README,
  Etiquette). Question: is there a site where this changes the verdict?
- **Paging long MCP results.** `src/mcp.mjs` truncates at a character budget
  and says pagination is not in v1. Question: do agents hit the budget on
  pages where `selector` and `fetch_links` do not help?
- **CI beyond Ubuntu.** `trawl login` had a macOS-only hang (#96) and
  `src/browser.mjs` has Windows paths, but CI runs on Ubuntu only. Question:
  which of the browser-resolution and login tests can run headless on those
  runners?
- **Percent-encoding normalisation in `robots.txt` matching** (RFC 9309
  §2.2.2). Both sides are compared exactly as given, so `/a/~file` and
  `/a/%7Efile` are different paths. Question: does any real `robots.txt`
  depend on the normalised reading?

## Blocked and waiting

Nothing is parked on an upstream release, and nothing waits on a decision.
One tracker entry is not work at all:

- **#106** is not work: it is the Champion's merge-risk hold digest, currently
  recording zero holds.

## Not planned

- Proxy rotation, fingerprint spoofing, CAPTCHA solving (README, Etiquette).
- Auto-retrying or solving past anti-bot interstitials; trawl detects and
  refuses a block page, and the documented
  `--wait-until domcontentloaded --settle` recipe is the answer.
- Click, type, navigate, cookies or profiles on the MCP server: it stays
  read-only by design (`src/mcp.mjs` header, README "As an MCP server").
- A hosted service or account: this is the local option (README "Why not X?").
