// steps.mjs — what pi does to carry out a booking in the Browser panel, and where it stops.
//
// pi gets this text from tool_cp_trains_booking_steps when the server hands it a booking (or
// when the user asks). It drives the real cp.pt with pi cockpit's browser tools, which the app
// already keeps safe: they never type into password, one-time-code or card fields, and a click
// that says buy, pay, confirm (comprar, pagar, confirmar…) asks the user first (Allow once).
// The rules below add the module's own lines on top. Nothing here talks to CP.
import { searchLink, siteOrigin } from "./links.mjs";
import { describe } from "./schedule.mjs";
import { coversDay, passStatus } from "./pass.mjs";

export function bookingSteps(b, pass, now = new Date()) {
	const site = new URL(siteOrigin()).host;
	const link = searchLink({ from: b.from.code, to: b.to.code, date: b.date, passengers: b.passengers, travelClass: b.travelClass });
	const ps = passStatus(pass, now);
	const passLine = !b.usePass
		? "This booking does not use the pass."
		: coversDay(pass, b.date)
			? `The user's Passe Ferroviário Verde is valid on ${b.date} (${ps.text}).`
			: `WARNING: the pass kept in the module does not cover ${b.date} (${ps.text}). Tell the user and stop unless they say to go on.`;
	return [
		`CP booking ${b.id}: ${describe(b)}.`,
		passLine,
		"",
		"Rules (all of them, always):",
		`- Work only in the Browser panel, on ${site} and CP's own sign-in and payment pages. Never call CP's internal API.`,
		"- Never type a password, a code or card details. At a sign-in page, stop and ask the user to sign in themselves, then continue.",
		"- If a CAPTCHA, a robot check or anything unusual appears, stop and hand over to the user. Never try to get past it.",
		`- Before the final confirm, read the total on the page. If it is not exactly ${b.expectedTotal.toFixed(2)} €, stop: report "stopped" with the total you saw.`,
		"- Before the final confirm, say in chat: the train, date, time, passengers, the pass or discount chosen and the total, and wait for the user's yes. The app's Allow once question comes on top of that.",
		"- If the train is not open for booking yet or shows sold out, wait 30 seconds and look again, at most 3 times, then report \"failed\" with what the page said.",
		"",
		"Steps:",
		`1. Make sure pi drives the browser is on (if a browser tool is refused, tell the user and stop). Open ${link} in the Browser panel.`,
		`2. Find the train leaving at ${b.time}${b.train ? ` (${b.train})` : ""} and choose it (Selecionar ida). If it is not listed, report "failed".`,
		"3. Press Comprar and follow CP's steps. If CP asks to sign in, ask the user to sign in in the Browser panel and wait (pi_cockpit_browser_wait_for) until they have.",
		b.usePass ? "4. Where CP asks for the ticket type or discount, choose the Passe Ferroviário Verde (it may be listed under passes or mobility cards). If it is not offered, stop and report \"stopped\"." : "4. Keep the ticket type CP proposes, unless the user said otherwise.",
		"5. Check the total (rule above), confirm with the user in chat, then press the final confirm button.",
		"6. Read the result page: the ticket or booking reference and the total.",
		`7. Report with tool_cp_trains_booking_report { id: "${b.id}", outcome: "booked" | "failed" | "stopped", reference, total, note }.`,
	].join("\n");
}

// The prompt the server sends pi at the booking's moment.
export function startPrompt(b) {
	return `It is time for the CP booking ${b.id} (${describe(b)}). Call tool_cp_trains_booking_steps with id "${b.id}" and follow it exactly. Stop where it says to stop.`;
}
