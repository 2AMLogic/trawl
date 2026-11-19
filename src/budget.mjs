// Rolling per-origin page budgets, shared by every trawl entry point.
//
// Pacing (src/pacing.mjs) spaces consecutive requests, but a loop of `trawl`
// calls could keep going forever. This module caps how many renders one
// origin may absorb per rolling hour and per rolling day — 60/hour and
// 200/day, the documented starting policy — counted once per render() call
// at its admission point (the robots probe, the page navigation, its
// subresources and the networkidle-fallback retry all belong to that one
// attempt), and refuses further attempts with a BudgetError (CLI exit 5)
// until a slot rolls free. The check runs after the cooldown check and
// before the first robots.txt or page request, so a refused call makes zero
// requests.
//
// Policy, in one place:
//   - Both windows are enforced on every attempt; the hourly budget is
//     checked first, since it frees sooner.
//   - An attempt is counted when it is admitted, before it is sent —
//     including attempts that then fail. `ignoreBudget` (CLI
//     --ignore-budget) skips the refusal only; the attempt is still
//     recorded, and cooldowns and pacing are untouched. No pacing or
//     cooldown override turns the budget off.
//   - The budget is shared state, not per-call bookkeeping: CLI, library
//     and MCP callers pointed at the same state directory draw on the same
//     per-origin pool.
//
// Storage: `<stateDir>/budget/<digest of origin>.json`, versioned, holding
// a bounded array of admitted-attempt timestamps — entries older than 24 h
// are dropped on every write, and at most DAILY_BUDGET are kept, so the
// file cannot grow without bound even when the override keeps admitting.
// Updates take a short per-origin interprocess lock (src/state.mjs) around
// read → count → write, so two concurrent callers racing for the last slot
// yield exactly one win.
//
// Failure behaviour is deliberately the opposite of the other stores'
// fail-open bias: usage that cannot be safely recorded refuses the attempt
// (BudgetUnavailableError) rather than risking an over-budget request. A
// corrupt or unreadable record means "state unavailable", never "empty
// budget".
//
// Nothing fetched is ever written here: no URLs, credentials, cookies, or
// page content. Files are named by a digest of the canonical origin.
//
// Browser-free, and every side effect (clock, sleep, liveness check) is
// injectable so the policy is testable deterministically.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatDuration } from "./cooldown.mjs";
import {
	LockTimeoutError,
	createFileLock,
	defaultStateDir,
	originDigest,
	writeJsonAtomic,
} from "./state.mjs";

// The starting policy for review: 60 renders per rolling hour, 200 per
// rolling day, per requested origin.
export const HOURLY_BUDGET = 60;
export const DAILY_BUDGET = 200;
export const HOURLY_WINDOW_MS = 60 * 60 * 1000;
export const DAILY_WINDOW_MS = 24 * HOURLY_WINDOW_MS;

// Holders keep a budget lock only for one read → count → write, so a short
// wait is plenty; anything longer is a stuck or foreign lock.
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const STALE_LOCK_MS = 30 * 1000;

const STATE_VERSION = 1;
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
// The largest instant a JavaScript Date can represent.
const MAX_TIME_MS = 8.64e15;

// Raised when every slot in a window is used up. `window` names which one
// ("hourly" or "daily"), and `nextSlotAt` (epoch ms) is when the oldest
// in-window attempt rolls out and a slot frees.
export class BudgetError extends Error {
	constructor({ origin, window, limit, now, nextSlotAt }) {
		const span = window === "hourly" ? "hour" : "24 hours";
		const remainingMs = Math.max(0, nextSlotAt - now);
		super(
			`${origin} has used its ${window} budget of ${limit} renders per ` +
				`rolling ${span}. The next slot frees in ` +
				`${formatDuration(remainingMs)}. Wait until then, or pass ` +
				"--ignore-budget (ignoreBudget: true) to render anyway; the " +
				"attempt is still counted.",
		);
		this.name = "BudgetError";
		this.code = "TRAWL_BUDGET";
		this.origin = origin;
		this.window = window;
		this.limit = limit;
		this.nextSlotAt = nextSlotAt;
		this.remainingMs = remainingMs;
	}
}

// Raised when the attempt cannot be counted at all — an unusable state
// directory, a stuck lock, a corrupt record. Deliberately a different
// error (and CLI exit code 1, not 5) from an exhausted budget: the state
// is unavailable, not spent, so the refusal says so rather than letting a
// caller conclude the origin is over budget.
export class BudgetUnavailableError extends Error {
	constructor(origin, dir, why) {
		super(
			`the page budget for ${origin} could not be recorded (${why}); ` +
				"refusing rather than render past the budget. This is a " +
				`state-directory problem (${dir}), not an exhausted budget: ` +
				"check that the directory is usable and no stuck lock holds it.",
		);
		this.name = "BudgetUnavailableError";
		this.code = "TRAWL_BUDGET_UNAVAILABLE";
		this.origin = origin;
		this.dir = dir;
	}
}

// Validate a record off disk field by field; anything implausible makes the
// whole record unusable (null) — never partially trusted, and never read
// as an empty budget.
export function parseRecord(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || data.version !== STATE_VERSION) {
		return null;
	}
	const { attempts } = data;
	if (!Array.isArray(attempts) || attempts.length > DAILY_BUDGET) return null;
	for (const t of attempts) {
		if (
			typeof t !== "number" ||
			!Number.isSafeInteger(t) ||
			t < 0 ||
			t > MAX_TIME_MS
		) {
			return null;
		}
	}
	// Sorted ascending is a write-side invariant; refuse a file that lost it
	// rather than silently reordering someone else's data.
	for (let i = 1; i < attempts.length; i++) {
		if (attempts[i] < attempts[i - 1]) return null;
	}
	return { attempts };
}

export function createBudgetStore({
	stateDir = defaultStateDir(),
	now = Date.now,
	sleep,
	isAlive,
	pid,
	host,
	lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
	staleLockMs = STALE_LOCK_MS,
} = {}) {
	const dir = path.join(stateDir, "budget");

	const files = (origin) => {
		const digest = originDigest(origin);
		return {
			statePath: path.join(dir, `${digest}.json`),
			lockPath: path.join(dir, `${digest}.lock`),
		};
	};

	const unavailable = (origin, err) =>
		new BudgetUnavailableError(
			origin,
			dir,
			err instanceof LockTimeoutError
				? `its lock stayed busy for ${lockTimeoutMs}ms`
				: (err?.code ?? err?.message ?? String(err)),
		);

	// Count and record one attempt under the origin's lock, so two callers
	// racing for the last slot cannot both win. `enforce: false` records the
	// attempt without refusing (the ignoreBudget path) — it still refuses
	// when the attempt cannot be recorded.
	async function reserve(origin, { enforce = true } = {}) {
		if (!origin) return;
		const { statePath, lockPath } = files(origin);
		let release;
		try {
			mkdirSync(dir, { recursive: true });
		} catch (err) {
			throw unavailable(origin, err);
		}
		try {
			release = await createFileLock({
				lockPath,
				timeoutMs: lockTimeoutMs,
				staleMs: staleLockMs,
				now,
				...(sleep && { sleep }),
				...(isAlive && { isAlive }),
				...(pid !== undefined && { pid }),
				...(host !== undefined && { host }),
			}).acquire();
		} catch (err) {
			throw unavailable(origin, err);
		}
		try {
			let record;
			try {
				record = parseRecord(readFileSync(statePath, "utf8"));
			} catch (err) {
				// No file yet is simply an empty budget; anything else
				// (EACCES, EISDIR, EIO, a corrupt body) is unavailable state.
				if (!ABSENT.has(err?.code)) throw unavailable(origin, err);
				record = { attempts: [] };
			}
			if (record === null) throw unavailable(origin, "its record is corrupt");

			const t = now();
			const attempts = record.attempts.filter((a) => a > t - DAILY_WINDOW_MS);
			const hourly = attempts.filter((a) => a > t - HOURLY_WINDOW_MS);
			if (enforce) {
				if (hourly.length >= HOURLY_BUDGET) {
					throw new BudgetError({
						origin,
						window: "hourly",
						limit: HOURLY_BUDGET,
						now: t,
						nextSlotAt: hourly[0] + HOURLY_WINDOW_MS,
					});
				}
				if (attempts.length >= DAILY_BUDGET) {
					throw new BudgetError({
						origin,
						window: "daily",
						limit: DAILY_BUDGET,
						now: t,
						nextSlotAt: attempts[0] + DAILY_WINDOW_MS,
					});
				}
			}
			// Bounded retention: nothing older than a day, at most the day cap
			// entries (the most recent), whatever the override admitted.
			const kept = [...attempts, t]
				.sort((a, b) => a - b)
				.slice(-DAILY_BUDGET);
			writeJsonAtomic(statePath, { version: STATE_VERSION, attempts: kept });
		} finally {
			release();
		}
	}

	return {
		reserve,
		// Record the attempt without enforcing the cap: the `ignoreBudget`
		// path. Cooldowns and pacing are the caller's business, not this
		// store's.
		record: (origin) => reserve(origin, { enforce: false }),
		dir,
		statePathFor: (origin) => files(origin).statePath,
	};
}
