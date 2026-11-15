// Tests for the shared spawn helpers' contract around timeouts and signal
// kills. A child killed by a signal must not collapse to `code: 0` — that made
// a hung `trawl` indistinguishable from a clean run (issue #122), letting the
// hang burn the 60s cap and still pass. `runBin` gained the contract in PR
// #129; `runCli` has the same one, exercised by spawning `node <entry>` with
// `entry` injected as `-e` (so the script text moves into `args`).

import assert from "node:assert/strict";
import { test } from "node:test";
import { runBin, runCli } from "./helpers.mjs";

test("a child killed by the timeout reports code 124 and its signal", async () => {
	const r = await runBin(
		process.execPath,
		["-e", "setInterval(() => {}, 60000)"],
		{},
		{ timeout: 500 },
	);
	assert.equal(r.code, 124);
	assert.equal(r.signal, "SIGTERM");
});

test("a clean exit still resolves with code 0 and no signal", async () => {
	const r = await runBin(
		process.execPath,
		["-e", "process.exit(0)"],
		{},
		{ timeout: 10000 },
	);
	assert.equal(r.code, 0);
	assert.equal(r.signal, null);
});

test("real exit codes, stdout and stderr round-trip unchanged", async () => {
	const r = await runBin(
		process.execPath,
		["-e", "console.log('out'); console.error('err'); process.exit(3)"],
		{},
		{ timeout: 10000 },
	);
	assert.equal(r.code, 3);
	assert.equal(r.signal, null);
	assert.equal(r.stdout.trim(), "out");
	assert.equal(r.stderr.trim(), "err");
});

test("runCli: a child killed by the timeout reports code 124 and its signal", async () => {
	const r = await runCli(
		["setInterval(() => {}, 60000)"],
		{},
		{ entry: "-e", timeout: 500 },
	);
	assert.equal(r.code, 124);
	assert.equal(r.signal, "SIGTERM");
});

test("runCli: a clean exit still resolves with code 0 and no signal", async () => {
	const r = await runCli(
		["process.exit(0)"],
		{},
		{ entry: "-e", timeout: 10000 },
	);
	assert.equal(r.code, 0);
	assert.equal(r.signal, null);
});

test("runCli: real exit codes, stdout and stderr round-trip unchanged", async () => {
	const r = await runCli(
		["console.log('out'); console.error('err'); process.exit(3)"],
		{},
		{ entry: "-e", timeout: 10000 },
	);
	assert.equal(r.code, 3);
	assert.equal(r.signal, null);
	assert.equal(r.stdout.trim(), "out");
	assert.equal(r.stderr.trim(), "err");
});
