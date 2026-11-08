// steps.mjs — what pi does to carry out a booking in the Browser panel, and where it stops.
//
// pi gets this text from tool_cp_trains_booking_steps when the server hands it a booking (or
// when the user presses Run now). It drives the real cp.pt with pi cockpit's browser tools,
// which the app already keeps safe: they never type into password, one-time-code or card fields,
// and a click that says buy, pay, confirm (comprar, pagar, confirmar…) asks the user first
// (Allow once). The rules below add the module's own lines on top. Nothing here talks to CP.
//
// The page names are cp.pt's as walked on 2026-11-08 (signed in, with the pass):
//   results → "Selecionar ida das HH:MM às HH:MM" → "Comprar esta viagem" → dialog "Viagens
//   selecionadas" with one box "Aceitar termos e condições enumerados de seguida" and
//   "Avançar para compra" → /pt/compra-online, a 15-minute "Tempo para comprar":
//     1 "Dados dos passageiros" (Desconto → "Passe Ferroviário Verde", then "Informação
//       adicional" = the Cartão CP number) → Avançar
//     2 "Reserva de lugares" (CP picks a seat; "Alterar lugares" → a carriage → a seat
//       "disponível" → "Guardar novos lugares" changes it; "Total a pagar") → Avançar
//     3 dialog "Confirme os dados da reserva antes de avançar" ("Descontos aplicados", total)
//       → "Avançar para pagamento"
//   No seats / cannot start: /pt/sem-lugares, "Não foi possível iniciar o processo de compra".
import { searchLink, siteOrigin } from "./links.mjs";
import { describe } from "./schedule.mjs";
import { coversDay, passStatus } from "./pass.mjs";

const euros = (n) => `${n.toFixed(2).replace(".", ",")} €`;

export function bookingSteps(b, pass, now = new Date()) {
	const site = new URL(siteOrigin()).host;
	const link = searchLink({ from: b.from.code, to: b.to.code, date: b.date, passengers: b.passengers, travelClass: b.travelClass });
	const ps = passStatus(pass, now);
	const passLine = !b.usePass
		? "This booking does not use the pass."
		: coversDay(pass, b.date)
			? `The user's Passe Ferroviário Verde is valid on ${b.date} (${ps.text}).`
			: `WARNING: the pass kept in the module does not cover ${b.date} (${ps.text}). Tell the user and stop unless they say to go on.`;
	const card = b.usePass && pass?.cardNumber ? pass.cardNumber : "";
	const terms = b.termsAcceptedAt
		? `The user accepted CP's sale conditions, terms and privacy policy for this booking in the panel (${b.termsAcceptedAt}), so you may tick that box.`
		: "The user has NOT accepted CP's terms for this booking: do not tick the terms box; stop and ask them.";
	const total = euros(b.expectedTotal);
	return [
		`CP booking ${b.id}: ${describe(b)}.`,
		passLine,
		terms,
		"",
		"Rules (all of them, always):",
		`- Work only in the Browser panel, on ${site} and CP's own sign-in page. Never call CP's internal API.`,
		"- Never type a password, a code, card details or an identity document number. At a sign-in page, stop and ask the user to sign in themselves, then continue. If the passenger's identity document is empty, stop and ask the user to fill it in (or to add it to their myCP profile, which fills it next time).",
		"- If a CAPTCHA, a robot check or anything unusual appears, stop and hand over to the user. Never try to get past it.",
		`- The total must be exactly ${total} wherever CP shows "Total a pagar" in the checkout (the "Preço indicativo" in the first dialog is the full fare before the pass, ignore it). If it is not, stop: report "stopped" with the total you saw.`,
		"- Before the last button (\"Avançar para pagamento\"), say in chat: the train, date, time, seat, the discount applied and the total, and wait for the user's yes. The app's Allow once question comes on top of that.",
		"- CP gives 15 minutes to finish (\"Tempo para comprar\"). Do not wander: if it runs out, start again from step 1 once.",
		"- If CP says \"Não foi possível iniciar o processo de compra\" (the page /pt/sem-lugares) or the train is not open yet, wait 30 seconds and start again from step 1, at most 3 times, then report \"failed\" with what the page said.",
		"",
		"Steps:",
		`1. Make sure pi drives the browser is on (if a browser tool is refused, tell the user and stop). Open ${link} in the Browser panel. If cp.pt shows you are signed out (no account picture top right), ask the user to sign in first.`,
		`2. Press "Selecionar ida das ${b.time} …"${b.train ? ` (${b.train})` : ""}. If there is no train at ${b.time}, report "failed".`,
		"3. Press \"Comprar esta viagem\". In the dialog \"Viagens selecionadas\", tick \"Aceitar termos e condições enumerados de seguida\" (see above) and press \"Avançar para compra\".",
		b.usePass
			? `4. Step 1 "Dados dos passageiros": check name, email and identity document are filled (rule above). Set "Desconto" to "Passe Ferroviário Verde". If "Informação adicional" is then empty, type ${card ? `the Cartão CP number ${card}` : "the Cartão CP number (the module has none: ask the user, or read it on myCP › A minha carteira and keep it with tool_cp_trains_pass_set)"}. Press "Avançar".`
			: "4. Step 1 \"Dados dos passageiros\": check name, email and identity document are filled (rule above). Keep \"Desconto\" as the user said (Inteiro unless told otherwise). Press \"Avançar\".",
		b.seatChoice === "emptiest" || b.seatNote
			? `5. Step 2 "Reserva de lugares": press "Alterar lugares" (the carriages cannot be chosen before it). Under "Selecione a carruagem" choose ${b.seatChoice === "emptiest" ? 'the carriage with the lowest "lotação" that is not "lotada"' : "the carriage CP chose"}, then a seat marked "disponível"${b.seatNote ? ` (the user wishes: ${b.seatNote}; if that is not possible, any free one)` : ""}, until "Lugares selecionados" is ${b.passengers}/${b.passengers}. Press "Guardar novos lugares" and check the line "Carruagem C… Lugares L…" changed. Check "Total a pagar" is ${total}. Press "Avançar".`
			: `5. Step 2 "Reserva de lugares": keep the seat CP chose (the line "Carruagem C… Lugares L…"). Check "Total a pagar" is ${total}. Press "Avançar".`,
		`6. Step 3, the dialog "Confirme os dados da reserva antes de avançar": check the trip, ${b.usePass ? '"Descontos aplicados: Passe Ferroviário Verde", ' : ""}and the total ${total}. Ask the user in chat (rule above), then press "Avançar para pagamento".`,
		`7. What follows "Avançar para pagamento" has not been seen yet: with a total of ${total} CP may issue the ticket at once, or show a payment page. If it asks for payment details or a method, stop and hand over to the user: never fill them in.`,
		"8. Read the result: the ticket or booking reference, the seat and the total.",
		`9. Report with tool_cp_trains_booking_report { id: "${b.id}", outcome: "booked" | "failed" | "stopped", reference, total, note }.`,
	].join("\n");
}

// The prompt the server sends pi at the booking's moment.
export function startPrompt(b) {
	return `It is time for the CP booking ${b.id} (${describe(b)}). Call tool_cp_trains_booking_steps with id "${b.id}" and follow it exactly. Stop where it says to stop.`;
}
