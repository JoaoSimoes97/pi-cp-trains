// schedule.mjs — bookings scheduled for the moment CP opens them.
//
// With the Passe Ferroviário Verde a ticket can be taken only from 24 hours before the train
// leaves (`openHoursBefore`, 24 unless the user says otherwise). A booking is the user's order
// for one train; the module's server looks at the list every few seconds (tick) and, at the
// right moments, notifies the user and hands the booking to pi, which carries it out in the
// Browser panel (steps.mjs).
//
// A booking's life:
//   waiting-approval  pi proposed it: nothing happens until the user presses Approve in the panel
//   scheduled         approved (in the panel); waits for its moment
//   notified          the "booking in 5 minutes: sign in to cp.pt" notification was shown
//   started           handed to pi at the opening (or at once, when the window was already open)
//   booked | failed | stopped   what pi reported (tool_cp_trains_booking_report)
//   missed            its moment passed without it starting (the app closed, the PC asleep…)
//   cancelled         the user cancelled it
// Times are this computer's local time (Portugal), as "YYYY-MM-DD" and "HH:MM".
import { randomBytes } from "node:crypto";
import { isDay, isStationCode } from "./links.mjs";

export const NOTIFY_BEFORE_MS = 5 * 60 * 1000;
// Starting later than this before departure is pointless: pi would not finish before the train.
export const LAST_START_BEFORE_DEPARTURE_MS = 20 * 60 * 1000;
export const STATES = Object.freeze(["waiting-approval", "scheduled", "notified", "started", "booked", "failed", "stopped", "missed", "cancelled"]);
export const OPEN = Object.freeze(["waiting-approval", "scheduled", "notified", "started"]);
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_LABEL = 80;

export const departureAt = (b) => {
	const [y, m, d] = b.date.split("-").map(Number);
	const [hh, mm] = b.time.split(":").map(Number);
	return new Date(y, m - 1, d, hh, mm);
};
export const opensAt = (b) => new Date(departureAt(b).getTime() - b.openHoursBefore * 3600000);
export const notifyAt = (b) => new Date(opensAt(b).getTime() - NOTIFY_BEFORE_MS);
// The readiness check (scheduler.mjs): pi looks that everything is in place, early enough for
// the user to fix what is not (sign in again, turn a switch on).
export const READINESS_BEFORE_MS = 30 * 60 * 1000;
export const readinessAt = (b) => new Date(opensAt(b).getTime() - READINESS_BEFORE_MS);
const lastStartAt = (b) => new Date(departureAt(b).getTime() - LAST_START_BEFORE_DEPARTURE_MS);

const station = (s, field) => {
	if (!s || !isStationCode(s.code) || typeof s.name !== "string" || !s.name.trim()) throw new Error(`${field} must be a station { code, name }`);
	return { code: s.code, name: s.name.trim().slice(0, MAX_LABEL) };
};
const label = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);

// A new booking, checked. `by` is "panel" (the user's own press: scheduled at once) or "pi"
// (waits for the user's Approve).
export function makeBooking(input = {}, { by = "panel", now = new Date() } = {}) {
	if (by !== "panel" && by !== "pi") throw new Error("by must be panel or pi");
	const from = station(input.from, "from");
	const to = station(input.to, "to");
	if (from.code === to.code) throw new Error("from and to are the same station");
	if (!isDay(input.date)) throw new Error("date must be a day as YYYY-MM-DD");
	if (!TIME.test(String(input.time ?? ""))) throw new Error("time must be the departure as HH:MM");
	const passengers = Number(input.passengers ?? 1);
	if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9) throw new Error("passengers must be 1 to 9");
	const travelClass = Number(input.travelClass ?? 2);
	if (travelClass !== 1 && travelClass !== 2) throw new Error("travelClass must be 1 or 2");
	const expectedTotal = Number(input.expectedTotal ?? 0);
	if (!Number.isFinite(expectedTotal) || expectedTotal < 0 || expectedTotal > 500) throw new Error("expectedTotal must be euros, 0 to 500");
	const openHoursBefore = Number(input.openHoursBefore ?? 24);
	if (!Number.isFinite(openHoursBefore) || openHoursBefore < 0 || openHoursBefore > 24 * 60) throw new Error("openHoursBefore must be hours, 0 to 1440");
	// The seat: "cp" keeps the one CP picks; "emptiest" moves to the emptiest carriage that is
	// not full ("Alterar lugares", as walked on cp.pt). seatNote is a wish pi tries there
	// ("a seat with a socket", "91"), never a reason to stop.
	const seatChoice = input.seatChoice === "emptiest" ? "emptiest" : "cp";
	// Unattended: nobody answers in chat; the user's Schedule/Approve is the yes (steps.mjs). Only
	// the user's own press in the panel sets it; pi's proposals are never unattended.
	const unattended = by === "panel" && input.unattended === true;
	const b = {
		id: `b${now.getTime().toString(36)}${randomBytes(3).toString("hex")}`,
		seatChoice,
		seatNote: label(input.seatNote),
		unattended,
		readiness: null, // { askedAt, reportedAt?, ok?, problems?, notified? }
		from,
		to,
		date: input.date,
		time: input.time,
		train: label(input.train),
		passengers,
		travelClass,
		usePass: input.usePass !== false,
		expectedTotal: Math.round(expectedTotal * 100) / 100,
		openHoursBefore,
		state: by === "panel" ? "scheduled" : "waiting-approval",
		createdBy: by,
		createdAt: now.toISOString(),
		approvedAt: by === "panel" ? now.toISOString() : null,
		// CP's buy dialog has one box: "Aceitar termos e condições enumerados de seguida" (its sale
		// conditions, terms and privacy policy, over 16). The user's own press in the panel
		// (Schedule, or Approve) is their acceptance for this purchase, said beside the button;
		// pi ticks the box only for a booking that has it, and never sets it.
		termsAcceptedAt: by === "panel" ? now.toISOString() : null,
		history: [{ at: now.toISOString(), state: by === "panel" ? "scheduled" : "waiting-approval", note: by === "panel" ? "scheduled in the panel" : "proposed by pi" }],
	};
	if (lastStartAt(b) <= now) throw new Error("this train leaves too soon (or has left): nothing to schedule");
	return b;
}

export function setState(b, state, note = "", now = new Date()) {
	if (!STATES.includes(state)) throw new Error(`unknown state ${state}`);
	b.state = state;
	b.history.push({ at: now.toISOString(), state, note: label(note) || state });
	if (b.history.length > 50) b.history.splice(0, b.history.length - 50);
	return b;
}

// The user's Approve (panel only).
export function approve(b, now = new Date()) {
	if (b.state !== "waiting-approval") throw new Error(`booking is ${b.state}, not waiting for approval`);
	if (lastStartAt(b) <= now) throw new Error("this train leaves too soon now: it cannot be approved");
	b.approvedAt = now.toISOString();
	b.termsAcceptedAt = now.toISOString();
	return setState(b, "scheduled", "approved in the panel", now);
}

export function cancel(b, now = new Date()) {
	if (!OPEN.includes(b.state)) throw new Error(`booking is ${b.state} already`);
	return setState(b, "cancelled", "cancelled by the user", now);
}

// What is due at `now`: [{ id, action }] with action "notify", "start" or "miss". Pure: the
// server applies each action and saves the new state, so a second tick does not repeat it.
export function due(bookings, now = new Date()) {
	const out = [];
	for (const b of bookings) {
		const t = now.getTime();
		if (b.state === "waiting-approval") {
			if (t >= lastStartAt(b).getTime()) out.push({ id: b.id, action: "miss" });
			continue;
		}
		if (b.state !== "scheduled" && b.state !== "notified") continue;
		if (t >= lastStartAt(b).getTime()) out.push({ id: b.id, action: "miss" });
		else if (t >= opensAt(b).getTime()) out.push({ id: b.id, action: "start" });
		else if (b.state === "scheduled" && t >= notifyAt(b).getTime()) out.push({ id: b.id, action: "notify" });
		else if (b.state === "scheduled" && !b.readiness?.askedAt && t >= readinessAt(b).getTime()) out.push({ id: b.id, action: "check" });
	}
	return out;
}

// The next moment something happens, for the panel ("opens in 3 h 12 min").
export function nextMoment(b) {
	if (b.state === "scheduled") return { what: "notify", at: notifyAt(b).toISOString(), opensAt: opensAt(b).toISOString() };
	if (b.state === "notified") return { what: "start", at: opensAt(b).toISOString(), opensAt: opensAt(b).toISOString() };
	return null;
}

export const describe = (b) =>
	`${b.train ? `${b.train} ` : ""}${b.time} ${b.from.name} → ${b.to.name} on ${b.date}, ${b.passengers} passenger${b.passengers === 1 ? "" : "s"}, ${b.travelClass}ª class${b.usePass ? ", with the Passe Ferroviário Verde" : ""}, seat: ${b.seatChoice === "emptiest" ? "emptiest carriage" : "CP's choice"}${b.seatNote ? ` (${b.seatNote})` : ""}, expected total ${b.expectedTotal.toFixed(2)} €${b.unattended ? ", unattended" : ""}`;
