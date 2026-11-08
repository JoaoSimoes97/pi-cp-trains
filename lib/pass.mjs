// pass.mjs — the user's Passe Ferroviário Verde, and how long it has left.
//
// The pass is kept as the days it is valid: { kind, validFrom, validUntil, source, checkedAt },
// validUntil being the last day it is valid (inclusive), on this computer's clock (Portugal).
// Where the dates come from is said in `source`: "manual" (typed in the panel) or "mycp" (pi read
// them from the user's own myCP page in the Browser panel, signed in by the user: myCP › A minha
// carteira › the Cartão CP Digital › "Títulos no cartão", e.g. "Passe Ferroviário Verde Digital 30
// — 01/12/2026 até 30/12/2026"). The module never reads CP itself.
import { isDay } from "./links.mjs";

export const KINDS = Object.freeze({
	verde: Object.freeze({ name: "Passe Ferroviário Verde", periods: Object.freeze([30, 60, 90]) }),
});
const SOURCES = new Set(["manual", "mycp"]);
const DAY_MS = 86400000;

const startOf = (day) => {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y, m - 1, d);
};
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (day, n) => {
	const d = startOf(day);
	d.setDate(d.getDate() + n);
	return dayKey(d);
};

// The Cartão CP number the pass is loaded on ("V" and digits, as myCP shows it). CP's checkout
// asks for it ("Informação adicional") when the pass is chosen and does not always fill it in.
// It is no secret (it is printed on the card), so the module keeps it.
const CARD = /^[A-Z]\d{6,14}$/;

// A pass as given (panel form, pi tool) -> the stored pass, checked. `days` (30, 60, 90) with
// `validFrom` gives `validUntil` (the first day counts: 30 days from 1 Dec is up to 30 Dec, as
// myCP shows "01/12/2026 até 30/12/2026").
export function makePass({ kind = "verde", validFrom, validUntil, days, source = "manual", cardNumber } = {}, now = new Date()) {
	if (!Object.hasOwn(KINDS, kind)) throw new Error(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
	if (!SOURCES.has(source)) throw new Error("source must be manual or mycp");
	const card = String(cardNumber ?? "").trim().toUpperCase();
	if (card && !CARD.test(card)) throw new Error("cardNumber must be the Cartão CP number as myCP shows it, e.g. V0012345678");
	if (!isDay(validFrom)) throw new Error("validFrom must be a day as YYYY-MM-DD");
	let until = validUntil;
	if (until === undefined || until === null || until === "") {
		const n = Number(days);
		if (!KINDS[kind].periods.includes(n)) throw new Error(`give validUntil, or days: ${KINDS[kind].periods.join(", ")}`);
		until = addDays(validFrom, n - 1);
	}
	if (!isDay(until)) throw new Error("validUntil must be a day as YYYY-MM-DD");
	if (until < validFrom) throw new Error("validUntil is before validFrom");
	if (startOf(until) - startOf(validFrom) > 400 * DAY_MS) throw new Error("a pass longer than 400 days is not one");
	return { kind, validFrom, validUntil: until, cardNumber: card, source, checkedAt: now.toISOString() };
}

// Where the pass stands at `now`: { state, daysLeft, hoursLeft, endsAt, text }.
//   none        no pass kept
//   not-started its first day is later
//   active      valid now; daysLeft counts today (valid until tonight = 1 day)
//   expired     its last day is over
export function passStatus(pass, now = new Date()) {
	if (!pass) return { state: "none", daysLeft: 0, hoursLeft: 0, endsAt: null, text: "No pass kept" };
	const name = KINDS[pass.kind]?.name ?? pass.kind;
	const from = startOf(pass.validFrom);
	const end = startOf(addDays(pass.validUntil, 1)); // midnight after the last day
	if (now < from) {
		const days = Math.ceil((from - now) / DAY_MS);
		return { state: "not-started", daysLeft: 0, hoursLeft: 0, endsAt: end.toISOString(), text: `${name} starts in ${days} day${days === 1 ? "" : "s"} (${pass.validFrom})` };
	}
	if (now >= end) return { state: "expired", daysLeft: 0, hoursLeft: 0, endsAt: end.toISOString(), text: `${name} expired on ${pass.validUntil}` };
	const msLeft = end - now;
	const hoursLeft = Math.floor(msLeft / 3600000);
	const daysLeft = Math.round((end - startOf(dayKey(now))) / DAY_MS);
	const text = daysLeft <= 1 ? `${name}: last day today (${hoursLeft} h left)` : `${name}: ${daysLeft} days left, valid until ${pass.validUntil}`;
	return { state: "active", daysLeft, hoursLeft, endsAt: end.toISOString(), text };
}

// Whether the pass is valid on a given travel day.
export function coversDay(pass, day) {
	return !!pass && isDay(day) && pass.validFrom <= day && day <= pass.validUntil;
}
