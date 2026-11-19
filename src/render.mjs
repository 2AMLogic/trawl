// Render a URL in headless Chromium and extract it in a requested shape.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import TurndownService from "turndown";
import { resolveExecutablePath } from "./browser.mjs";
import {
	BudgetError,
	BudgetUnavailableError,
	createBudgetStore,
} from "./budget.mjs";
import {
	CookieParseError,
	addCookiesFailure,
	browserWouldReject,
	cookieHeaderFor,
	filterCookies,
	parseCookies,
} from "./cookies.mjs";
import {
	COOLDOWN_STATUSES,
	CooldownError,
	createCooldownStore,
} from "./cooldown.mjs";
import {
	createPacer,
	defaultStateDir,
	validateMinInterval,
} from "./pacing.mjs";
import {
	ROBOTS_TIMEOUT_MS,
	checkRobotsAllowed,
	crawlDelayMs,
	robotsDenialMessage,
} from "./robots.mjs";
import { stateOrigin, isLoopbackOrigin } from "./state.mjs";

// The public cookie surface, re-exported so a library caller can build the
// list `{ cookies: [...] }` wants without a second entry point: the `exports`
// map has one entry, and a `./cookies` subpath would expose every helper in
// `cookies.mjs` rather than these four. The budget errors ride along the
// same way: a library caller needs to tell "the origin is over its page
// budget" (BudgetError) apart from "the budget state is unusable"
// (BudgetUnavailableError).
export {
	BudgetError,
	BudgetUnavailableError,
	CookieParseError,
	CooldownError,
	browserWouldReject,
	filterCookies,
	parseCookies,
};

const REDACTED = "[redacted]";
const REDACT_HEADERS = new Set([
	"cookie",
	"set-cookie",
	"authorization",
	"proxy-authorization",
]);

// Blank credential values in a parsed HAR (mutates and returns it): the
// Cookie / Set-Cookie / Authorization / Proxy-Authorization headers
// (case-insensitive name) and every request/response cookies[] value. Names
// are kept so the trace stays readable.
export function redactHar(har) {
	for (const entry of har?.log?.entries ?? []) {
		for (const part of [entry?.request, entry?.response]) {
			for (const h of part?.headers ?? []) {
				if (REDACT_HEADERS.has(String(h?.name).toLowerCase())) h.value = REDACTED;
			}
			for (const c of part?.cookies ?? []) c.value = REDACTED;
		}
	}
	return har;
}

// Rewrite a HAR file in place with credentials redacted. Fails closed: if the
// file cannot be read, parsed or rewritten it is deleted and the error thrown,
// so a requested redaction never leaves an unredacted HAR behind.
export function redactHarFile(path) {
	try {
		const har = redactHar(JSON.parse(readFileSync(path, "utf8")));
		writeFileSync(path, JSON.stringify(har, null, 2));
	} catch (err) {
		try {
			rmSync(path, { force: true });
		} catch {}
		throw new Error(
			`could not redact HAR ${path} (file removed): ${err instanceof Error ? err.message : err}`,
		);
	}
}

export const FORMATS = ["text", "html", "links", "title", "markdown"];

const DEFAULTS = {
	format: "text",
	waitUntil: "networkidle",
	settle: 0,
	timeout: 30000,
	viewport: { width: 1280, height: 2000 },
	readability: true,
	authCheck: true,
};

// Thrown instead of returning a body when the rendered page looks like a
// login/auth wall rather than the content the caller asked for. A distinct
// `name` (and the CLI's dedicated exit code 3) lets a calling agent tell
// "the page needs a human to sign in" apart from every other failure mode
// instead of silently treating the login-wall HTML as real content.
export class AuthWallError extends Error {
	constructor(reasons, url) {
		super(
			`page appears to be behind a login wall (matched: ${reasons.join("; ")}). ` +
				"This page needs an authenticated browser session — ask your user to " +
				"sign in with `trawl login <origin> --profile <dir>`, then retry with " +
				"--profile <dir> (or pass --no-auth-check if this isn't actually a login wall).",
		);
		this.name = "AuthWallError";
		this.reasons = reasons;
		this.url = url;
	}
}

// Thrown instead of returning a body when the main-frame response was a
// denial the caller should not treat as content: an HTTP 403 on the page
// itself, or a served-with-200 page carrying an explicit anti-bot challenge
// signal. Recorded against the origin as a cooldown (src/cooldown.mjs), so a
// loop of calls stops at the first one. A distinct `name` (and the CLI's
// exit code 22, curl --fail style) lets a calling agent tell "this origin
// blocked us" apart from a successful read of a blocked-access explainer.
export class BlockedError extends Error {
	constructor(reasons, { url, status } = {}) {
		super(
			`page was blocked (HTTP ${status ?? "unknown"}; matched: ` +
				`${reasons.join("; ")}). The origin was put on a cooldown, so the ` +
				"next call to it refuses until that expires — wait it out, or pass " +
				"--ignore-cooldown (ignoreCooldown: true) to request it anyway. " +
				"A signed-in profile (`trawl login <origin> --profile <dir>`, then " +
				"--profile <dir>) may get through where an anonymous fetch is " +
				"blocked.",
		);
		this.name = "BlockedError";
		this.reasons = reasons;
		this.url = url;
		this.status = status ?? null;
	}
}

// Thrown when a click step cannot run: its selector never became visible,
// its `waitFor` never appeared, or the click tried to navigate the page away.
// `step` is 1-based so it matches the order the caller wrote the steps in.
export class ClickError extends Error {
	constructor(message, { step, selector, waitFor } = {}) {
		super(message);
		this.name = "ClickError";
		this.step = step;
		this.selector = selector;
		this.waitFor = waitFor;
	}
}

// Thrown when a scroll step cannot run: its selector never matched within
// the timeout, the page would not scroll, or the scroll tried to navigate
// the page away. `step` counts the caller's scroll steps from 1, the same
// way ClickError's `step` counts click steps; `selector` carries the step's
// target ("bottom" or the CSS selector as given).
export class ScrollError extends Error {
	constructor(message, { step, selector, cause } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "ScrollError";
		this.step = step;
		this.selector = selector;
	}
}

// Accepts `click` as a string, or an array of strings and/or
// `{ selector, waitFor }` objects, and returns `[{ selector, waitFor }]`.
// Pure, so the CLI and library callers fail the same way on bad input, and
// before any network or browser work.
export function normalizeClickSteps(click) {
	if (click === undefined || click === null) return [];
	const list = Array.isArray(click) ? click : [click];
	return list.map((step, i) => {
		const where = `click step ${i + 1}`;
		const obj = typeof step === "string" ? { selector: step } : step;
		if (!obj || typeof obj !== "object") {
			throw new Error(
				`${where}: expected a CSS selector string or { selector, waitFor }`,
			);
		}
		const { selector, waitFor } = obj;
		if (typeof selector !== "string" || selector.trim() === "") {
			throw new Error(`${where}: selector must be a non-empty CSS selector`);
		}
		if (
			waitFor !== undefined &&
			waitFor !== null &&
			(typeof waitFor !== "string" || waitFor.trim() === "")
		) {
			throw new Error(`${where}: waitFor must be a non-empty CSS selector`);
		}
		return waitFor ? { selector, waitFor } : { selector };
	});
}

// One scroll step: `"bottom"` scrolls the document to its current bottom;
// anything else is a CSS selector whose first match is brought into view.
// Pure, so the CLI, the MCP server and library callers fail the same way on
// bad input, and before any network or browser work.
export function normalizeScrollSteps(scroll) {
	if (scroll === undefined || scroll === null) return [];
	const list = Array.isArray(scroll) ? scroll : [scroll];
	return list.map((step, i) => {
		if (typeof step !== "string" || step.trim() === "") {
			throw new Error(
				`scroll step ${i + 1}: expected "bottom" or a non-empty CSS selector`,
			);
		}
		return { target: step.trim() === "bottom" ? "bottom" : step };
	});
}

// The cap on scroll steps when the caller didn't set one. Low on purpose:
// each step costs a settle pause, and scrolling on is the caller's explicit
// request, step by step — not something to run until exhaustion.
export const DEFAULT_MAX_SCROLLS = 3;

// Validate the scroll surface as a whole: steps normalized, the cap a
// non-negative integer, and no list longer than the cap. Returns
// `{ steps, maxScrolls }` with the default cap applied — pure, so the CLI and
// the MCP server preflight exactly what render() enforces. A cap with no
// steps is valid and bounds nothing: it requests zero steps.
export function normalizeScrollOptions({ scroll, maxScrolls } = {}) {
	const steps = normalizeScrollSteps(scroll);
	const cap = maxScrolls ?? DEFAULT_MAX_SCROLLS;
	if (!Number.isInteger(cap) || cap < 0) {
		throw new Error(
			`maxScrolls must be a non-negative integer, got ${String(maxScrolls)}`,
		);
	}
	if (steps.length > cap) {
		throw new Error(
			`scroll lists ${steps.length} steps but maxScrolls is ${cap}; ` +
				"raise maxScrolls or drop steps",
		);
	}
	return { steps, maxScrolls: cap };
}

// The least a click step pauses after its click (and `waitFor`), whatever
// `settle` says. Click handlers often navigate on a short timer or after a
// microtask hop; this floor gives such a navigation time to reach the route
// below while its step is still the current one, so it fails the run naming
// the right step instead of racing the end of the run. Same idea as the 1s
// floor on the networkidle fallback.
const CLICK_SETTLE_FLOOR_MS = 250;

const isTimeout = (err) =>
	err?.name === "TimeoutError" || /Timeout .*exceeded/.test(err?.message ?? "");

// The context-level navigation guard shared by click and scroll steps: a
// step that tries to load a different top-level document (a link, a form
// submit, a popup or `target=_blank`, a script that sets `location` a moment
// later) is aborted before the request leaves and fails the run, so a run
// still makes exactly one page request and every request trawl makes stays
// paced.
//
// The route stays on the context for the rest of the run, through
// extraction and the screenshot, until the context closes: an interaction
// can navigate any number of milliseconds after it ran, and a guard that
// ended with the steps would let that request out and hand back the other
// page. The caller runs `checkNavigation` once more right before it returns
// results, so a navigation stopped at any point after any step fails the
// run. (Routing turns Playwright's HTTP cache off for the requests the page
// makes after this point; the document and its first subresources have
// already loaded, so that costs close to nothing.)
//
// `steps` is the combined click-then-scroll descriptor list; each entry
// carries the `index`/`count` it reports itself with (its own list's, so
// "scroll step 1 of 2" counts --scroll flags the way "click step 2 of 3"
// counts --click flags).
function installNavGuard(context, steps) {
	// The step now running (1-based across the combined list), and the first
	// top-level navigation it set off: its URL and the step that was running
	// when it was stopped.
	let current = 0;
	let blocked = null;
	const handler = (route) => {
		const request = route.request();
		let topLevel = false;
		if (request.isNavigationRequest()) {
			try {
				topLevel = request.frame().parentFrame() === null;
			} catch {
				// A popup's first navigation is sent before its frame exists, so
				// `frame()` throws. That is a new top-level page: block it.
				topLevel = true;
			}
		}
		if (!topLevel) return route.fallback();
		blocked ??= { url: request.url(), step: current };
		// "aborted", not "blockedbyclient": the latter makes Chromium commit
		// its own error page over the loaded document, which would then be
		// extracted as an empty body.
		return route.abort("aborted");
	};
	const checkNavigation = () => {
		if (!blocked) return;
		const { url, step } = blocked;
		const s = steps[step - 1] ?? {};
		if (s.kind === "scroll") {
			throw new ScrollError(
				`scroll step ${s.index} of ${s.count} ("${s.target}"): the ` +
					`scroll tried to navigate to ${url}; trawl scrolls only to ` +
					"reveal content on the loaded page — fetch that URL directly " +
					"instead",
				{ step: s.index, selector: s.target },
			);
		}
		const { selector, waitFor } = s;
		throw new ClickError(
			`click step ${s.index} of ${s.count} ("${selector}"): the click ` +
				`tried to navigate to ${url}; trawl clicks only to reveal content ` +
				"on the loaded page — fetch that URL directly instead",
			{ step: s.index, selector, waitFor },
		);
	};
	return {
		checkNavigation,
		// Mark the combined-list step now executing, so a navigation blocked
		// while it runs is reported against it.
		begin: (step) => {
			current = step;
		},
		route: () => context.route("**/*", handler),
	};
}

// Press each step's element in order, on the page that is already loaded.
// A click only presses an element already on the page: a click that tries to
// load a different top-level document is aborted before the request leaves
// and fails the run, through the shared nav guard above.
async function runClickSteps(page, guard, steps, { timeout, settle }) {
	const ms = timeout > 0 ? `${timeout}ms` : "the timeout";
	for (let i = 0; i < steps.length; i++) {
		const { selector, waitFor } = steps[i];
		const step = i + 1;
		guard.begin(step);
		const label = `click step ${step} of ${steps.length} ("${selector}")`;
		// The first match in document order, so a selector that matches
		// several buttons presses one instead of tripping strict mode.
		const target = page.locator(selector).first();
		try {
			await target.waitFor({ state: "visible", timeout });
			await target.click({ timeout });
		} catch (err) {
			if (!isTimeout(err)) throw err;
			throw new ClickError(
				`${label}: no visible, clickable element matched within ${ms}`,
				{ step, selector, waitFor },
			);
		}
		guard.checkNavigation();
		if (waitFor) {
			try {
				await page
					.locator(waitFor)
					.first()
					.waitFor({ state: "visible", timeout });
			} catch (err) {
				// A navigation stopped while waiting is the better explanation
				// for a `waitFor` that never appeared.
				guard.checkNavigation();
				if (!isTimeout(err)) throw err;
				throw new ClickError(
					`${label}: "${waitFor}" did not appear within ${ms} after the click`,
					{ step, selector, waitFor },
				);
			}
		}
		await page.waitForTimeout(Math.max(settle, CLICK_SETTLE_FLOOR_MS));
		// Again after the wait and settle: a handler that navigates a
		// moment after the click must fail the run, never pass silently.
		guard.checkNavigation();
	}
	guard.checkNavigation();
}

// Resolves after two animation frames (scroll events are dispatched before
// the first), or after a short cap where frames are throttled.
const SCROLL_FLUSH = () =>
	new Promise((resolve) => {
		const cap = setTimeout(resolve, 250);
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				clearTimeout(cap);
				resolve();
			}),
		);
	});

// Scroll the loaded page step by step, each followed by the render settle
// delay: a lazy loader appends more rows once it sees the page bottom, so
// the next `bottom` step has to come after the appended rows have moved it.
// `"bottom"` scrolls the document to its current bottom; anything else is a
// CSS selector whose first match is brought into view — a target already in
// view completes without scrolling and still counts as a performed step. A
// step that cannot run (a selector that never matched within `timeout`)
// fails the run naming the step and selector; one that would load a
// different top-level document is stopped before the request leaves and
// fails the run, exactly as a click would. Exported for the unit test of
// the message-less-failure wording below — that shape is not reachable
// through a real Playwright call.
export async function runScrollSteps(page, guard, steps, stepOffset, { timeout, settle }) {
	const ms = timeout > 0 ? `${timeout}ms` : "the timeout";
	for (let i = 0; i < steps.length; i++) {
		const { target, index, count } = steps[i];
		guard.begin(stepOffset + i + 1);
		const label = `scroll step ${index} of ${count} ("${target}")`;
		try {
			if (target === "bottom") {
				await page.evaluate(() =>
					window.scrollTo(0, document.documentElement.scrollHeight),
				);
			} else {
				// The first match in document order, like a click's locator.
				await page
					.locator(target)
					.first()
					.scrollIntoViewIfNeeded({ timeout });
			}
			// Let the browser deliver the scroll event before the settle
			// delay: a synchronous loader appends rows in that handler, and
			// the next step must aim at the bottom those rows made.
			await page.evaluate(SCROLL_FLUSH);
		} catch (err) {
			if (!isTimeout(err)) {
				// A selector Playwright cannot parse, or a page that went
				// away: still names the step and target, cause preserved. A
				// rejection without a `message` stringifies to the value
				// itself, so the error names the step instead of crashing
				// before the ScrollError is built.
				throw new ScrollError(
					`${label}: ${String(err?.message ?? err).split("\n")[0]}`,
					{ step: index, selector: target, cause: err },
				);
			}
			// Only a selector step can get here: the bottom target goes
			// through page.evaluate, which takes no timeout, so there is no
			// bottom-specific wording.
			throw new ScrollError(
				`${label}: no element matched, or it could not be scrolled into view, within ${ms}`,
				{ step: index, selector: target, cause: err },
			);
		}
		guard.checkNavigation();
		await page.waitForTimeout(settle);
		// Again after the settle: a handler that navigates a moment
		// after the scroll must fail the run, never pass silently.
		guard.checkNavigation();
	}
	guard.checkNavigation();
}

// Heuristics only — deliberately biased toward false positives over silently
// returning login-wall HTML as if it were the page. A caller that knows
// better has `--no-auth-check` / `authCheck: false`.
const AUTH_TEXT_MAX_CHARS = 200;
const AUTH_KEYWORDS = [
	"sign in",
	"log in",
	"login",
	"authenticate",
	"continue with",
];
// Prefix match against the pathname, so `/login`, `/login/`, and
// `/login?next=/` all count but `/blog/login-tips` does not.
const AUTH_PATH_RE = /^\/(login|log-in|signin|sign-in|oauth2?|auth)(?:\/|$)/i;
const AUTH_HOST_SUFFIXES = [
	"accounts.google.com",
	"appleid.apple.com",
	"login.microsoftonline.com",
	"login.live.com",
];

// Pure and browser-free so it's unit-testable without Chromium: given the
// signals a rendered page can offer, decide whether it looks like an auth
// wall and why. Returns the list of matched reasons (empty = not a wall).
export function detectAuthWall({ text, hasPasswordField, url } = {}) {
	const reasons = [];

	const trimmed = (text ?? "").trim();
	if (trimmed && trimmed.length < AUTH_TEXT_MAX_CHARS) {
		const lower = trimmed.toLowerCase();
		const keyword = AUTH_KEYWORDS.find((kw) => lower.includes(kw));
		if (keyword) {
			reasons.push(`tiny text (${trimmed.length} chars) contains "${keyword}"`);
		}
	}

	if (hasPasswordField) {
		reasons.push("page has a form with a password field");
	}

	if (url) {
		try {
			const { hostname, pathname } = new URL(url);
			const hostHit = AUTH_HOST_SUFFIXES.find(
				(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
			);
			if (hostHit) {
				reasons.push(`URL matches a known auth provider (${hostHit})`);
			} else if (AUTH_PATH_RE.test(pathname)) {
				reasons.push(`URL path looks like a login page (${pathname})`);
			}
		} catch {
			// Not a parseable absolute URL (shouldn't happen for page.url(), but
			// this check is purely advisory — never let it throw).
		}
	}

	return reasons;
}

// Probes the live page for the signals `detectAuthWall` needs. Kept separate
// from `detectAuthWall` so the decision logic stays testable without a
// browser, while this half is exercised by the render() end-to-end tests.
async function probeAuthWall(page) {
	const text = await page
		.locator("body")
		.innerText()
		.catch(() => "");
	const hasPasswordField =
		(await page.$('form input[type="password"]').catch(() => null)) !== null;
	return detectAuthWall({ text, hasPasswordField, url: page.url() });
}

// The one challenge interstitial trawl recognises, deliberately narrow: the
// document title exactly "Just a moment..." (Cloudflare's managed-challenge
// interstitial) together with at least one element of its challenge machinery
// — its form/stage containers, a `cf-chl-*` widget id, or a script loaded
// from `/cdn-cgi/challenge-platform`. Both halves must match, so an ordinary
// article *discussing* blocked access (which may quote the title or the
// markup, but as text) never qualifies, and neither does a stray title. A
// miss fails open — the page renders as today — never closed.
const CHALLENGE_TITLE = "just a moment...";
const CHALLENGE_TITLE_DISPLAY = "Just a moment...";
const CHALLENGE_SELECTOR =
	"#challenge-form, #challenge-stage, #challenge-running, [id^='cf-chl'], " +
	"script[src*='/cdn-cgi/challenge-platform']";

// Pure and browser-free so it's unit-testable without Chromium: given the
// signals a rendered page can offer, decide whether it is a challenge
// interstitial and why. Returns the list of matched reasons (empty = not one).
export function detectChallenge({ title, markerCount } = {}) {
	const titleHit = (title ?? "").trim().toLowerCase() === CHALLENGE_TITLE;
	if (!titleHit || !markerCount) return [];
	return [
		`document title is "${CHALLENGE_TITLE_DISPLAY}"`,
		`${markerCount} challenge element${markerCount === 1 ? " matches" : "s match"} ` +
			"(a challenge-form/stage/running container, a cf-chl-* id, or a " +
			"/cdn-cgi/challenge-platform script)",
	];
}

// Probes the live page for the signals `detectChallenge` needs. Same split as
// `probeAuthWall`: this half is exercised by the render() end-to-end tests.
async function probeChallenge(page) {
	const title = await page.title().catch(() => "");
	let markerCount = 0;
	try {
		markerCount = await page.locator(CHALLENGE_SELECTOR).count();
	} catch {
		// No usable DOM to probe (an unusual page object, a torn-down frame):
		// a failed probe never blocks a render.
		markerCount = 0;
	}
	return detectChallenge({ title, markerCount });
}

// Identify ourselves honestly by default, and link somewhere an operator can
// read what this is and block it if they want. Only a fallback: an explicit
// `userAgent` option (or the CLI's -A/--user-agent) still wins outright.
let cachedUserAgent = null;
export async function defaultUserAgent() {
	if (cachedUserAgent) return cachedUserAgent;
	let version = "0";
	try {
		const { default: pkg } = await import("../package.json", {
			with: { type: "json" },
		});
		version = pkg.version;
	} catch {
		// Packaged oddly or read-restricted — the link matters more than the
		// exact version.
	}
	cachedUserAgent = `trawl/${version} (+https://github.com/2AMLogic/trawl)`;
	return cachedUserAgent;
}

// robots.txt only means something over http(s). `file:` (and anything else)
// has no origin to fetch a robots.txt from, so the check is skipped entirely.
function isHttpUrl(url) {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Readability ships a browser-ready build alongside its Node entry point; we
// inject that file into the page rather than pulling a second DOM
// implementation (jsdom) into Node just to re-parse markup Chromium already
// parsed correctly.
const require = createRequire(import.meta.url);
const READABILITY_PATH = require.resolve("@mozilla/readability/Readability.js");

function markdownConverter() {
	// Turndown's defaults are setext headings and 4-space-indented code; both
	// lose information the moment output is re-parsed, so pin the ATX/fenced
	// forms every Markdown consumer expects.
	return new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
}

// Readability's own README documents running it against a live `document`, so
// hand it the DOM the browser already built (cloned — `parse()` mutates it).
// Returns null when the page has no article-like content.
async function readArticle(page, selector) {
	await page.addScriptTag({ path: READABILITY_PATH });
	return await page.evaluate((sel) => {
		const doc = document.cloneNode(true);
		if (sel) {
			const el = doc.querySelector(sel);
			if (!el) return null;
			// Narrow the clone to the requested scope so --selector still means
			// something; skip when the selector already names the root.
			if (el !== doc.body && el !== doc.documentElement) {
				doc.body.replaceChildren(el);
			}
		}
		// `Readability` is a global declared by the script injected above.
		const article = new Readability(doc).parse();
		if (!article) return null;
		return { title: article.title ?? "", content: article.content ?? "" };
	}, selector ?? null);
}

async function scopedHtml(page, scope) {
	const locator = page.locator(scope);
	const count = await locator.count();
	const parts = [];
	for (let i = 0; i < count; i++) {
		parts.push(await locator.nth(i).innerHTML());
	}
	return parts.join("\n");
}

async function extractMarkdown(page, { selector, readability }) {
	const turndown = markdownConverter();

	if (readability !== false) {
		// Belt-and-braces: `render()` sets `bypassCSP` for this path so the
		// injected <script> survives a nonce/hash-based script-src, but an
		// injection can still fail for reasons we don't control (a page that
		// navigates away mid-extraction, a sandboxed frame). Degrade to the
		// raw-HTML conversion below rather than aborting the whole render —
		// unfiltered Markdown beats a stack trace.
		let article = null;
		try {
			article = await readArticle(page, selector);
		} catch {
			article = null;
		}
		if (article?.content) {
			const body = turndown.turndown(article.content).trim();
			if (!article.title) return body;
			// Readability strips the title heading out of `content` when it
			// duplicates the document title; put it back so the output leads
			// with a heading.
			const heading = `# ${article.title}`;
			return body.split("\n", 1)[0] === heading
				? body
				: `${heading}\n\n${body}`.trim();
		}
	}

	// Either --no-readability, or Readability found nothing article-like and
	// returned null. Convert the scoped markup verbatim — this is the
	// no-heuristics path, and it keeps sparse pages from rendering as "".
	return turndown.turndown(await scopedHtml(page, selector ?? "body")).trim();
}

async function extract(page, { format, selector, readability }) {
	const scope = selector ?? "body";

	if (format === "title") return await page.title();

	if (format === "markdown") {
		return await extractMarkdown(page, { selector, readability });
	}

	if (format === "links") {
		const links = await page.$$eval(`${scope} a[href]`, (as) =>
			as.map((a) => ({ href: a.href, text: a.innerText.trim() })),
		);
		return links.map((l) => `${l.href}\t${l.text}`).join("\n");
	}

	// `text` and `html` both operate on element matches. A page can legitimately
	// contain more than one match (embedded documents produce multiple <body>
	// elements, for instance), so collect them all rather than tripping
	// Playwright's strict mode on an ambiguous locator.
	const locator = page.locator(scope);
	const count = await locator.count();
	if (count === 0) return "";

	const parts = [];
	for (let i = 0; i < count; i++) {
		const el = locator.nth(i);
		parts.push(format === "html" ? await el.innerHTML() : await el.innerText());
	}
	return parts.join("\n");
}

export async function render(url, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	// `md` is an alias, not a format: normalize here so library callers get the
	// same spelling latitude the CLI gives, and FORMATS stays canonical.
	if (opts.format === "md") opts.format = "markdown";
	if (!FORMATS.includes(opts.format)) {
		throw new Error(
			`Unknown format "${opts.format}" (expected one of: ${FORMATS.join(", ")})`,
		);
	}

	// Validated up front, before any network or browser work — even when
	// pacing is off, a nonsensical value is a caller bug worth surfacing.
	// Passed to the pacer only when it was actually supplied, so an omitted
	// value gets the pacer's default floor and its jitter.
	if (opts.minIntervalMs !== undefined) {
		validateMinInterval(opts.minIntervalMs, "minIntervalMs");
	}

	// Validated here for the same reason: a malformed click list is a caller
	// bug, and must not cost a robots.txt request or a browser launch. The
	// scroll surface gets the same treatment: a malformed or over-cap list,
	// or an invalid cap, is rejected before the first request. `maxScrolls`
	// alone (no `scroll`) is valid — a cap without steps requests zero steps.
	const clickSteps = normalizeClickSteps(opts.click);
	const { steps: scrollSteps } = normalizeScrollOptions({
		scroll: opts.scroll,
		maxScrolls: opts.maxScrolls,
	});

	const userAgent = opts.userAgent ?? (await defaultUserAgent());

	// One state directory for everything trawl remembers between runs:
	// `stateDir`, else the legacy `pacingStateDir` — a stand-in for the
	// whole directory when `stateDir` is absent (the pacer alone honours it
	// separately, below) — else $TRAWL_STATE_DIR /
	// ${XDG_CACHE_HOME:-~/.cache}/trawl.
	const stateDir =
		opts.stateDir ?? opts.pacingStateDir ?? defaultStateDir();

	// Per-origin cooldowns (src/cooldown.mjs): a main-frame block (403/429/503,
	// or a challenge page served with 200) seen by any earlier run refuses
	// this one with a CooldownError until it expires — checked here, before
	// robots.txt or any browser work, and again right before each explicit
	// page request. `ignoreCooldown` skips the refusal only; responses are
	// still recorded. Non-http(s) URLs never touch it. Only the requested
	// origin is admitted: a redirect to another origin is not intercepted,
	// though a block there is recorded against it.
	const origin = stateOrigin(url);
	const cooldown = origin ? createCooldownStore({ stateDir }) : null;
	const admit = (checkOpts) => {
		if (!cooldown) return;
		if (opts.ignoreCooldown) cooldown.read(origin);
		else cooldown.check(origin, checkOpts);
	};
	admit();

	// Rolling per-origin page budgets (src/budget.mjs): every render() call
	// is one admitted attempt — the robots probe, the page navigation, its
	// subresources and the networkidle-fallback retry all belong to it —
	// counted per requested origin against a rolling hour and a rolling
	// day, shared across CLI, library and MCP callers of the same state
	// directory. Reserved here, after the cooldown check and before the
	// first robots or page request, so a refused call makes zero requests.
	// `ignoreBudget` skips the refusal only: the attempt is still recorded,
	// and no pacing or cooldown override turns the budget off. Non-http(s)
	// URLs never touch it — and neither does a loopback origin (#164): the
	// budget protects third-party sites, and `localhost`, `127.0.0.0/8` and
	// `[::1]` (literal match, no DNS) are the caller's own machine. A
	// loopback render neither reserves a slot nor records an attempt.
	const loopback = origin ? isLoopbackOrigin(origin) : false;
	const budget = origin && !loopback ? createBudgetStore({ stateDir }) : null;
	await budget?.reserve(origin, { enforce: !opts.ignoreBudget });

	// Cross-run pacing (src/pacing.mjs): every explicit request this call
	// makes to an http(s) origin — the robots.txt fetch, the page navigation,
	// and the networkidle-fallback navigation — waits its turn behind the last
	// request any trawl process made to the same origin. Browser subresources
	// and redirects are not gated. Non-http(s) URLs never touch the state dir.
	// `pacing: false` turns this off and keeps only the in-run Crawl-delay
	// sleep below.
	const pacer =
		opts.pacing !== false && origin
			? createPacer({
					origin,
					stateDir: opts.pacingStateDir ?? stateDir,
					// Omitted → the pacer's own default floor plus its 0–500 ms
					// jitter; an explicit value (validated above) is used
					// exactly as given. A loopback origin (#164) has no
					// default floor: omitted means 0 ms, with no jitter — an
					// explicit value and any Crawl-delay still gate as given,
					// so the pacer itself stays in place.
					minIntervalMs: loopback
						? (opts.minIntervalMs ?? 0)
						: opts.minIntervalMs,
				})
			: null;
	// The Crawl-delay that applies to the page navigation, as learned from
	// this run's robots.txt. `undefined` until (unless) robots.txt is fetched.
	let navCrawlDelayMs;

	// robots.txt is advisory by default (#140, #143): trawl does not gate a
	// user-directed read of one page. We still consult it for http(s) URLs, so
	// a matching group's `Crawl-delay` paces the read, but a matching
	// `Disallow` or an unreachable robots.txt (5xx, network error, timeout,
	// RFC 9309 §2.3.1.4) does not stop it. `respectRobots: true` is the strict
	// opt-in: either of those refuses the read before any page navigation.
	// `ignoreRobots` is accepted and does nothing (including next to
	// `respectRobots`, which still means strict); it used to skip the request.
	// Errors from the pacing and cooldown gates propagate in both modes: they
	// are thrown by their own gates, outside the verdict branch below.
	//
	// Which cookies the request carries depends on the path (#79):
	//   - no cookies, no profile: none; Node fetch, before any browser work.
	//   - `cookies` without `profileDir`: still Node fetch before the launch,
	//     with a `Cookie` header of just the cookies that match
	//     `<origin>/robots.txt` (none match: no header at all).
	//   - `profileDir`: Node fetch, with a `Cookie` header built from the
	//     persistent context's jar (`context.cookies`), so the browser launches
	//     first (see `checkRobots` in the `try` below).
	// Either way the header is trawl's, not the browser's: a cross-origin
	// redirect drops it (Node fetch), a `Set-Cookie` on the robots.txt
	// response is not stored, and the request is not in a `--har`.
	const strictRobots = opts.respectRobots === true;
	const robotsCheck = isHttpUrl(url);
	const robotsViaProfile = robotsCheck && Boolean(opts.profileDir);
	const checkRobots = async ({ fetch, cookie, sentCookies, profile = false }) => {
		const verdict = await checkRobotsAllowed(url, {
			userAgent,
			// Deliberately NOT coupled to `opts.timeout`. Playwright's convention
			// — which `--timeout` inherits — is that `0` means "no timeout". While
			// a robots timeout failed open, borrowing the page budget here made
			// `--timeout 0` (and any implausibly small value) silently skip the
			// check; now that a timeout is a full disallow (RFC 9309 §2.3.1.4),
			// the same coupling would instead refuse every such run.
			// `ROBOTS_TIMEOUT_MS` bounds this fetch independently at 10s — one
			// fixed, sane budget.
			timeout: ROBOTS_TIMEOUT_MS,
			fetch,
			...(cookie && { cookie }),
			// Paced on the Crawl-delay stored by an earlier run (if any), since
			// this run hasn't learned the current policy yet. A failed fetch
			// records the attempt but keeps the stored delay.
			// The cooldown is re-checked after the pacing wait, in case another
			// process recorded one meanwhile.
			...(pacer && {
				gate: (start) => pacer.gate(start, { admit: () => admit() }),
			}),
		});
		if (!verdict.allowed && strictRobots) {
			throw new Error(robotsDenialMessage(verdict, { sentCookies, profile }));
		}
		// An unretrieved robots.txt (`failure`) taught us no policy: keep the
		// delay an earlier run stored. A retrieved one, a matching Disallow
		// included, carries its group's Crawl-delay, which still applies.
		if (verdict.failure) return;
		navCrawlDelayMs = crawlDelayMs(verdict.crawlDelay);
		// Without pacing, honoring `Crawl-delay` means spacing the two requests
		// this run makes — robots.txt, then the page. With pacing, the gate in
		// front of the navigation enforces the same gap (and more).
		if (!pacer && navCrawlDelayMs > 0) await sleep(navCrawlDelayMs);
	};
	if (robotsCheck && !robotsViaProfile) {
		// A secret: it goes into the request header and nowhere else. Always a
		// value Node's fetch accepts (cookies that cannot go in a header are left
		// out, non-ASCII is sent as the same UTF-8 bytes Chromium sends), and
		// with it set a failure is described by an allowlisted code or fixed
		// text only, never the error's message.
		const cookie =
			opts.cookies?.length > 0
				? cookieHeaderFor(opts.cookies, `${new URL(url).origin}/robots.txt`)
				: undefined;
		await checkRobots({ fetch: opts.fetch, cookie, sentCookies: Boolean(cookie) });
	}

	// A Crawl-delay learned this run, else the one an earlier run stored.
	// Read when navigating, since on the `profileDir` path robots.txt is only
	// fetched after the launch.
	const navPolicy = () =>
		navCrawlDelayMs !== undefined
			? { crawlDelayMs: navCrawlDelayMs }
			: { useStoredDelay: true };
	// Each explicit page request re-checks the cooldown last thing before it
	// is sent (after any pacing wait). For the networkidle-fallback retry this
	// is what stops a retry straight into the block the first attempt saw.
	const navigate = async (page, waitUntil, checkOpts) => {
		const start = () => page.goto(url, { waitUntil, timeout: opts.timeout });
		const gateAdmit = () => admit(checkOpts);
		if (pacer) return pacer.gate(start, { ...navPolicy(), admit: gateAdmit });
		gateAdmit();
		return start();
	};

	const executablePath = resolveExecutablePath(opts.executablePath, {
		profileDir: opts.profileDir,
	});
	// Test seam, deliberately undocumented: lets a test stand in for
	// Playwright's `chromium` without a real browser.
	const browserType = opts.browserType ?? chromium;

	const contextOptions = {
		viewport: opts.viewport,
		userAgent,
		// Readability is injected into the page as an inline <script>, which
		// a nonce/hash-based `script-src` blocks outright — github.com and
		// MDN both do this, and the rejection killed the whole render. Scope
		// the bypass to exactly the path that needs it: every other format
		// reads the DOM without injecting anything, so they keep the page's
		// own CSP enforced.
		...(opts.format === "markdown" &&
			opts.readability !== false && { bypassCSP: true }),
		// Bodies are embedded (base64) rather than written as sidecar files
		// so a single `.har` is self-contained and imports cleanly into
		// Chrome DevTools. `mode: "full"` keeps timings and request bodies;
		// "minimal" would drop them.
		...(opts.har && {
			recordHar: {
				path: opts.har,
				content: opts.harOmitContent ? "omit" : "embed",
				mode: "full",
			},
		}),
	};

	// A plain `browser.launch()` starts from a blank profile every time, so
	// nothing a human does in one run (signing in, accepting a cookie banner)
	// is visible to the next. `--profile <dir>` trades that isolation for
	// persistence: `launchPersistentContext` keeps cookies/localStorage on
	// disk under `dir`, so a session established once — by hand, or via
	// `trawl login` — is reused by every later render() call against the same
	// directory. Only `context` exists on this path; there is no separate
	// `browser` handle to close.
	let browser;
	// Declared out here so the `finally` can close the context even if
	// navigation throws — see the teardown comment below.
	let context;
	// Set immediately before the successful return, so the teardown can tell
	// "nothing went wrong" from "an error is already propagating".
	let ok = false;
	let page;
	// Records every main-frame navigation response's block — a 403/429/503
	// status (or a 2xx) — as it arrives, before goto() resolves, so a
	// navigation that then times out waiting for networkidle, or a run that
	// fails later on, still leaves the cooldown behind. Iframes and
	// subresources are ignored, and robots.txt is fetched outside the page
	// (Node fetch, with the jar's cookies on a profile), so neither ever
	// lands here.
	const seenResponses = new WeakSet();
	const onResponse = (response) => {
		try {
			if (!cooldown || seenResponses.has(response)) return;
			seenResponses.add(response);
			const request = response.request();
			if (!request.isNavigationRequest()) return;
			if (request.frame() !== page.mainFrame()) return;
			const status = response.status();
			const at = stateOrigin(response.url());
			if (COOLDOWN_STATUSES.has(status)) {
				cooldown.recordFailure(at, {
					status,
					retryAfter: response.headers()["retry-after"],
				});
			} else if (status >= 200 && status < 300) {
				cooldown.recordSuccess(at);
			}
		} catch {
			// Advisory bookkeeping: it must never take the render down.
		}
	};
	try {
		if (opts.profileDir) {
			mkdirSync(opts.profileDir, { recursive: true });
			context = await browserType.launchPersistentContext(opts.profileDir, {
				executablePath,
				headless: true,
				...contextOptions,
			});
		} else {
			browser = await browserType.launch({ executablePath, headless: true });
			context = await browser.newContext(contextOptions);
		}
		// `cookies`: an already-parsed, already-filtered list (src/cookies.mjs),
		// added before the first page exists, so the first request carries
		// them. On the ephemeral path they die with the context; with
		// `profileDir` too they are written to that profile. Passed as-is:
		// session cookies (`expires: -1`) stay session cookies. A rejection is
		// reported with a fixed message only, never the browser's text, which
		// can quote the cookie; the `finally` still closes everything.
		if (opts.cookies?.length > 0) {
			try {
				await context.addCookies(opts.cookies);
			} catch (err) {
				const known = addCookiesFailure(err);
				throw new Error(
					`could not add cookies to the browser; the page was not fetched${known ? ` (${known})` : ""}`,
				);
			}
		}
		// The `profileDir` path's robots check, with the profile's cookies:
		// after `addCookies`, so it uses the jar the page will. A denial, or an
		// error from the pacing/cooldown gate, throws from here and the
		// `finally` closes the context.
		if (robotsViaProfile) {
			// The jar's cookies for robots.txt as a plain header, so they go out
			// as the same UTF-8 bytes the page request sends. `context.cookies`
			// already applied the browser's URL rules (its loopback `Secure`
			// exception included), so `jar: true` leaves `Secure` to it; a
			// partitioned cookie goes only if its partition is this site's own.
			const robotsUrl = `${new URL(url).origin}/robots.txt`;
			const cookie = cookieHeaderFor(await context.cookies(robotsUrl), robotsUrl, { jar: true });
			await checkRobots({ fetch: opts.fetch, cookie, sentCookies: Boolean(cookie), profile: true });
		}
		page = await context.newPage();
		page.on("response", onResponse);

		// `networkidle` never fires on a page that deliberately keeps a socket
		// open — a websocket, an SSE stream, a long-poll — and that describes a
		// lot of real SPAs (claude.ai among them). The default footgun: the page
		// has usually painted long before the timeout, but the caller sees a
		// bare navigation-timeout failure with no indication the content was
		// ever reachable. On a `networkidle` timeout specifically, retry once
		// against the much cheaper `domcontentloaded` condition instead of
		// failing outright; `waitUntilFallback` on the result says this happened
		// so a caller (the CLI included) can surface it rather than pretend the
		// default just worked.
		let response;
		let waitUntilFallback = null;
		try {
			response = await navigate(page, opts.waitUntil);
		} catch (err) {
			if (opts.waitUntil !== "networkidle" || !/Timeout .*exceeded/.test(err.message)) {
				throw err;
			}
			response = await navigate(page, "domcontentloaded", {
				retrySuppressed: true,
			});
			waitUntilFallback = { from: "networkidle", to: "domcontentloaded" };
		}

		if (opts.waitForSelector) {
			await page.waitForSelector(opts.waitForSelector, {
				timeout: opts.timeout,
			});
		}
		// Some frameworks paint after the network goes idle; `--settle` buys
		// them a fixed grace period. A downgraded wait condition fires far
		// earlier than `networkidle` would have, so floor the grace period at
		// 1s even when the caller didn't ask for one — otherwise the retry
		// above just trades a clean timeout for a race against unfinished JS.
		const settle = waitUntilFallback
			? Math.max(opts.settle, 1000)
			: opts.settle;
		if (settle > 0) await page.waitForTimeout(settle);

		// A main-frame HTTP 403 is a block: refuse it before anything the
		// caller could mistake for content — including auth-wall detection,
		// which judges shape, not permission. The denial itself was already
		// recorded against the responding origin by `onResponse`, so the next
		// call refuses before any request. Nothing has been written anywhere
		// at this point: stdout stays empty and an existing -o file survives.
		if (response?.status() === 403) {
			throw new BlockedError(["main-frame HTTP 403"], {
				url: page.url(),
				status: 403,
			});
		}

		// Checked before extraction returns anything the caller could mistake for
		// real content: a caller that only looks at exit code + stdout must not
		// see a login page reported the same way as a successful fetch. Probes
		// the *full* page regardless of `--selector`, since the wall is usually
		// outside whatever the caller scoped extraction to.
		//
		// Check on load, after the clicks, and after the scrolls. Either
		// interaction can reveal a wall before the next action or extraction.
		const checkAuth = async () => {
			if (opts.authCheck === false) return;
			const reasons = await probeAuthWall(page);
			if (reasons.length > 0) throw new AuthWallError(reasons, page.url());
		};
		// Check for challenges after auth walls so a sign-in wall that also
		// carries challenge markers keeps its AuthWallError.
		const checkChallenge = async () => {
			const reasons = await probeChallenge(page);
			if (reasons.length === 0) return;
			// A served-with-200 challenge records a 403-equivalent block
			// against the responding origin — synchronously, like every
			// recordFailure, so the next admission (including a navigation's
			// networkidle fallback) refuses.
			const at = cooldown ? stateOrigin(page.url()) : null;
			if (at) cooldown.recordFailure(at, { status: 403 });
			throw new BlockedError(reasons, {
				url: page.url(),
				status: response?.status() ?? null,
			});
		};
		await checkAuth();
		await checkChallenge();

		// Click steps run after load, `waitForSelector` and `settle`, in the
		// order given; each waits for its element to be visible, clicks it,
		// waits for its own `waitFor` if any, then `settle` again. Scroll
		// steps then run on the same loaded page, each followed by `settle`
		// again, so lazy content is in the DOM before extraction. One
		// navigation guard covers both, and stays on through extraction and
		// the screenshot; a blocked navigation names whichever step was
		// running when its request was stopped.
		let checkInteractionNav = null;
		if (clickSteps.length > 0 || scrollSteps.length > 0) {
			const clickDescriptors = clickSteps.map((c, i) => ({
				kind: "click",
				...c,
				index: i + 1,
				count: clickSteps.length,
			}));
			const scrollDescriptors = scrollSteps.map((s, i) => ({
				kind: "scroll",
				...s,
				index: i + 1,
				count: scrollSteps.length,
			}));
			const guard = installNavGuard(context, [
				...clickDescriptors,
				...scrollDescriptors,
			]);
			await guard.route();
			if (clickSteps.length > 0) {
				await runClickSteps(page, guard, clickSteps, {
					timeout: opts.timeout,
					settle,
				});
				await checkAuth();
				await checkChallenge();
			}
			if (scrollSteps.length > 0) {
				await runScrollSteps(page, guard, scrollDescriptors, clickSteps.length, {
					timeout: opts.timeout,
					settle,
				});
				await checkAuth();
				await checkChallenge();
			}
			checkInteractionNav = guard.checkNavigation;
		}

		const body = await extract(page, opts);

		// Screenshots ride along on the same navigation as the text output —
		// one page load, both artifacts. Playwright writes and PNG-encodes the
		// file itself when given a `path`.
		let screenshot = null;
		if (opts.screenshot) {
			await page.screenshot({
				path: opts.screenshot,
				fullPage: !!opts.fullPage,
			});
			screenshot = opts.screenshot;
		}

		// Last word on the interaction guard: a navigation a click or scroll
		// set off late — during the auth probe, extraction or the screenshot
		// — was stopped by the route (the page above is still the original),
		// but the run must still fail rather than report success.
		checkInteractionNav?.();

		ok = true;
		return {
			body,
			status: response?.status() ?? null,
			url: page.url(),
			screenshot,
			waitUntilFallback,
			// Every scroll step that ran, counted once each — including a
			// target already in view. 0 without scrolling. runScrollSteps
			// throws on any failed step, so reaching this return implies all
			// of them ran: the requested count is the performed count.
			scrollsPerformed: scrollSteps.length,
		};
	} finally {
		// Land the cooldown writes before anything else can fail: a block
		// (403/429/503 or a served-with-200 challenge) this run saw must be on
		// disk for the next one, whatever happened.
		page?.off("response", onResponse);
		await cooldown?.flush();
		// A recorded HAR is only flushed to disk when the *context* closes, so
		// close it explicitly and first — `browser.close()` alone would lose the
		// trace of exactly the runs worth tracing (a goto that timed out, a host
		// that never resolved).
		let closeError;
		if (context) {
			try {
				await context.close();
			} catch (err) {
				// Swallow a teardown failure only when an error is already
				// propagating: it must not mask the error that got us here. On the
				// success path there is nothing to mask, and closing the context is
				// where the HAR is written — a HAR that could not be written has to
				// surface, the same way a `--output` file that cannot be written
				// does. Rethrow *after* the browser is closed, so a failed HAR
				// write never leaks the browser process.
				if (ok) closeError = err;
			}
		}
		// Only set on the ephemeral (non-`--profile`) path — see the comment
		// above `context`.
		if (browser) await browser.close();
		if (closeError) {
			// The context failed to close, so the HAR may be partial or absent;
			// never leave an unredacted one when redaction was requested.
			if (opts.har && opts.harRedact) rmSync(opts.har, { force: true });
			throw closeError;
		}
		if (opts.har && opts.harRedact && context) {
			if (ok) redactHarFile(opts.har);
			else {
				try {
					redactHarFile(opts.har);
				} catch {
					// An error is already propagating; the unredacted file is gone.
				}
			}
		}
	}
}
