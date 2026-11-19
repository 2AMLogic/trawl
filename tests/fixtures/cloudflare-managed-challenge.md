# cloudflare-managed-challenge.html — provenance

`cloudflare-managed-challenge.html` is the response body of a live Cloudflare
managed challenge, byte for byte (`curl -o`, no edits; do not reformat it — the
bytes are the evidence). It is replayed by `tests/cooldown.test.mjs`.

- Captured: 2026-11-19T06:35:43Z, one anonymous `GET https://nowsecure.nl/`
  with plain `curl` from an AWS host (nowsecure.nl is a public bot-detection
  test site fronted by Cloudflare). No cookies, no challenge solved or bypassed.
- Main-document status: **HTTP 403** (not 200), `cf-mitigated: challenge`,
  `server: cloudflare`, `content-type: text/html; charset=UTF-8`,
  `content-length: 5221`, `cf-ray: a5cd324bccf68062-IAD`.
- Title, literal: `Just a moment...` (exact, no padding, English locale).
- Raw-HTML selector observations (before any script runs), for the five
  `CHALLENGE_SELECTOR` parts: `#challenge-form` 0, `#challenge-stage` 0,
  `#challenge-running` 0, `[id^='cf-chl']` 0, `script[src*='/cdn-cgi/challenge-platform']` 0.
  The only `/cdn-cgi/challenge-platform` text is a string inside the inline
  `<script>`, which sets `a.src = '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=…'`
  on a script element it creates at run time. The only element id in the
  served HTML is `challenge-error-text` (inside `<noscript>`).
- Replayed through `render()` in Chromium: served as the live 403 it is refused
  by the main-frame 403 check; served with a 200 (a synthetic status — see the
  test) the detector matches with exactly one element, the injected script.

The live status was 403, so the HTTP 200 case the detector exists for was NOT
observed live; the 200 replay only shows that the page's own markup satisfies
both halves of the predicate once its inline script has run.
