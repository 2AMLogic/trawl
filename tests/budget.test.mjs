// Rolling per-origin page budgets (src/budget.mjs) and their wiring into
// render(), the CLI and the MCP server.
//
// The policy is driven by an injected clock and a temporary state directory;
// the renderer integration uses loopback fetch stubs and counts the requests
// they receive. Nothing here reads or writes the real ~/.cache.

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../src/cli.mjs";
import {
	BudgetError,
	BudgetUnavailableError,
	DAILY_BUDGET,
	DAILY_WINDOW_MS,
	HOURLY_BUDGET,
	HOURLY_WINDOW_MS,
	createBudgetStore,
	parseRecord,
} from "../src/budget.mjs";
import { BudgetError as RenderedBudgetError, render } from "../src/render.mjs";
import { callTool } from "../src/mcp.mjs";
import { originDigest } from "../src/state.mjs";
import { binLink, runBin } from "./helpers.mjs";

// render() defaults to $TRAWL_STATE_DIR; never let it fall through to the
// user's real cache.
process.env.TRAWL_STATE_DIR = mkdtempSync(path.join(tmpdir(), "trawl-state-"));

const ORIGIN = "https://example.test";
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const NO_BROWSER = {
	executablePath: path.join(tmpdir(), "trawl-no-such-chrome"),
};
const ROBOTS = "User-agent: *\nAllow: /\n";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "trawl-budget-"));

function clock(start = T0) {
	const c = {
		t: start,
		now: () => c.t,
		advance: (ms) => (c.t += ms),
		// Lock acquisition polls through this: advancing keeps the fake clock
		// consistent with the waits it waited (as tests/pacing.mjs does).
		sleep: async (ms) => (c.t += ms),
	};
	return c;
}

function store(dir, c, extra = {}) {
	return createBudgetStore({ stateDir: dir, now: c.now, sleep: c.sleep, ...extra });
}

// Seed a state file directly: `attempts` is stamped at `at` (fake clock by
// default, real time for render()/CLI tests), ascending.
function seed(s, origin, attempts, at = T0) {
	const stamped = attempts.map((offset) => at - offset).sort((a, b) => a - b);
	mkdirSync(path.dirname(s.statePathFor(origin)), { recursive: true });
	writeFileSync(
		s.statePathFor(origin),
		JSON.stringify({ version: 1, attempts: stamped }),
	);
	return stamped;
}

const readAttempts = (s, origin) =>
	parseRecord(readFileSync(s.statePathFor(origin), "utf8"))?.attempts;

// --- the policy constants, in one place ---

test("the documented starting policy is 60/hour and 200/day", () => {
	assert.equal(HOURLY_BUDGET, 60);
	assert.equal(DAILY_BUDGET, 200);
	assert.equal(HOURLY_WINDOW_MS, 60 * 60 * 1000);
	assert.equal(DAILY_WINDOW_MS, 24 * HOURLY_WINDOW_MS);
});

// --- window boundaries, with a fake clock ---

test("59 reads admit, the 60th admits, the 61st is refused naming the hour", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	for (let i = 0; i < HOURLY_BUDGET; i++) {
		await s.reserve(ORIGIN);
		c.advance(1000);
	}
	assert.equal(readAttempts(s, ORIGIN).length, HOURLY_BUDGET);
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetError);
			assert.equal(err.window, "hourly");
			assert.equal(err.limit, HOURLY_BUDGET);
			// The oldest in-window attempt frees the next slot.
			assert.equal(err.nextSlotAt, T0 + HOURLY_WINDOW_MS);
			assert.equal(err.remainingMs, err.nextSlotAt - c.t);
			assert.match(err.message, /hourly budget of 60/);
			assert.match(err.message, /--ignore-budget/);
			return true;
		},
	);
	// The refusal recorded nothing.
	assert.equal(readAttempts(s, ORIGIN).length, HOURLY_BUDGET);
});

test("an exhausted hour rolls free once its oldest attempt leaves the window", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	for (let i = 0; i < HOURLY_BUDGET; i++) {
		await s.reserve(ORIGIN);
		c.advance(1000);
	}
	await assert.rejects(() => s.reserve(ORIGIN), BudgetError);
	// One millisecond before the oldest rolls out: still refused.
	c.t = T0 + HOURLY_WINDOW_MS - 1;
	await assert.rejects(() => s.reserve(ORIGIN), BudgetError);
	// Now it rolls out, and a slot opens. The rolled-out entry stays in the
	// file (the daily window still needs it) but no longer counts against
	// the hour.
	c.advance(1);
	await s.reserve(ORIGIN);
	const attempts = readAttempts(s, ORIGIN);
	const inHour = attempts.filter((a) => a > c.t - HOURLY_WINDOW_MS);
	assert.equal(inHour.length, HOURLY_BUDGET);
	assert.ok(attempts.every((a) => a > c.t - DAILY_WINDOW_MS), "nothing older than a day is retained");
});

test("an exhausted day is refused naming the day, with 59 in the hour left", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	// 200 attempts across the day, only 59 inside the last hour: the hour is
	// fine, the day is spent. The oldest sits ~20.5h back.
	const attempts = Array.from({ length: 59 }, (_, i) => 1000 * i).concat(
		Array.from({ length: DAILY_BUDGET - 59 }, (_, i) => HOURLY_WINDOW_MS + 1000 + i * 500_000),
	);
	const oldestOffset = Math.max(...attempts);
	seed(s, ORIGIN, attempts);
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetError);
			assert.equal(err.window, "daily");
			assert.equal(err.limit, DAILY_BUDGET);
			assert.equal(err.nextSlotAt, T0 - oldestOffset + DAILY_WINDOW_MS);
			assert.match(err.message, /daily budget of 200/);
			return true;
		},
	);
});

test("with both windows exhausted, the later-freeing one is reported", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	// 200 attempts all inside the last hour: the hour frees a slot at
	// +62min, but the day stays spent until the oldest attempt is 24h gone —
	// the day is the limiting window and must be named, even though the hour
	// is the first found over budget.
	const stamped = seed(s, ORIGIN, Array.from({ length: DAILY_BUDGET }, (_, i) => 1000 * i));
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetError);
			assert.equal(err.window, "daily");
			assert.equal(err.nextSlotAt, stamped[0] + DAILY_WINDOW_MS);
			return true;
		},
	);
	// A normal attempt fits at the advertised instant: the day is down to
	// 199 in-window entries, and only the new attempt joins them.
	c.t = stamped[0] + DAILY_WINDOW_MS;
	await s.reserve(ORIGIN);
	const attempts = readAttempts(s, ORIGIN);
	assert.equal(attempts.length, DAILY_BUDGET);
	assert.equal(attempts[attempts.length - 1], c.t);
});

test("an override-inflated hour frees at its 61st-oldest entry, not its oldest", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	// One attempt 30 minutes back, then 60 stacked on now (the
	// --ignore-budget shape): the hour holds 61, so waiting out the oldest
	// (at +30min) still leaves a full hour's worth. The first normal slot
	// is when 59 of the stacked batch remain, at +60min from now.
	seed(s, ORIGIN, [30 * 60 * 1000, ...Array(HOURLY_BUDGET).fill(0)]);
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetError);
			assert.equal(err.window, "hourly");
			assert.equal(err.nextSlotAt, T0 + HOURLY_WINDOW_MS);
			assert.equal(err.remainingMs, HOURLY_WINDOW_MS);
			return true;
		},
	);
	// At the oldest entry's own rollout (+30min) the hour is still spent.
	c.advance(30 * 60 * 1000);
	await assert.rejects(() => s.reserve(ORIGIN), BudgetError);
	// At the advertised instant the attempt is admitted, alone in its hour.
	c.advance(HOURLY_WINDOW_MS - 30 * 60 * 1000);
	await s.reserve(ORIGIN);
	const inHour = readAttempts(s, ORIGIN).filter((a) => a > c.t - HOURLY_WINDOW_MS);
	assert.deepEqual(inHour, [c.t]);
});

test("a spent day keeps the wait honest even when the hour frees sooner", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	// 50, 50, 40 and 60 reservations at hours −4, −3, −2 and 0: the hour
	// rolls free at +1h, but the day only drops to 199 at +20h, when the
	// −4h batch leaves the 24h window. Refusals must name the day and
	// advertise that instant — retrying at the hour's own slot still fails.
	const HOUR = HOURLY_WINDOW_MS;
	seed(s, ORIGIN, [
		...Array(50).fill(4 * HOUR),
		...Array(50).fill(3 * HOUR),
		...Array(40).fill(2 * HOUR),
		...Array(HOURLY_BUDGET).fill(0),
	]);
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetError);
			assert.equal(err.window, "daily");
			assert.equal(err.limit, DAILY_BUDGET);
			assert.equal(err.nextSlotAt, T0 + 20 * HOUR);
			assert.equal(err.remainingMs, 20 * HOUR);
			return true;
		},
	);
	// The hour's own slot at +1h is not enough while the day is spent.
	c.advance(HOUR);
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => err instanceof BudgetError && err.window === "daily",
	);
	// At the advertised instant the attempt is admitted.
	c.advance(19 * HOUR);
	await s.reserve(ORIGIN);
	const attempts = readAttempts(s, ORIGIN);
	assert.equal(attempts[attempts.length - 1], c.t);
	// The aged-out −4h batch left the record: 150 survivors plus the new one.
	assert.equal(attempts.length, DAILY_BUDGET - 50 + 1);
});

test("the 200th daily read admits; only the 201st is refused", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	seed(s, ORIGIN, Array.from({ length: DAILY_BUDGET - 1 }, (_, i) => DAILY_WINDOW_MS - 1000 - i));
	c.t = T0;
	await s.reserve(ORIGIN);
	assert.equal(readAttempts(s, ORIGIN).length, DAILY_BUDGET);
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => err instanceof BudgetError && err.window === "daily",
	);
});

test("an attempt that later fails still counted at admission", async () => {
	// Counting happens in reserve(), before any request is sent — there is
	// no completion hook to forget. Assert the invariant directly: a reserve
	// with nothing else attached leaves its timestamp behind.
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	await s.reserve(ORIGIN);
	assert.deepEqual(readAttempts(s, ORIGIN), [T0]);
});

// --- sharing and isolation ---

test("a fresh store over the same directory sees the same budget (restart)", async () => {
	const dir = freshDir();
	const c = clock();
	for (let i = 0; i < HOURLY_BUDGET; i++) {
		await store(dir, c).reserve(ORIGIN);
		c.advance(1000);
	}
	// A brand-new store models the next trawl process.
	await assert.rejects(() => store(dir, c).reserve(ORIGIN), BudgetError);
});

test("origins are isolated: another origin still has its full budget", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	for (let i = 0; i < HOURLY_BUDGET + 1; i++) {
		await s.reserve(ORIGIN).catch(() => {});
	}
	await s.reserve("https://other.test");
	assert.equal(readAttempts(s, "https://other.test").length, 1);
});

test("two concurrent callers with one slot left: one win, one refusal", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	seed(s, ORIGIN, Array.from({ length: HOURLY_BUDGET - 1 }, (_, i) => 1000 * i));
	const results = await Promise.allSettled([
		s.reserve(ORIGIN),
		s.reserve(ORIGIN),
	]);
	const fulfilled = results.filter((r) => r.status === "fulfilled");
	const rejected = results.filter(
		(r) => r.status === "rejected" && r.reason instanceof BudgetError,
	);
	assert.equal(fulfilled.length, 1, "exactly one caller got the slot");
	assert.equal(rejected.length, 1, "exactly one caller was refused");
	// The winner's slot is on disk, and nothing else slipped in.
	const attempts = readAttempts(s, ORIGIN);
	assert.equal(attempts.length, HOURLY_BUDGET);
});

// --- bounded retention ---

test("retained history stays bounded: nothing older than a day, at most the day cap", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	// The override keeps admitting well past both caps.
	let lastPrunedAt = 0;
	for (let i = 0; i < 250; i++) {
		await s.record(ORIGIN);
		lastPrunedAt = c.t;
		c.advance(10 * 60 * 1000);
	}
	const attempts = readAttempts(s, ORIGIN);
	assert.ok(attempts.length <= DAILY_BUDGET, `kept ${attempts.length} entries`);
	assert.ok(
		attempts.every((a) => a > lastPrunedAt - DAILY_WINDOW_MS),
		"an entry older than 24h was retained",
	);
});

test("record() (the ignoreBudget path) keeps counting past an exhausted budget", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	for (let i = 0; i < HOURLY_BUDGET; i++) {
		await s.reserve(ORIGIN);
		c.advance(1000);
	}
	await s.record(ORIGIN);
	const attempts = readAttempts(s, ORIGIN);
	assert.equal(attempts.length, HOURLY_BUDGET + 1);
	assert.equal(attempts[attempts.length - 1], c.t);
});

// --- unavailable state is a different failure, and refuses ---

test("a corrupt record is unavailable state, not an empty budget", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	mkdirSync(s.dir, { recursive: true });
	writeFileSync(s.statePathFor(ORIGIN), "{not json");
	await assert.rejects(
		() => s.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetUnavailableError);
			assert.match(err.message, /could not be recorded/);
			assert.doesNotMatch(err.message, /used its .* budget/);
			return true;
		},
	);
	// A future-looking version is just as unusable.
	writeFileSync(
		s.statePathFor(ORIGIN),
		JSON.stringify({ version: 99, attempts: [] }),
	);
	await assert.rejects(() => s.reserve(ORIGIN), BudgetUnavailableError);
});

test("a stuck lock is unavailable state, and refuses", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c, { lockTimeoutMs: 100 });
	await s.reserve(ORIGIN);
	// A live foreign holder (never proven dead, never ancient).
	const lockPath = path.join(dir, "budget", `${originDigest(ORIGIN)}.lock`);
	writeFileSync(
		lockPath,
		JSON.stringify({
			token: "other",
			pid: 4242,
			host: hostname(),
			createdAt: c.t,
		}),
	);
	await assert.rejects(
		() =>
			store(dir, c, {
				lockTimeoutMs: 100,
				isAlive: () => true,
			}).reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetUnavailableError);
			assert.match(err.message, /lock stayed busy/);
			return true;
		},
	);
});

test("a failed write after the lock is unavailable state, not a raw fs error", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	mkdirSync(s.dir, { recursive: true });
	const statePath = s.statePathFor(ORIGIN);
	writeFileSync(statePath, JSON.stringify({ version: 1, attempts: [] }));
	// Fail the write while the lock is held and the record has been read:
	// on this clean path the injected clock's third call inside reserve() is
	// the count taken between read and write, so swapping the record for a
	// directory there makes the atomic rename fail (EISDIR) — the shape of
	// an ENOSPC/EIO failure mid-write.
	let calls = 0;
	const broken = createBudgetStore({
		stateDir: dir,
		sleep: c.sleep,
		now: () => {
			if (++calls === 3) {
				unlinkSync(statePath);
				mkdirSync(statePath);
			}
			return c.t;
		},
	});
	await assert.rejects(
		() => broken.reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetUnavailableError);
			assert.equal(err.code, "TRAWL_BUDGET_UNAVAILABLE");
			assert.match(err.message, /could not be recorded/);
			assert.doesNotMatch(err.message, /used its .* budget/);
			return true;
		},
	);
	// The lock was still released (the finally), so a repaired directory
	// reserves again immediately instead of waiting out a stuck lock.
	rmdirSync(statePath);
	await s.reserve(ORIGIN);
	assert.deepEqual(readAttempts(s, ORIGIN), [c.t]);
});

test("an unusable state directory is unavailable state, and refuses", async () => {
	const parent = freshDir();
	const notADir = path.join(parent, "file");
	writeFileSync(notADir, "occupied");
	const c = clock();
	await assert.rejects(
		() => store(notADir, c).reserve(ORIGIN),
		(err) => {
			assert.ok(err instanceof BudgetUnavailableError);
			return true;
		},
	);
});

// --- render() admission, without a browser ---

test("render() re-exports the budget errors", () => {
	assert.equal(RenderedBudgetError, BudgetError);
});

test("an over-budget origin is refused before robots.txt or browser resolution", async () => {
	const stateDir = freshDir();
	// Non-loopback on purpose: loopback origins are budget-exempt (#164),
	// so the refusal itself is only reachable from an origin the budget
	// governs. `fetch` is injected, so nothing leaves the process.
	const origin = ORIGIN;
	const s = store(stateDir, { now: Date.now });
	seed(
		s,
		origin,
		Array.from({ length: HOURLY_BUDGET }, (_, i) => 1000 * i),
		Date.now(),
	);
	for (const extra of [{}, { ignoreRobots: true }, { pacing: false }]) {
		let fetched = 0;
		await assert.rejects(
			() =>
				render(`${origin}/page`, {
					...NO_BROWSER,
					...extra,
					stateDir,
					fetch: async () => {
						fetched++;
						return new Response(ROBOTS);
					},
				}),
			(err) => err instanceof BudgetError && err.window === "hourly",
		);
		assert.equal(fetched, 0, `fetched robots.txt with ${JSON.stringify(extra)}`);
	}
});

test("unavailable budget state also refuses before any request", async () => {
	const stateDir = freshDir();
	const origin = ORIGIN;
	const s = store(stateDir, { now: Date.now });
	mkdirSync(path.join(stateDir, "budget"), { recursive: true });
	writeFileSync(s.statePathFor(origin), "{not json");
	let fetched = 0;
	await assert.rejects(
		() =>
			render(`${origin}/page`, {
				...NO_BROWSER,
				stateDir,
				fetch: async () => {
					fetched++;
					return new Response(ROBOTS);
				},
			}),
		BudgetUnavailableError,
	);
	assert.equal(fetched, 0);
});

test("ignoreBudget gets past admission and still records the attempt", async () => {
	const stateDir = freshDir();
	const origin = ORIGIN;
	const s = store(stateDir, { now: Date.now });
	seed(
		s,
		origin,
		Array.from({ length: HOURLY_BUDGET }, (_, i) => 1000 * i),
		Date.now(),
	);
	await assert.rejects(
		() =>
			render(`${origin}/page`, {
				...NO_BROWSER,
				stateDir,
				ignoreBudget: true,
				fetch: async () => new Response(ROBOTS),
			}),
		/Chromium binary not found/,
	);
	const attempts = readAttempts(s, origin);
	assert.equal(attempts.length, HOURLY_BUDGET + 1, "the attempt was counted");
	// And the next call without the override is refused again.
	await assert.rejects(
		() =>
			render(`${origin}/page`, { ...NO_BROWSER, stateDir, fetch: async () => new Response(ROBOTS) }),
		BudgetError,
	);
});

test("no pacing or cooldown override disables the budget", async () => {
	const stateDir = freshDir();
	const origin = ORIGIN;
	const s = store(stateDir, { now: Date.now });
	seed(
		s,
		origin,
		Array.from({ length: HOURLY_BUDGET }, (_, i) => 1000 * i),
		Date.now(),
	);
	await assert.rejects(
		() =>
			render(`${origin}/page`, {
				...NO_BROWSER,
				stateDir,
				pacing: false,
				ignoreCooldown: true,
				ignoreRobots: true,
				fetch: async () => new Response(ROBOTS),
			}),
		BudgetError,
	);
});

test("a file: URL never touches the budget state", async () => {
	const stateDir = freshDir();
	const file = path.join(freshDir(), "page.html");
	writeFileSync(file, "<h1>x</h1>");
	await assert.rejects(
		() => render(pathToFileURL(file).href, { ...NO_BROWSER, stateDir }),
		/Chromium binary not found/,
	);
	assert.deepEqual(readdirSync(stateDir), []);
});

test("an admitted render() consumes exactly one slot for all of its requests", async () => {
	const stateDir = freshDir();
	const origin = ORIGIN;
	const s = store(stateDir, { now: Date.now });
	await assert.rejects(
		() =>
			render(`${origin}/page`, {
				...NO_BROWSER,
				stateDir,
				fetch: async () => new Response(ROBOTS),
			}),
		/Chromium binary not found/,
	);
	// The robots probe and any later navigation belong to the one attempt:
	// a single timestamp on disk, not one per request.
	assert.deepEqual(readAttempts(s, origin).length, 1);
});

// --- loopback exemption (#164) ---
// The budget protects third-party sites; loopback origins are the caller's
// own machine, so render() skips the store for them entirely — never
// refused, never counted, no state written.

test("a spent loopback budget neither refuses the render nor records an attempt", async () => {
	const stateDir = freshDir();
	const origin = "http://127.0.0.1:9";
	const s = store(stateDir, { now: Date.now });
	seed(
		s,
		origin,
		Array.from({ length: HOURLY_BUDGET }, (_, i) => 1000 * i),
		Date.now(),
	);
	let fetched = 0;
	await assert.rejects(
		() =>
			render(`${origin}/page`, {
				...NO_BROWSER,
				stateDir,
				fetch: async () => {
					fetched++;
					return new Response(ROBOTS);
				},
			}),
		/Chromium binary not found/,
	);
	assert.equal(fetched, 1, "a spent loopback budget refused the render");
	// Not counted either: the seeded hour is still exactly what it was.
	assert.equal(readAttempts(s, origin).length, HOURLY_BUDGET);
});

test("a loopback render writes no budget state at all", async () => {
	const stateDir = freshDir();
	let fetched = 0;
	await assert.rejects(
		() =>
			render("http://localhost:8/page", {
				...NO_BROWSER,
				stateDir,
				fetch: async () => {
					fetched++;
					return new Response(ROBOTS);
				},
			}),
		/Chromium binary not found/,
	);
	assert.equal(fetched, 1);
	// The pacer still keeps its state (a Crawl-delay must keep gating a
	// loopback navigation), but no budget store ever materialises.
	assert.deepEqual(readdirSync(stateDir), ["pacing"]);
});

test("61 loopback renders in an hour all admit", async () => {
	const stateDir = freshDir();
	const origin = "http://127.0.0.1:9";
	const fetch = async () => new Response(ROBOTS);
	// No minIntervalMs: the loopback default floor is 0 (#164), so this loop
	// runs in moments instead of 61 × ~3 s — which is itself the pacing half
	// of the exemption, asserted directly in tests/render.test.mjs.
	for (let i = 0; i < HOURLY_BUDGET + 1; i++) {
		await assert.rejects(
			() => render(`${origin}/page`, { ...NO_BROWSER, stateDir, fetch }),
			(err) => {
				assert.match(
					err.message,
					/Chromium binary not found/,
					`render ${i + 1} never reached browser resolution (message: ${err.message})`,
				);
				return true;
			},
		);
	}
	assert.ok(
		!readdirSync(stateDir).includes("budget"),
		"a loopback render wrote budget state",
	);
});

// --- CLI and MCP wiring ---

test("--ignore-budget parses as a boolean flag", () => {
	assert.equal(parseArgs(["https://x.test", "--ignore-budget"])["--ignore-budget"], true);
	assert.throws(() => parseArgs(["--ignore-budget=1"]), /Unknown option/);
});

test("the CLI refuses an over-budget origin with exit code 5", async () => {
	const TRAWL_STATE_DIR = freshDir();
	// Non-loopback on purpose (loopback origins are exempt, #164): the
	// refusal is only reachable from an origin the budget governs. It fires
	// before any request, so the origin never has to be reachable either —
	// .test never resolves and no fetch is made at all.
	const origin = ORIGIN;
	const budgetStore = createBudgetStore({ stateDir: TRAWL_STATE_DIR });
	mkdirSync(budgetStore.dir, { recursive: true });
	writeFileSync(
		budgetStore.statePathFor(origin),
		JSON.stringify({
			version: 1,
			attempts: Array.from({ length: HOURLY_BUDGET }, (_, i) => Date.now() - 1000 * i).sort(
				(a, b) => a - b,
			),
		}),
	);
	const { link, cleanup } = binLink();
	try {
		const { code, stderr } = await runBin(
			link,
			[`${origin}/page`, "--executable-path", path.join(tmpdir(), "trawl-no-such-chrome")],
			{ TRAWL_STATE_DIR },
		);
		assert.equal(code, 5);
		assert.match(stderr, /used its hourly budget/);
	} finally {
		cleanup();
	}
});

test("--ignore-budget still counts and renders (exit 1 at browser resolution)", async () => {
	const TRAWL_STATE_DIR = freshDir();
	// Non-loopback on purpose (loopback origins are exempt, #164). .test
	// never resolves — fine here: an unreachable robots.txt is "no policy"
	// in the default advisory mode, so the run proceeds to browser
	// resolution, which is the step the exit-1 assertion pins.
	const origin = ORIGIN;
	const budgetStore = createBudgetStore({ stateDir: TRAWL_STATE_DIR });
	mkdirSync(budgetStore.dir, { recursive: true });
	writeFileSync(
		budgetStore.statePathFor(origin),
		JSON.stringify({
			version: 1,
			attempts: Array.from({ length: HOURLY_BUDGET }, (_, i) => Date.now() - 1000 * i).sort(
				(a, b) => a - b,
			),
		}),
	);
	const { link, cleanup } = binLink();
	try {
		const { code, stderr } = await runBin(
			link,
			[
				`${origin}/page`,
				"--ignore-budget",
				"--executable-path",
				path.join(tmpdir(), "trawl-no-such-chrome"),
			],
			{ TRAWL_STATE_DIR },
		);
		assert.equal(code, 1);
		assert.match(stderr, /Chromium binary not found/);
		const attempts = parseRecord(
			readFileSync(budgetStore.statePathFor(origin), "utf8"),
		).attempts;
		assert.equal(attempts.length, HOURLY_BUDGET + 1);
	} finally {
		cleanup();
	}
});

test("unavailable budget state is exit 1, not the budget code", async () => {
	const TRAWL_STATE_DIR = freshDir();
	// Non-loopback on purpose (loopback origins are exempt, #164); the
	// refusal fires before any request, so the origin never has to resolve.
	const origin = ORIGIN;
	const budgetStore = createBudgetStore({ stateDir: TRAWL_STATE_DIR });
	mkdirSync(budgetStore.dir, { recursive: true });
	writeFileSync(budgetStore.statePathFor(origin), "{not json");
	const { link, cleanup } = binLink();
	try {
		const { code, stderr } = await runBin(
			link,
			[`${origin}/page`, "--executable-path", path.join(tmpdir(), "trawl-no-such-chrome")],
			{ TRAWL_STATE_DIR },
		);
		assert.equal(code, 1);
		assert.match(stderr, /could not be recorded/);
	} finally {
		cleanup();
	}
});

test("MCP reports a budget refusal as a tool error", async () => {
	// Non-loopback on purpose (loopback origins are exempt, #164); the
	// refusal fires before any request, so nothing needs to resolve.
	const origin = ORIGIN;
	const s = createBudgetStore({ stateDir: process.env.TRAWL_STATE_DIR });
	mkdirSync(s.dir, { recursive: true });
	writeFileSync(
		s.statePathFor(origin),
		JSON.stringify({
			version: 1,
			attempts: Array.from({ length: HOURLY_BUDGET }, (_, i) => Date.now() - 1000 * i).sort(
				(a, b) => a - b,
			),
		}),
	);
	const result = await callTool("fetch_page", { url: `${origin}/page` }, { env: {} });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /used its hourly budget/);
});
