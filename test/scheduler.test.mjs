// scheduler.test.mjs — the booking clock against a stand-in for the app's API: what it notifies,
// what it hands pi, and that a second look never repeats either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finish, makeBooking, setState, unseen } from "../lib/schedule.mjs";
import { awayReason, startBooking, statusText, tick } from "../lib/scheduler.mjs";
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

// --- results reach the user (0.2.0) ---------------------------------------------------------

const notices = (app) => app.calls.filter((c) => c.method === "notify");

test("pi's report is notified once, with the reference, and stays to see until Seen", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-09T08:39"));
		await store.updateDoc(dir, (doc) => finish(doc.bookings[0], "booked", { note: "bought with the pass", reference: "ABC123", total: 0 }, at("2026-11-09T08:44")));
		await tick(dir, app, at("2026-11-09T08:45"));
		await tick(dir, app, at("2026-11-09T08:45:15"));
		const done = notices(app).filter((c) => /booked/.test(c.params.title));
		assert.equal(done.length, 1, "notified once");
		assert.match(done[0].params.body, /08:39 Lisboa Oriente → Porto Campanhã .*bought with the pass \(ref ABC123, 0\.00 €\)/);
		const doc = store.loadDoc(dir);
		assert.ok(doc.bookings[0].result.notifiedAt);
		assert.equal(statusText(doc, at("2026-11-09T09:00")), "CP: 1 result to see");
		doc.bookings[0].result.seenAt = "2026-11-09T09:01:00.000Z";
		assert.equal(statusText(doc, at("2026-11-09T09:02")), "");
		assert.equal(b.id, doc.bookings[0].id);
	}));

test("stopped and failed reports get their own titles", () =>
	withBooking(async (dir) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-09T08:39"));
		await store.updateDoc(dir, (doc) => finish(doc.bookings[0], "stopped", { note: "the page asked for 12.40 €" }, at("2026-11-09T08:41")));
		await tick(dir, app, at("2026-11-09T08:42"));
		assert.ok(notices(app).some((c) => c.params.title === "CP booking stopped" && /12\.40/.test(c.params.body)));
	}));

test("started, and pi never reports: ended as \"no report\" after 45 min, said once, with the likely reason", () =>
	withBooking(async (dir) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-09T08:39"));
		await tick(dir, app, at("2026-11-09T09:20"), { lastTickAt: at("2026-11-09T09:19:45") });
		assert.equal(store.loadDoc(dir).bookings[0].state, "started", "not yet");
		await tick(dir, app, at("2026-11-09T09:24"), { lastTickAt: at("2026-11-09T09:23:45") });
		await tick(dir, app, at("2026-11-09T09:24:15"), { lastTickAt: at("2026-11-09T09:24") });
		const b = store.loadDoc(dir).bookings[0];
		assert.equal(b.state, "failed");
		assert.equal(b.result.outcome, "no-report");
		assert.match(b.result.note, /^no report: pi did not report: its tab was closed, pi stopped, or it is stuck/);
		const said = notices(app).filter((c) => /no report/.test(c.params.title));
		assert.equal(said.length, 1);
	}));

test("no report because the computer slept: the gap is the reason", () =>
	withBooking(async (dir) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-09T08:39"));
		await tick(dir, app, at("2026-11-09T11:00"), { lastTickAt: at("2026-11-09T08:39") });
		const b = store.loadDoc(dir).bookings[0];
		assert.equal(b.result.outcome, "no-report");
		assert.match(b.result.note, /the computer was asleep or busy \(no check for 141 min\)/);
	}));

test("missed while pi cockpit was closed: said so, notified once, to see", () =>
	withBooking(async (dir) => {
		const app = fakeApp();
		await tick(dir, app, at("2026-11-10T08:30"), { lastTickAt: null });
		await tick(dir, app, at("2026-11-10T08:30:15"), { lastTickAt: at("2026-11-10T08:30") });
		const b = store.loadDoc(dir).bookings[0];
		assert.equal(b.state, "missed");
		assert.match(b.result.note, /its moment passed without starting: pi cockpit was not running then/);
		assert.equal(notices(app).filter((c) => c.params.title === "CP booking missed").length, 1);
		assert.equal(unseen(store.loadDoc(dir).bookings).length, 1);
	}));

test("a booking pi could not be given: notified at once, and not again by the results", () =>
	withBooking(async (dir) => {
		const app = fakeApp({ failSend: true });
		await tick(dir, app, at("2026-11-09T08:40"));
		await tick(dir, app, at("2026-11-09T08:40:15"));
		assert.equal(notices(app).length, 1);
		assert.match(notices(app)[0].params.title, /did not start/);
		assert.equal(store.loadDoc(dir).bookings[0].result.outcome, "failed");
	}));

test("a result kept before 0.2.0 (no at) is neither notified nor shown as to see", () =>
	withBooking(async (dir) => {
		await store.updateDoc(dir, (doc) => {
			setState(doc.bookings[0], "booked", "old");
			doc.bookings[0].result = { outcome: "booked", reference: "OLD", total: 0, note: "old" };
		});
		const app = fakeApp();
		await tick(dir, app, at("2026-11-09T09:00"));
		assert.equal(notices(app).length, 0);
		assert.equal(unseen(store.loadDoc(dir).bookings).length, 0);
	}));

test("awayReason: just started, a long gap, a normal gap", () => {
	assert.match(awayReason(at("2026-11-09T09:00"), null), /not running/);
	assert.match(awayReason(at("2026-11-09T09:00"), at("2026-11-09T08:50")), /asleep or busy \(no check for 10 min\)/);
	assert.equal(awayReason(at("2026-11-09T09:00"), at("2026-11-09T08:59:45")), null);
});
