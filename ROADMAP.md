# trawl roadmap

`trawl` fetches client-rendered web pages from the command line, as a library
and as a read-only MCP server, and behaves politely by default while doing it.

Status as of 2026-11-15, `main` @ `fa6c905`.

This file is the hand-written direction. `WORK_PLAN.md` is the generated view
of the tracker's label state and `WORK_LOG.md` the generated record of what
merged; neither is edited by hand.

## Where it stands

Released: **0.4.0** (tag `v0.4.0`, `CHANGELOG.md`). `[Unreleased]` holds three
entries awaiting a 0.5.0 cut: the MCP load controls, the importable cookie
helpers and the `robots.txt` `*`/`$` matching described below. Everything in
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
| Per-origin pacing across runs, `Crawl-delay` honored | done | #38, `src/pacing.mjs` |
| Per-origin cooldown after 429/503 (exit code 4) | done | #39 / PR #61, `src/cooldown.mjs` |
| Auth-wall detection, `--profile`, `trawl login` (headed, finishes on window close) | done | #22, #24, #95, #96 / PR #98 |
| Cookie import from HAR, `cookies.txt` or copy-as-cURL; `--cookies` for one fetch | done | #36, #76 to #79 / PRs #81, #82, #83, #86 |
| Cookies sent on the `robots.txt` request, header-safe and kept out of errors | done | #87, #89, #91, #93 / PRs #88, #90, #92, #94 |
| MCP server: `fetch_page`, `fetch_links`, output budget | done | `src/mcp.mjs`, `tests/mcp.test.mjs` |
| MCP load controls: `wait_until`, `settle_ms`, `timeout_ms` on both tools | done | #110 / PR #117, `tests/mcp.test.mjs` |
| README usage block and MCP tool table pinned to `--help` and the tool schema | done | #74 / PR #80, `tests/readme.test.mjs` |
| Shared test helpers (browser skip guard, `runBin`, `assertNoValue`) | done | #115 / PR #121, `tests/helpers.mjs` |

The tracker holds four open issues and two open pull requests. #106 is the
Champion's hold digest (zero holds), not work. The rest is live work, all of
it in flight: #112 and #130 each have an approved PR awaiting merge (#133 and
#132 respectively — the README Status refresh and a test-helper timeout fix),
and #124 is the in-progress refresh of this file.

## Now

Each of these fits one pull request, and each has an issue filed.

1. **Bring the README Status section up to date** (#112, PR #133 approved and
   awaiting merge). The section at `README.md:608` still describes "the first
   milestone set" and omits clicking, sign-in, cookies, pacing and cooldowns;
   "see the issues for what's next" points the reader at a tracker that no
   longer matches it.
   Done when: the section names the current capability set in a few lines and
   links this file. Blocked by: nothing; the work is done and merging #133
   closes it.

## Next

- **Release 0.5.0.** Unblocked: #119 has merged, and the one remaining Now
  item is documentation that need not gate the cut. Done when `CHANGELOG.md`
  has a dated `[0.5.0]` entry, `package.json` matches (it still reads
  `0.4.0`), and the tag exists. The three `[Unreleased]` entries are already
  written, and the `robots.txt` one already states that more paths are
  refused than before — that note must survive into the release entry.
  Publishing to npm is a maintainer step.

## Later

Direction, each with the question to answer first.

- **Check `robots.txt` before the browser starts on the `--profile` path.**
  Today a refused run still creates the profile directory and, with `--har`,
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

Nothing is parked on an upstream release, and nothing waits on a decision:
every open issue's work is done or in flight. One tracker entry is not work
at all:

- **#106** is not work: it is the Champion's merge-risk hold digest, currently
  recording zero holds.

The rest of the tracker is in flight rather than dispatchable: #112 and #130
each have an approved PR awaiting merge (#133 and #132), and #124 is this
file's own refresh in progress.

## Not planned

- Proxy rotation, fingerprint spoofing, CAPTCHA solving (README, Etiquette).
- Auto-retrying or solving past anti-bot interstitials; trawl detects and
  refuses a block page, and the documented
  `--wait-until domcontentloaded --settle` recipe is the answer.
- Click, type, navigate, cookies or profiles on the MCP server: it stays
  read-only by design (`src/mcp.mjs` header, README "As an MCP server").
- A hosted service or account: this is the local option (README "Why not X?").
