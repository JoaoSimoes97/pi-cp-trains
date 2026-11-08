// logic.test.mjs — links, stations, the pass and the booking clock: pure functions, no files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchLink, searchLink, siteOrigin } from "../lib/links.mjs";
import { coversDay, makePass, passStatus } from "../lib/pass.mjs";
import { approve, cancel, due, makeBooking, notifyAt, opensAt } from "../lib/schedule.mjs";
import { findStation } from "../lib/stations.mjs";
import { bookingSteps, startPrompt } from "../lib/steps.mjs";

const OR = { code: "94-31039", name: "Lisboa Oriente" };
const CA = { code: "94-2006", name: "Porto Campanhã" };
const at = (s) => new Date(s); // local time, like the module

test("the search address is the one cp.pt opens, and reads back", () => {
	const url = searchLink({ from: OR.code, to: CA.code, date: "2026-11-07" });
	assert.equal(url, "https://www.cp.pt/pt/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=2026-11-07&departureStation=94-31039&arrivalStation=94-2006");
	assert.deepEqual(parseSearchLink(url), { from: OR.code, to: CA.code, date: "2026-11-07", passengers: 1, travelClass: 2 });
	assert.throws(() => searchLink({ from: OR.code, to: OR.code, date: "2026-11-07" }), /same station/);
	assert.throws(() => searchLink({ from: OR.code, to: CA.code, date: "2026-02-30" }), /date/);
	assert.throws(() => searchLink({ from: "Oriente", to: CA.code, date: "2026-11-07" }), /code/);
	assert.equal(parseSearchLink("https://evil.example/pt/resultado-pesquisa?departureStation=94-1&arrivalStation=94-2&startDate=2026-11-07"), null);
	assert.equal(parseSearchLink("not a url"), null);
});

test("the site override takes only a loopback http origin", () => {
	assert.equal(siteOrigin({ CP_TRAINS_SITE: "http://127.0.0.1:5123" }), "http://127.0.0.1:5123");
	assert.equal(siteOrigin({ CP_TRAINS_SITE: "https://evil.example" }), "https://www.cp.pt");
	assert.equal(siteOrigin({ CP_TRAINS_SITE: "http://127.0.0.1.evil.example:80" }), "https://www.cp.pt");
	assert.equal(siteOrigin({}), "https://www.cp.pt");
});

test("stations are found by code, by name without accents, or not at all", () => {
	assert.equal(findStation("94-2006").name, "Porto Campanhã");
	assert.equal(findStation("campanha").code, "94-2006");
	assert.equal(findStation("Oriente").code, "94-31039");
	assert.equal(findStation("Coimbra-B", [{ code: "94-36004", name: "Coimbra-B" }]).code, "94-36004");
	assert.throws(() => findStation("Faro"), /no known station/);
	assert.throws(() => findStation("o", [{ code: "94-1", name: "Ovar" }]), /say which/);
});

test("the pass: days from its first day, and how long it has left", () => {
	const p = makePass({ validFrom: "2026-11-01", days: 30 }, at("2026-11-01T10:00"));
	assert.equal(p.validUntil, "2026-11-30");
	assert.equal(passStatus(p, at("2026-11-08T12:00")).daysLeft, 23); // the 8th to the 30th
	assert.equal(passStatus(p, at("2026-11-08T12:00")).state, "active");
	const last = passStatus(p, at("2026-11-30T20:00"));
	assert.equal(last.daysLeft, 1);
	assert.equal(last.hoursLeft, 4);
	assert.match(last.text, /last day/);
	assert.equal(passStatus(p, at("2026-12-01T00:00")).state, "expired");
	assert.equal(passStatus(p, at("2026-10-30T12:00")).state, "not-started");
	assert.equal(passStatus(null).state, "none");
	assert.ok(coversDay(p, "2026-11-30") && !coversDay(p, "2026-12-01"));
	assert.equal(makePass({ validFrom: "2026-11-01", validUntil: "2026-12-15", source: "mycp" }).validUntil, "2026-12-15");
	assert.throws(() => makePass({ validFrom: "2026-11-01", days: 45 }), /30, 60, 90/);
	assert.throws(() => makePass({ validFrom: "2026-11-10", validUntil: "2026-11-01" }), /before/);
	assert.throws(() => makePass({ validFrom: "2026-11-01", days: 30, source: "web" }), /source/);
});

test("a booking opens 24 h before departure; pi's proposals wait for Approve", () => {
	const now = at("2026-11-08T09:00");
	const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", train: "IC 521" }, { by: "panel", now });
	assert.equal(b.state, "scheduled");
	assert.equal(opensAt(b).getTime(), at("2026-11-09T08:39").getTime());
	assert.equal(notifyAt(b).getTime(), at("2026-11-09T08:34").getTime());
	const p = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { by: "pi", now });
	assert.equal(p.state, "waiting-approval");
	assert.deepEqual(due([p], at("2026-11-09T08:40")), []); // never starts without Approve
	approve(p, now);
	assert.equal(p.state, "scheduled");
	assert.throws(() => approve(p, now), /not waiting/);
	cancel(p, now);
	assert.throws(() => cancel(p, now), /cancelled already/);
	assert.throws(() => makeBooking({ from: OR, to: CA, date: "2026-11-08", time: "09:10" }, { now }), /too soon/);
	assert.throws(() => makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "8:39" }, { now }), /HH:MM/);
	assert.throws(() => makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", expectedTotal: -1 }, { now }), /expectedTotal/);
});

test("due: notify 5 min before, start at the opening, miss when too late", () => {
	const now = at("2026-11-08T09:00");
	const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39" }, { now });
	assert.deepEqual(due([b], at("2026-11-09T08:00")), []);
	assert.deepEqual(due([b], at("2026-11-09T08:35")), [{ id: b.id, action: "notify" }]);
	assert.deepEqual(due([b], at("2026-11-09T08:39")), [{ id: b.id, action: "start" }]);
	b.state = "notified";
	assert.deepEqual(due([b], at("2026-11-09T08:36")), []);
	assert.deepEqual(due([b], at("2026-11-10T08:00")), [{ id: b.id, action: "start" }]); // still 39 min to go
	assert.deepEqual(due([b], at("2026-11-10T08:20")), [{ id: b.id, action: "miss" }]); // under 20 min: too late
	// the window was already open when it was scheduled: it starts at once
	const late = makeBooking({ from: OR, to: CA, date: "2026-11-08", time: "18:00" }, { now });
	assert.deepEqual(due([late], now), [{ id: late.id, action: "start" }]);
});

test("pi's steps carry the link, the expected total and the stop rules", () => {
	const now = at("2026-11-08T09:00");
	const b = makeBooking({ from: OR, to: CA, date: "2026-11-10", time: "08:39", train: "IC 521" }, { now });
	const pass = makePass({ validFrom: "2026-11-01", days: 30 }, now);
	const text = bookingSteps(b, pass, now);
	assert.match(text, /resultado-pesquisa\?passageiros=1&selectedClass=2&startDate=2026-11-10/);
	assert.match(text, /exactly 0\.00 €/);
	assert.match(text, /Never type a password/);
	assert.match(text, /CAPTCHA/);
	assert.match(text, /wait for the user's yes/);
	assert.match(text, /valid on 2026-11-10/);
	assert.match(bookingSteps(b, null, now), /WARNING: the pass/);
	assert.match(startPrompt(b), new RegExp(`tool_cp_trains_booking_steps with id "${b.id}"`));
});
