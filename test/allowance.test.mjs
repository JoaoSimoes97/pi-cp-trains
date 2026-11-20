// allowance.test.mjs — "Allow paying up to X €" (0.3.0): the booking keeps the user's amount, pi
// cockpit is asked to confirm it (browser.pay.request), it is armed for the pi tab the booking went
// to, ended at the result, revoked when the booking is cancelled or removed; and a pi cockpit
// without the API leaves the booking as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finish, makeBooking } from "../lib/schedule.mjs";
import { endAllowance, PAY_SITE, requestAllowance, startBooking, tick } from "../lib/scheduler.mjs";
import { bookingSteps } from "../lib/steps.mjs";
import * as store from "../lib/store.mjs";

const OR = { code: "94-31039", name: "Lisboa Oriente" };
const CA = { code: "94-2006", name: "Porto Campanhã" };
const at = (s) => new Date(s);

// a stand-in for pi cockpit's API: browser.pay.request answered as `grant` says
function fakeApp({ grant = true, noApi = false, armFails = false } = {}) {
	const calls = [];
	return {
		calls,
		call: async (method, params, opts) => {
			calls.push({ method, params, opts });
			if (method.startsWith("browser.pay.") && noApi) throw new Error('unknown method "browser.pay.request"');
			if (method === "browser.pay.request") return grant ? { granted: true, grantId: "abcdef012345", site: params.site, max: params.max } : { granted: false };
			if (method === "browser.pay.arm" && armFails) throw new Error("no such payment allowance");
			if (method === "pi.send") return { sent: true, piId: "pi-2" };
			return { ok: true };
		},
	};
}
async function withBooking(fn, input = {}) {
	const dir = mkdtempSync(join(tmpdir(), "cp-trains-pay-"));
	try {
		const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", train: "IC 521", expectedTotal: 12.4, payUpTo: 12.4, ...input }, { by: "panel", now: at("2026-11-08T09:00") });
		await store.updateDoc(dir, (doc) => doc.bookings.push(b));
		await fn(dir, b);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
	}
}
const booking = (dir) => store.loadDoc(dir).bookings[0];

test("payUpTo: the user's amount from the panel only, 0 to 500 €, never below the expected total", () => {
	const base = { from: OR, to: CA, date: "2026-11-10", time: "08:39" };
	const now = { now: at("2026-11-08T09:00") };
	assert.equal(makeBooking({ ...base, payUpTo: 3.5 }, { by: "panel", ...now }).payUpTo, 3.5);
	assert.equal(makeBooking({ ...base }, { by: "panel", ...now }).payUpTo, 0);
	assert.equal(makeBooking({ ...base, payUpTo: 99 }, { by: "pi", ...now }).payUpTo, 0, "pi's proposals never carry one");
	assert.throws(() => makeBooking({ ...base, payUpTo: 501 }, { by: "panel", ...now }), /0 to 500/);
	assert.throws(() => makeBooking({ ...base, payUpTo: -1 }, { by: "panel", ...now }), /0 to 500/);
	assert.throws(() => makeBooking({ ...base, payUpTo: 1.234 }, { by: "panel", ...now }), /two decimals/);
	assert.throws(() => makeBooking({ ...base, expectedTotal: 10, payUpTo: 5 }, { by: "panel", ...now }), /below the expected total/);
});

test("the request: cp.pt, the amount, what for, until the last start; allowed or not, kept with the booking", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp();
		const pay = await requestAllowance(dir, app, b.id, at("2026-11-08T09:00"));
		const req = app.calls.find((c) => c.method === "browser.pay.request");
		assert.equal(req.params.site, PAY_SITE);
		assert.equal(req.params.max, 12.4);
		assert.match(req.params.label, /^CP booking 08:39 Lisboa Oriente → Porto Campanhã \(2026-11-10\)$/);
		assert.ok(Date.parse(req.params.until) < Date.parse("2026-11-10T08:39:00"), "until: the last moment the run may start");
		assert.ok(req.opts.wait >= 60000, "the user reads the dialog: the call waits minutes, not 10 s");
		assert.equal(pay.granted, true);
		assert.equal(booking(dir).pay.grantId, "abcdef012345");
		// not allowed: kept as such
		const no = fakeApp({ grant: false });
		await requestAllowance(dir, no, b.id);
		assert.equal(booking(dir).pay.granted, false);
		assert.match(booking(dir).pay.note, /not allowed/);
	}));

test("an older pi cockpit (no browser.pay): the booking stays as it was, and says why", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp({ noApi: true });
		const pay = await requestAllowance(dir, app, b.id);
		assert.equal(pay.granted, false);
		assert.match(booking(dir).pay.note, /pi cockpit 0\.20 or later/);
		const r = await startBooking(dir, app, b.id, "test", at("2026-11-09T08:39"));
		assert.equal(r.started, true, "the run starts as before");
		assert.ok(!app.calls.some((c) => c.method === "browser.pay.arm"), "nothing to arm");
		assert.doesNotMatch(bookingSteps(booking(dir), null), /allowed paying up to/, "pi's rules are the old ones");
	}));

test("at the run: armed for the pi tab pi.send answered; pi's rules name the allowance", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp();
		await requestAllowance(dir, app, b.id);
		await startBooking(dir, app, b.id, "test", at("2026-11-09T08:39"));
		const arm = app.calls.find((c) => c.method === "browser.pay.arm");
		assert.deepEqual(arm.params, { grantId: "abcdef012345", piId: "pi-2" });
		assert.equal(booking(dir).pay.armedFor, "pi-2");
		const send = app.calls.findIndex((c) => c.method === "pi.send");
		assert.ok(send < app.calls.indexOf(arm), "armed after pi has the booking (pi.send names the tab)");
		assert.match(bookingSteps(booking(dir), null), /allowed paying up to 12,40 € in this run[\s\S]*never choose or fill one|never choose or fill one[\s\S]*allowed paying up to 12,40 €/);
		// arming refused (the grant was revoked meanwhile): said, the run goes on and pages that ask for money ask
		await withBooking(async (dir2, b2) => {
			const app2 = fakeApp({ armFails: true });
			await requestAllowance(dir2, app2, b2.id);
			const r = await startBooking(dir2, app2, b2.id, "test", at("2026-11-09T08:39"));
			assert.equal(r.started, true);
			assert.match(booking(dir2).pay.note, /could not be armed/);
		});
	}));

test("ended at the result (disarm), revoked when cancelled or removed", () =>
	withBooking(async (dir, b) => {
		const app = fakeApp();
		await requestAllowance(dir, app, b.id);
		await startBooking(dir, app, b.id, "test", at("2026-11-09T08:39"));
		await store.updateDoc(dir, (doc) => finish(doc.bookings[0], "booked", { note: "bought", reference: "X1", total: 12.4 }, at("2026-11-09T08:45")));
		await tick(dir, app, at("2026-11-09T08:46"));
		assert.ok(app.calls.some((c) => c.method === "browser.pay.disarm" && c.params.grantId === "abcdef012345"), "disarmed at the result");
		await endAllowance(app, booking(dir), { revoke: true });
		assert.ok(app.calls.some((c) => c.method === "browser.pay.revoke" && c.params.grantId === "abcdef012345"));
		// a booking with no allowance: nothing is called
		const none = fakeApp();
		await endAllowance(none, { pay: null });
		assert.deepEqual(none.calls, []);
	}));
