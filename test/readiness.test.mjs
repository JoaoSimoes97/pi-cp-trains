// readiness.test.mjs — the readiness check 30 minutes before the opening, and unattended bookings:
// what pi is asked, what the user is told, and that a check never repeats or buys anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../pi/extension.mjs";
import { makePass } from "../lib/pass.mjs";
import { due, makeBooking } from "../lib/schedule.mjs";
import { checkBooking, tick } from "../lib/scheduler.mjs";
import { bookingSteps, localProblems, readinessPrompt } from "../lib/steps.mjs";
import * as store from "../lib/store.mjs";

const OR = { code: "94-31039", name: "Lisboa Oriente" };
const CA = { code: "94-2006", name: "Porto Campanhã" };
const at = (s) => new Date(s);
const NOW = at("2026-11-08T09:00");
const PASS = makePass({ validFrom: "2026-11-01", days: 30, cardNumber: "V0012345678" }, NOW);

function fakeApp({ failSend = false } = {}) {
	const calls = [];
	return {
		calls,
		call: async (method, params) => {
			calls.push({ method, params });
			if (method === "pi.send" && failSend) throw new Error("pi is not running");
			return { ok: true };
		},
	};
}
async function withDoc(fn, { pass = PASS, input = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "cp-trains-ready-"));
	try {
		const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", ...input }, { now: NOW });
		await store.updateDoc(dir, (doc) => {
			doc.pass = pass;
			doc.bookings.push(b);
		});
		await fn(dir, b);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
	}
}

test("due: the check comes 30 minutes before the opening, once, before the 5-minute notice", () => {
	const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { now: NOW });
	assert.deepEqual(due([b], at("2026-11-09T08:08")), []);
	assert.deepEqual(due([b], at("2026-11-09T08:09")), [{ id: b.id, action: "check" }]);
	b.readiness = { askedAt: at("2026-11-09T08:09").toISOString() };
	assert.deepEqual(due([b], at("2026-11-09T08:20")), []);
	assert.deepEqual(due([b], at("2026-11-09T08:34")), [{ id: b.id, action: "notify" }]);
});

test("the check asks pi once, with what the module found, and buys nothing", () =>
	withDoc(async (dir, b) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-09T08:10"));
		await tick(dir, app, at("2026-11-09T08:11"));
		const sends = app.calls.filter((c) => c.method === "pi.send");
		assert.equal(sends.length, 1);
		assert.match(sends[0].params.text, /Readiness check/);
		assert.match(sends[0].params.text, /Do not buy anything now/);
		assert.match(sends[0].params.text, /\/pt\/mycp/);
		assert.match(sends[0].params.text, new RegExp(`tool_cp_trains_readiness_report \\{ id: "${b.id}"`));
		assert.equal(store.loadDoc(dir).bookings[0].state, "scheduled");
	}));

test("no pi to ask: not ready, said at once", () =>
	withDoc(async (dir) => {
		const app = fakeApp({ failSend: true });
		await tick(dir, app, at("2026-11-09T08:10"));
		const r = store.loadDoc(dir).bookings[0].readiness;
		assert.equal(r.ok, false);
		assert.match(r.problems[0], /pi is not running/);
		assert.equal(app.calls.filter((c) => c.method === "notify" && /not ready/.test(c.params.title)).length, 1);
		await tick(dir, app, at("2026-11-09T08:20"));
		assert.equal(app.calls.filter((c) => c.method === "notify").length, 1);
	}));

test("pi reports a problem: the user is told once; pi does not answer: told after 5 minutes", async () => {
	await withDoc(async (dir, b) => {
		const app = fakeApp();
		const pi = { tools: new Map(), registerTool: (d) => pi.tools.set(d.name, d) };
		extension(pi, { dataDir: dir });
		const report = (p) => pi.tools.get("tool_cp_trains_readiness_report").execute("c", p);
		assert.equal((await report({ id: b.id, ok: true })).isError, true); // not asked yet
		await checkBooking(dir, app, b.id, at("2026-11-09T08:10"));
		const r = await report({ id: b.id, ok: true, problems: ["signed out of cp.pt"] });
		assert.notEqual(r.isError, true);
		assert.equal(store.loadDoc(dir).bookings[0].readiness.ok, false); // a problem makes it not ok
		await tick(dir, app, at("2026-11-09T08:11"));
		await tick(dir, app, at("2026-11-09T08:12"));
		const notes = app.calls.filter((c) => c.method === "notify");
		assert.equal(notes.length, 1);
		assert.match(notes[0].params.body, /signed out of cp\.pt/);
	});
	await withDoc(async (dir, b) => {
		const app = fakeApp();
		await checkBooking(dir, app, b.id, at("2026-11-09T08:10"));
		await tick(dir, app, at("2026-11-09T08:13"));
		assert.equal(app.calls.filter((c) => c.method === "notify").length, 0);
		await tick(dir, app, at("2026-11-09T08:16"));
		const notes = app.calls.filter((c) => c.method === "notify");
		assert.equal(notes.length, 1);
		assert.match(notes[0].params.body, /did not answer/);
	});
});

test("what the module sees itself: pass, card number, terms", () => {
	const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { now: NOW });
	assert.deepEqual(localProblems(b, PASS, NOW), []);
	assert.equal(localProblems(b, null, NOW).length, 2);
	const noCard = makePass({ validFrom: "2026-11-01", days: 30 }, NOW);
	assert.match(localProblems(b, noCard, NOW)[0], /Cartão CP number/);
	const proposed = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { by: "pi", now: NOW });
	assert.match(localProblems(proposed, PASS, NOW)[0], /terms/);
	assert.match(readinessPrompt(b, ["x"]), /Add these the module found: "x"/);
});

test("unattended: only from the panel; no chat yes, every other rule stands", () => {
	const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", unattended: true }, { now: NOW });
	assert.equal(b.unattended, true);
	assert.equal(makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", unattended: true }, { by: "pi", now: NOW }).unattended, false);
	const steps = bookingSteps(b, PASS, NOW);
	assert.match(steps, /UNATTENDED/);
	assert.doesNotMatch(steps, /wait for the user's yes/);
	assert.match(steps, /exactly 0,00 €/);
	assert.match(steps, /any payment method/);
	assert.match(steps, /CAPTCHA/);
	assert.match(steps, /never bypass them/);
	assert.match(bookingSteps(makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { now: NOW }), PASS, NOW), /wait for the user's yes/);
});
