// scheduler.test.mjs — the booking clock against a stand-in for the app's API: what it notifies,
// what it hands pi, and that a second look never repeats either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBooking } from "../lib/schedule.mjs";
import { startBooking, statusText, tick } from "../lib/scheduler.mjs";
import * as store from "../lib/store.mjs";

const OR = { code: "94-31039", name: "Lisboa Oriente" };
const CA = { code: "94-2006", name: "Porto Campanhã" };
const at = (s) => new Date(s);

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
async function withBooking(fn, input = {}, by = "panel") {
	const dir = mkdtempSync(join(tmpdir(), "cp-trains-sched-"));
	try {
		const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", train: "IC 521", ...input }, { by, now: at("2026-11-08T09:00") });
		await store.updateDoc(dir, (doc) => doc.bookings.push(b));
		await fn(dir, b);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
	}
}

test("5 minutes before: one notification; at the opening: pi gets the booking once", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp();
		assert.deepEqual(await tick(dir, app, at("2026-11-09T08:00")), []);
		await tick(dir, app, at("2026-11-09T08:34"));
		await tick(dir, app, at("2026-11-09T08:35"));
		assert.equal(app.calls.filter((c) => c.method === "notify").length, 1);
		assert.match(app.calls[0].params.title, /5 minutes/);
		assert.equal(store.loadDoc(dir).bookings[0].state, "notified");
		await tick(dir, app, at("2026-11-09T08:39"));
		await tick(dir, app, at("2026-11-09T08:39:20"));
		const sends = app.calls.filter((c) => c.method === "pi.send");
		assert.equal(sends.length, 1);
		assert.match(sends[0].params.text, new RegExp(b.id));
		assert.equal(store.loadDoc(dir).bookings[0].state, "started");
	}));

test("pi cannot be reached: the booking fails, with the reason, and the user is told", () =>
	withBooking(async (dir) => {
		const app = fakeApp({ failSend: true });
		await tick(dir, app, at("2026-11-09T08:40"));
		const b = store.loadDoc(dir).bookings[0];
		assert.equal(b.state, "failed");
		assert.match(b.history.at(-1).note, /pi is not running/);
		assert.ok(app.calls.some((c) => c.method === "notify" && /did not start/.test(c.params.title)));
	}));

test("a moment passed with the app closed: missed, not started late", () =>
	withBooking(async (dir) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-10T08:30"));
		assert.equal(store.loadDoc(dir).bookings[0].state, "missed");
		assert.equal(app.calls.filter((c) => c.method === "pi.send").length, 0);
	}));

test("a proposal never approved is never started", () =>
	withBooking(
		async (dir) => {
			const app = fakeApp();
			assert.equal(store.loadDoc(dir).bookings[0].state, "waiting-approval");
			await tick(dir, app, at("2026-11-09T08:39"));
			assert.equal(app.calls.length, 0);
			await tick(dir, app, at("2026-11-10T08:30"));
			assert.equal(store.loadDoc(dir).bookings[0].state, "missed");
			assert.equal(app.calls.filter((c) => c.method === "pi.send").length, 0);
		},
		{},
		"pi",
	));

test("Run now starts only a scheduled booking", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp();
		assert.deepEqual(await startBooking(dir, app, b.id, "run now", at("2026-11-08T10:00")), { started: true });
		await assert.rejects(startBooking(dir, app, b.id, "again", at("2026-11-08T10:01")), /started/);
	}));

test("status text: the pass and the next booking", () => {
	const doc = store.emptyDoc();
	assert.equal(statusText(doc), "");
	doc.pass = { kind: "verde", validFrom: "2026-11-01", validUntil: "2026-11-30", source: "manual", checkedAt: "" };
	doc.bookings.push(makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { now: at("2026-11-08T09:00") }));
	assert.equal(statusText(doc, at("2026-11-08T12:00")), "CP: pass 23 d · booking 09/11 08:39");
});
