// Scroll steps (--scroll / render({ scroll, maxScrolls })). Parsing and
// preflight tests run anywhere; the end-to-end ones need Chromium and skip
// cleanly without it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/cli.mjs";
import { BlockedError, ScrollError, render, runScrollSteps } from "../src/render.mjs";
import { callTool } from "../src/mcp.mjs";
import {
	browserOpts as opts,
	runViaBin,
	serve as serveRoutes,
	tempDir,
} from "./helpers.mjs";

// Never touch the real ~/.cache/trawl pacing state.
process.env.TRAWL_STATE_DIR = tempDir("trawl-state-");

// A listing taller than the viewport whose lazy loader appends the next
// batch of rows (and a link) a moment after the page's bottom comes near the
// viewport — the shape the issue describes. Two batches render up front
// (rows 1-20, tall enough that the page needs scrolling at the default
// 1280x2000 viewport); each bottom sighting appends ten more rows, up to
// row-60. A footer below the list fills itself in only once scrolled into
// view, for the selector step.
const LISTING = `<!doctype html>
<title>Lazy listing</title>
<style>body { margin: 0 } .row { height: 120px } footer { height: 40px }</style>
<main id="list"></main>
<footer><span id="footer-note"></span></footer>
<script>
  const list = document.getElementById("list");
  let rows = 0;
  const addBatch = () => {
    for (let i = 0; i < 10; i++) {
      rows += 1;
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = "row-" + rows;
      list.appendChild(row);
    }
    const a = document.createElement("a");
    a.href = "/item-" + rows;
    a.textContent = "item " + rows;
    list.appendChild(a);
  };
  addBatch();
  addBatch();
  let scheduled = false;
  window.addEventListener("scroll", () => {
    const nearBottom =
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 200;
    if (nearBottom && !scheduled && rows < 100) {
      scheduled = true;
      setTimeout(() => {
        addBatch();
        scheduled = false;
      }, 120);
    }
  });
  const note = document.getElementById("footer-note");
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !note.textContent) {
        setTimeout(() => {
          note.textContent = "footer note loaded";
        }, 120);
      }
    }
  }).observe(document.getElementById("footer"));
</script>`;

// A page whose scroll handler opens another document a moment after the
// scroll — the navigation guard must stop it before the request leaves.
const NAVIGATING = `<!doctype html>
<title>Scroller</title>
<div style="height: 3000px">tall</div>
<script>
  window.addEventListener("scroll", () => {
    setTimeout(() => {
      location.href = "/other";
    }, 150);
  });
</script>`;

// A page whose footer fills itself in only once scrolled into view — no
// bottom-appending loader, so the selector step's target stays stable. (On
// LISTING itself a selector step at the bottom keeps triggering the loader,
// and the moving footer never settles.)
const FOOTER_PAGE = `<!doctype html>
<title>Footer fixture</title>
<div style="height: 2600px">spacer</div>
<footer id="footer" style="height: 40px"><span id="footer-note"></span></footer>
<script>
  const note = document.getElementById("footer-note");
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !note.textContent) {
        setTimeout(() => {
          note.textContent = "footer note loaded";
        }, 120);
      }
    }
  }).observe(document.getElementById("footer"));
</script>`;

async function serve(extra = {}) {
	const s = await serveRoutes({
		"/robots.txt": (_req, res) => {
			res.writeHead(404);
			res.end();
		},
		"/other": "<title>Other</title><p>other page</p>",
		"/footer": FOOTER_PAGE,
		"/": LISTING,
		...extra,
	});
	return { ...s, url: `${s.origin}/` };
}

const fast = { minIntervalMs: 0 };

// An absence check has to wait: a request the browser let out could still be
// in flight when render() settles. Poll the server log for a bounded window
// and fail the moment `path` shows up.
async function assertNeverRequested(s, path, windowMs = 400) {
	const saw = () => s.hits.filter((h) => h.path === path).map((h) => h.url).join(", ");
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		assert.equal(saw(), "", `server saw ${saw()}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(saw(), "", `server saw ${saw()}`);
}

// --- orchestration through the browserType seam -----------------------------
//
// The same seam cookies-fetch.test.mjs uses: a fake browser stands in for
// Playwright, so the step ordering, settle pacing, counting and the shared
// navigation guard are covered on hosts where no browser can launch. The
// fixture tests above exercise the real thing where Chromium runs.

function fakeBrowser({ failSelector = false, navigateOn = null } = {}) {
	const events = [];
	let routeHandler = null;
	// A top-level navigation request, as the route handler sees one.
	const navRoute = () => ({
		request: () => ({
			isNavigationRequest: () => true,
			frame: () => ({ parentFrame: () => null }),
			url: () => "http://elsewhere.example/other",
		}),
		abort: (reason) => events.push(["abort", reason]),
		fallback: () => events.push("fallback"),
	});
	const page = {
		on: () => {},
		off: () => {},
		url: () => "file:///fixture",
		title: async () => "Fixture",
		waitForTimeout: async (ms) => events.push(["settle", ms]),
		goto: async () => ({ status: () => 200 }),
		evaluate: async (fn) => {
			// The post-scroll event flush is not a scroll step of its own.
			if (String(fn).includes("requestAnimationFrame")) return undefined;
			events.push(["evaluate", "bottom"]);
			if (navigateOn === "bottom" && routeHandler) routeHandler(navRoute());
			return undefined;
		},
		locator: (selector) => ({
			first: () => ({
				waitFor: async () => {},
				click: async () => events.push(["click", selector]),
				scrollIntoViewIfNeeded: async () => {
					events.push(["scrollIntoView", selector]);
					if (failSelector) {
						const err = new Error("Timeout 5000ms exceeded");
						err.name = "TimeoutError";
						throw err;
					}
					if (navigateOn === selector && routeHandler) routeHandler(navRoute());
				},
			}),
		}),
	};
	const context = {
		route: async (pattern, handler) => {
			events.push(["route", pattern]);
			routeHandler = handler;
		},
		newPage: async () => page,
		close: async () => events.push("context.close"),
	};
	const browserType = {
		launch: async () => ({
			newContext: async () => context,
			close: async () => events.push("browser.close"),
		}),
	};
	return { events, browserType };
}

const SEAM = {
	format: "title",
	waitUntil: "load",
	authCheck: false,
	pacing: false,
	ignoreRobots: true,
	timeout: 5000,
};

test("seam: scroll steps run in order, settle each, and count once", async () => {
	const { events, browserType } = fakeBrowser();
	const result = await render("file:///fixture", {
		...SEAM,
		browserType,
		scroll: ["bottom", "#more", "bottom"],
		settle: 40,
	});
	assert.equal(result.body, "Fixture");
	assert.equal(result.scrollsPerformed, 3);
	const what = events
		.filter(([k]) => k === "evaluate" || k === "scrollIntoView")
		.map(([, v]) => v);
	assert.deepEqual(what, ["bottom", "#more", "bottom"]);
	// The post-load pause, then one settle per scroll step.
	const settles = events.filter(([k]) => k === "settle").map(([, ms]) => ms);
	assert.deepEqual(settles, [40, 40, 40, 40]);
});

test("seam: a missing selector is a ScrollError naming the step and selector", async () => {
	const { browserType } = fakeBrowser({ failSelector: true });
	await assert.rejects(
		render("file:///fixture", { ...SEAM, browserType, scroll: ["#nope"] }),
		(err) => {
			assert.ok(err instanceof ScrollError);
			assert.equal(err.step, 1);
			assert.equal(err.selector, "#nope");
			assert.match(err.message, /scroll step 1 of 1 \("#nope"\)/);
			return true;
		},
	);
});

test("seam: a scroll that opens another document is aborted and fails the run", async () => {
	const { events, browserType } = fakeBrowser({ navigateOn: "bottom" });
	await assert.rejects(
		render("file:///fixture", { ...SEAM, browserType, scroll: ["bottom"] }),
		(err) => {
			assert.ok(err instanceof ScrollError);
			assert.match(
				err.message,
				/scroll step 1 of 1 \("bottom"\): the scroll tried to navigate/,
			);
			return true;
		},
	);
	assert.deepEqual(
		events.filter(([k]) => k === "abort"),
		[["abort", "aborted"]],
	);
});

test("seam: no scroll steps installs no guard and reports 0", async () => {
	const { events, browserType } = fakeBrowser();
	const result = await render("file:///fixture", { ...SEAM, browserType });
	assert.equal(result.scrollsPerformed, 0);
	assert.equal(events.some(([k]) => k === "route"), false);
});

test("seam: scrolls after clicks, numbered scroll-locally, one shared guard", async () => {
	const { events, browserType } = fakeBrowser({ navigateOn: "#late" });
	await assert.rejects(
		render("file:///fixture", {
			...SEAM,
			browserType,
			click: ["#a", "#b"],
			scroll: ["bottom", "#late"],
			settle: 5,
		}),
		(err) => {
			assert.ok(err instanceof ScrollError);
			assert.match(err.message, /scroll step 2 of 2 \("#late"\)/);
			return true;
		},
	);
	assert.deepEqual(
		events.filter(([k]) => k === "click" || k === "evaluate" || k === "scrollIntoView").map(([, v]) => v),
		["#a", "#b", "bottom", "#late"],
	);
});

// --- parsing ----------------------------------------------------------------

test("--scroll repeats in order and --max-scrolls parses as a count", () => {
	const args = parseArgs([
		"u",
		"--scroll",
		"bottom",
		"--scroll=#more",
		"--max-scrolls",
		"5",
	]);
	assert.deepEqual(args.scrolls, ["bottom", "#more"]);
	assert.equal(args["--max-scrolls"], "5");
	assert.deepEqual(args._, ["u"]);
});

test("--max-scrolls rejects a non-integer or negative cap", async () => {
	await runViaBin(["u", "--max-scrolls", "1.5"]).then((r) => {
		assert.equal(r.code, 1);
		assert.match(r.stderr, /non-negative integer/);
	});
	await runViaBin(["u", "--max-scrolls", "-1"]).then((r) => {
		assert.equal(r.code, 1);
		assert.match(r.stderr, /non-negative integer/);
	});
});

test("--max-scrolls rejects a blank cap before fetching", async () => {
	const s = await serve();
	try {
		for (const argv of [
			[s.url, "--max-scrolls="],
			[s.url, "--max-scrolls", "   "],
		]) {
			const r = await runViaBin(argv, {}, "trawl-scroll-blank-");
			assert.equal(r.code, 1);
			assert.match(r.stderr, /non-negative integer/);
		}
		assert.equal(s.hits.length, 0, "no request was made");
	} finally {
		await s.close();
	}
});

// --- preflight: rejected before any request ---------------------------------

test("render() rejects an over-cap scroll list before any request", async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, { ...fast, scroll: ["bottom", "bottom", "bottom", "bottom"] }),
			/maxScrolls is 3/,
		);
		assert.deepEqual(s.hits, [], "no robots.txt or page request was made");
	} finally {
		await s.close();
	}
});

test("render() rejects a bad cap, and a step over an explicit cap, before any request", async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, { ...fast, scroll: ["bottom"], maxScrolls: 2.5 }),
			/maxScrolls must be a non-negative integer/,
		);
		await assert.rejects(
			render(s.url, { ...fast, scroll: ["bottom", "bottom"], maxScrolls: 1 }),
			/maxScrolls is 1/,
		);
		await assert.rejects(
			render(s.url, { ...fast, scroll: [""] }),
			/scroll step 1: expected "bottom" or a non-empty CSS selector/,
		);
		assert.deepEqual(s.hits, [], "no robots.txt or page request was made");
	} finally {
		await s.close();
	}
});

// --- library, end to end ----------------------------------------------------

test("zero steps reads the first screen and reports 0 scrolls", opts, async () => {
	const s = await serve();
	try {
		const result = await render(s.url, { ...fast, timeout: 15000 });
		assert.match(result.body, /row-20/);
		assert.doesNotMatch(result.body, /row-21/);
		assert.equal(result.scrollsPerformed, 0);
		assert.equal(s.count("/"), 1, "exactly one request for the listing document");
	} finally {
		await s.close();
	}
});

test("two bottom steps load two more batches and count themselves", opts, async () => {
	const s = await serve();
	try {
		const result = await render(s.url, {
			...fast,
			timeout: 15000,
			scroll: ["bottom", "bottom"],
			settle: 400,
		});
		assert.match(result.body, /row-40/);
		assert.doesNotMatch(result.body, /row-41/);
		assert.equal(result.scrollsPerformed, 2);
		assert.equal(s.count("/"), 1, "exactly one request for the listing document");
	} finally {
		await s.close();
	}
});

test("a raised cap allows more steps than the default boundary", opts, async () => {
	const s = await serve();
	try {
		// Four steps is one past the default cap; the explicitly raised cap
		// admits them, and scrolling stops at the fixture's last batch.
		const result = await render(s.url, {
			...fast,
			timeout: 15000,
			scroll: ["bottom", "bottom", "bottom", "bottom"],
			maxScrolls: 4,
			settle: 400,
		});
		assert.match(result.body, /row-60/);
		assert.doesNotMatch(result.body, /row-61/);
		assert.equal(result.scrollsPerformed, 4);
	} finally {
		await s.close();
	}
});

test("scrolling to a selector loads its lazy content", opts, async () => {
	const s = await serve();
	try {
		const baseline = await render(`${s.origin}/footer`, { ...fast, timeout: 15000 });
		assert.doesNotMatch(baseline.body, /footer note loaded/);
		assert.equal(baseline.scrollsPerformed, 0);

		const scrolled = await render(`${s.origin}/footer`, {
			...fast,
			timeout: 15000,
			scroll: ["#footer"],
			settle: 400,
		});
		assert.match(scrolled.body, /footer note loaded/);
		assert.equal(scrolled.scrollsPerformed, 1);
	} finally {
		await s.close();
	}
});

for (const [event, steps] of [
	["click", { click: ["button"], scroll: ["#absent"] }],
	["scroll", { scroll: ["bottom"] }],
]) {
	test(`a challenge revealed by a ${event} stops the render`, opts, async () => {
		const s = await serve({
			"/": `<!doctype html><title>Listing</title>
				<button>Show more</button><main style="height: 300vh"></main>
				<script>
					window.addEventListener("${event}", () => {
						document.title = "Just a moment...";
						document.querySelector("main").id = "challenge-stage";
					});
				</script>`,
		});
		try {
			// The click case must refuse before attempting the missing scroll target.
			await assert.rejects(
				render(s.url, { ...fast, ...steps, settle: 200, timeout: 3000 }),
				BlockedError,
			);
		} finally {
			await s.close();
		}
	});
}

test("a missing selector fails naming the step and selector", opts, async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, { ...fast, timeout: 1500, scroll: ["#nope"] }),
			(err) => {
				assert.ok(err instanceof ScrollError);
				assert.equal(err.step, 1);
				assert.equal(err.selector, "#nope");
				assert.match(err.message, /scroll step 1 of 1 \("#nope"\)/);
				assert.match(err.message, /no element matched, or it could not be scrolled into view, within 1500ms/);
				return true;
			},
		);
	} finally {
		await s.close();
	}
});

// runScrollSteps is exercised directly so a step can be made to fail with a
// rejection that carries no `message` — a shape no Playwright call produces,
// but one the error template must not crash on (it used to read
// `err.message.split` bare, so the ScrollError never got built).
test("a step that fails with a message-less value still rejects as a ScrollError naming the step", async () => {
	const noMessage = { code: "E_CURSED" };
	const fail = async () => {
		throw noMessage;
	};
	const page = {
		// Selector steps scroll through locator().first(); bottom steps
		// through evaluate(). Either failure reaches the same template.
		locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: fail }) }),
		evaluate: fail,
		waitForTimeout: async () => {},
	};
	const guard = { begin() {}, checkNavigation() {} };

	for (const target of ["#more", "bottom"]) {
		await assert.rejects(
			runScrollSteps(page, guard, [{ target, index: 2, count: 3 }], 0, {
				timeout: 1500,
				settle: 0,
			}),
			(err) => {
				assert.ok(err instanceof ScrollError);
				assert.equal(err.step, 2);
				assert.equal(err.selector, target);
				assert.match(
					err.message,
					new RegExp(`scroll step 2 of 3 \\("${target}"\\)`),
				);
				assert.equal(err.cause, noMessage);
				return true;
			},
		);
	}
});

test("consecutive bottom steps both load on a synchronous loader at the default settle", opts, async () => {
	const SYNC = `<!doctype html>
<title>Sync loader</title>
<div id="rows"><p>batch 0</p></div>
<script>
  let batch = 0;
  window.addEventListener("scroll", () => {
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      batch += 1;
      const sec = document.createElement("p");
      sec.style.height = "3000px";
      sec.textContent = "batch " + batch;
      document.getElementById("rows").appendChild(sec);
    }
  });
  document.getElementById("rows").style.minHeight = "3000px";
</script>`;
	const s = await serve({ "/sync": SYNC });
	try {
		for (let run = 0; run < 5; run++) {
			const r = await render(`${s.origin}/sync`, {
				...fast,
				scroll: ["bottom", "bottom"],
				selector: "#rows",
				format: "text",
			});
			assert.equal(r.scrollsPerformed, 2);
			assert.match(r.body, /batch 2/);
		}
	} finally {
		await s.close();
	}
});

test("an invalid selector fails as a ScrollError naming the step, with the cause", opts, async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, { ...fast, timeout: 1500, scroll: ["bottom", "#bad["] }),
			(err) => {
				assert.ok(err instanceof ScrollError);
				assert.equal(err.step, 2);
				assert.equal(err.selector, "#bad[");
				assert.match(err.message, /scroll step 2 of 2 \("#bad\["\)/);
				assert.ok(err.cause instanceof Error);
				return true;
			},
		);
	} finally {
		await s.close();
	}
});

test("a hidden matching element times out with a message that fits it", opts, async () => {
	const s = await serve({
		"/hidden": `<!doctype html><title>h</title><div id="hidden" style="display:none">x</div>`,
	});
	try {
		await assert.rejects(
			render(`${s.origin}/hidden`, { ...fast, timeout: 500, scroll: ["#hidden"] }),
			(err) => {
				assert.ok(err instanceof ScrollError);
				assert.match(err.message, /could not be scrolled into view, within 500ms/);
				return true;
			},
		);
	} finally {
		await s.close();
	}
});

test("a delayed navigation from a scroll handler fails a scroll-only run, destination unrequested", opts, async () => {
	const s = await serve({ "/": NAVIGATING });
	try {
		await assert.rejects(
			render(s.url, {
				...fast,
				timeout: 15000,
				scroll: ["bottom"],
				settle: 400,
			}),
			(err) => {
				assert.ok(err instanceof ScrollError);
				assert.match(
					err.message,
					/scroll step 1 of 1 \("bottom"\): the scroll tried to navigate/,
				);
				return true;
			},
		);
		await assertNeverRequested(s, "/other");
	} finally {
		await s.close();
	}
});

// --- through the MCP surface, for real --------------------------------------

test("callTool scrolls through a real render and reports the count", opts, async () => {
	const s = await serve();
	try {
		const result = await callTool(
			"fetch_links",
			{ url: s.url, scroll: ["bottom"], settle_ms: 400 },
			{ env: process.env },
		);
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /\/item-30/);
		assert.doesNotMatch(result.content[0].text, /\/item-40/);
		// One link per line — the count never enters the text.
		assert.equal(result.content.length, 1);
		assert.equal(result._meta.scrollsPerformed, 1);
	} finally {
		await s.close();
	}
});

// --- CLI, end to end --------------------------------------------------------

test("the CLI scrolls, keeps stdout clean, and reports the count on stderr", opts, async () => {
	const s = await serve();
	try {
		const r = await runViaBin(
			[
				s.url,
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
				"--settle",
				"400",
				"--timeout",
				"15000",
			],
			{},
			"trawl-scroll-cli-",
		);
		assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
		assert.match(r.stdout, /row-40/);
		assert.doesNotMatch(r.stdout, /row-41/);
		assert.equal(r.stdout.includes("performed"), false, "count leaked into stdout");
		assert.match(r.stderr, /performed 2 scrolls/);
		assert.equal(s.count("/"), 1, "exactly one request for the listing document");
	} finally {
		await s.close();
	}
});

test("the CLI rejects an over-cap list and a bad cap before any request", opts, async () => {
	const s = await serve();
	try {
		const over = await runViaBin(
			[
				s.url,
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
			],
			{},
			"trawl-scroll-cap-",
		);
		assert.equal(over.code, 1);
		assert.match(over.stderr, /maxScrolls is 3/);

		const bad = await runViaBin([s.url, "--max-scrolls", "zero"], {}, "trawl-scroll-cap-");
		assert.equal(bad.code, 1);
		assert.match(bad.stderr, /non-negative integer/);

		assert.equal(s.hits.length, 0, "no request was made");
	} finally {
		await s.close();
	}
});

test("--max-scrolls raises the CLI cap", opts, async () => {
	const s = await serve();
	try {
		const r = await runViaBin(
			[
				s.url,
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
				"--scroll",
				"bottom",
				"--max-scrolls",
				"4",
				"--settle",
				"400",
				"--timeout",
				"15000",
			],
			{},
			"trawl-scroll-cli-",
		);
		assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
		assert.match(r.stdout, /row-60/);
		assert.match(r.stderr, /performed 4 scrolls/);
	} finally {
		await s.close();
	}
});
