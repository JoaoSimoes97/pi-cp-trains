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
//     dialog "Confirme os dados da reserva antes de avançar" ("Descontos aplicados", total)
//       → "Avançar para pagamento"
//     3 "Pagamento": delivery and billing details from the profile, "Total a pagar"; at 0,00 €
//       no payment method at all, just "Cancelar" / "Confirmar"
//   → /pt/sucesso-bilhetes "Compra realizada com sucesso" → "Ver viagens" → /pt/mycp/viagens →
//   the trip → /pt/mycp/viagens/<id>/detalhes (Nº Comboio, Carruagem, Lugares, Estado
//   "Confirmado", Preço total; "Pedir reembolso", "Trocar viagem", "Ver bilhete").
//   Bought this way once, for real, on 2026-11-08 (IC 621, 0,00 €).
//   No seats / cannot start: /pt/sem-lugares, "Não foi possível iniciar o processo de compra".
//   More than 24 h before departure the checkout opens, but "Passe Ferroviário Verde" is missing
//   from "Desconto" (seen 2026-11-08 on a train 26 h away; it was there for one 20 h away).
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
		"- Never type a password, a code, card details or an identity document number. If the passenger's identity document is empty, stop and ask the user to fill it in (or to add it to their myCP profile, which fills it next time).",
		`- ${signInRule(b.unattended)}`,
		"- If a CAPTCHA, a robot check or anything unusual appears, stop and hand over to the user. Never try to get past it.",
		`- The total must be exactly ${total} wherever CP shows "Total a pagar" in the checkout (the "Preço indicativo" in the first dialog is the full fare before the pass, ignore it). If it is not, stop: report "stopped" with the total you saw.`,
		b.unattended
			? "- This booking is UNATTENDED: the user approved it when they scheduled it and is not there to answer in chat. Do not wait for a yes in chat; every other rule stands, and any doubt means stop and report \"stopped\". With cp.pt at \"auto, terms included\" in pi cockpit's Site trust the app asks nothing unless a page asks for money; any question it does ask is the user's: never bypass it, and if nobody answers it (it ends after a few minutes), report \"stopped\"."
			: "- Before the last button (\"Confirmar\" on the \"Pagamento\" step), say in chat: the train, date, time, seat, the discount applied and the total, and wait for the user's yes. The app's Allow once question comes on top of that.",
		"- If a box or button is reported \"covered by another element\", click its text (its label) or where it is on the page (pi_cockpit_browser_screenshot shows it) instead.",
		"- If the \"Pagamento\" step shows any payment method (MB WAY, Multibanco, a card…) or a total that is not the expected one, stop and hand over to the user: never choose or fill one.",
		"- CP gives 15 minutes to finish (\"Tempo para comprar\"). Do not wander: if it runs out, start again from step 1 once.",
		"- If CP says \"Não foi possível iniciar o processo de compra\" (the page /pt/sem-lugares) or the train is not open yet, wait 30 seconds and start again from step 1, at most 3 times, then report \"failed\" with what the page said.",
		"",
		"Steps:",
		`1. Make sure pi drives the browser is on (if a browser tool is refused, tell the user and stop). Open ${link} in the Browser panel. If cp.pt shows you are signed out (no account picture top right, or a page asks you to sign in), press "Entrar" and sign in as the rule above says.`,
		`2. Press "Selecionar ida das ${b.time} …"${b.train ? ` (${b.train})` : ""}. If there is no train at ${b.time}, report "failed".`,
		"3. Press \"Comprar esta viagem\". In the dialog \"Viagens selecionadas\", tick \"Aceitar termos e condições enumerados de seguida\" (see above) and press \"Avançar para compra\".",
		b.usePass
			? `4. Step 1 "Dados dos passageiros": check name, email and identity document are filled (rule above). Set "Desconto" to "Passe Ferroviário Verde". If that option is not in the list, CP has not opened the train for the pass yet (it is offered only from 24 hours before departure): this counts as "not open yet" (rule above), so go back and start again from step 1 after 30 seconds. If "Informação adicional" is then empty, type ${card ? `the Cartão CP number ${card}` : "the Cartão CP number (the module has none: ask the user, or read it on myCP › A minha carteira and keep it with tool_cp_trains_pass_set)"}. Press "Avançar".`
			: "4. Step 1 \"Dados dos passageiros\": check name, email and identity document are filled (rule above). Keep \"Desconto\" as the user said (Inteiro unless told otherwise). Press \"Avançar\".",
		b.seatChoice === "emptiest" || b.seatNote
			? `5. Step 2 "Reserva de lugares": press "Alterar lugares" (the carriages cannot be chosen before it). Under "Selecione a carruagem" choose ${b.seatChoice === "emptiest" ? 'the carriage with the lowest "lotação" that is not "lotada"' : "the carriage CP chose"}, then a seat marked "disponível"${b.seatNote ? ` (the user wishes: ${b.seatNote}; if that is not possible, any free one)` : ""}, until "Lugares selecionados" is ${b.passengers}/${b.passengers}. Press "Guardar novos lugares" and check the line "Carruagem C… Lugares L…" changed. Check "Total a pagar" is ${total}. Press "Avançar".`
			: `5. Step 2 "Reserva de lugares": keep the seat CP chose (the line "Carruagem C… Lugares L…"). Check "Total a pagar" is ${total}. Press "Avançar".`,
		`6. The dialog "Confirme os dados da reserva antes de avançar": check the trip, the seat, ${b.usePass ? '"Descontos aplicados: Passe Ferroviário Verde", ' : ""}and the total ${total}. Press "Avançar para pagamento" (it does not pay: it opens the last step).`,
		`7. Step 3 "Pagamento": check the email is filled, "Total a pagar" is ${total}, and that no payment method is asked for (rule above). ${b.unattended ? "Unattended: say in chat what you are confirming (for the record)" : "Ask the user in chat (rule above)"}, then press "Confirmar".`,
		'8. CP shows "Compra realizada com sucesso" (the page /pt/sucesso-bilhetes). Press "Ver viagens", open the new trip (its "Estado" says "Confirmado"), and read its page /pt/mycp/viagens/<id>/detalhes: the id in the address, "Nº Comboio", "Carruagem", "Lugares" and "Preço total". Do not press "Pedir reembolso" or "Trocar viagem".',
		`9. Report with tool_cp_trains_booking_report { id: "${b.id}", outcome: "booked" | "failed" | "stopped", reference: "<trip id> <Nº Comboio> <Carruagem> <Lugares>", total, note }.`,
	].join("\n");
}

// What to do at CP's sign-in page (login.cp.pt): the app signs in with what the user saved in pi
// cockpit (Browser panel ⋯ ▸ Saved sign-ins…, pi cockpit 0.13+); pi never types a password.
export function signInRule(unattended) {
	return [
		"At CP's sign-in page (login.cp.pt, \"Já tem registo no myCP?\"), call pi_cockpit_browser_sign_in once: pi cockpit fills the sign-in the user saved there and submits it (you never see it, never type it). If it went through, go on from where you were (open the step's page again if needed).",
		unattended
			? 'If it is refused or does not go through (no sign-in saved, a CAPTCHA, a second step, a pause after a failed one), do not try again and do not try anything else: report "stopped" with the note "signed out of cp.pt" and what the call said.'
			: "If it is refused or does not go through, do not try again: ask the user to sign in themselves in the Browser panel, then go on.",
	].join(" ");
}

// What the module itself can see is missing for a booking (no pi needed): [problem, …].
export function localProblems(b, pass, now = new Date()) {
	const out = [];
	if (b.usePass && !coversDay(pass, b.date)) out.push(`the pass kept in the module does not cover ${b.date} (${passStatus(pass, now).text})`);
	if (b.usePass && !pass?.cardNumber) out.push("no Cartão CP number is kept with the pass (CP asks for it)");
	if (!b.termsAcceptedAt) out.push("CP's terms were not accepted for this booking (Approve it in the panel)");
	return out;
}

// The readiness check pi runs 30 minutes before the opening (or when the user presses Check now).
export function readinessPrompt(b, problems = []) {
	const site = new URL(siteOrigin()).origin;
	return [
		`Readiness check for the CP booking ${b.id} (${describe(b)}). Do not buy anything now.`,
		`1. Open ${site}/pt/mycp in the Browser panel. If a browser tool is refused, the problem is "pi drives the browser is off, or ${new URL(site).host} is not allowed for pi".`,
		'2. Read the page: signed in means it says "Bem-vindo" with the user\'s name. A sign-in page ("Já tem registo no myCP?", on login.cp.pt) means signed out: call pi_cockpit_browser_sign_in once (the app fills the sign-in the user saved in pi cockpit; you never see it), then read the page again. Still signed out, or the call refused, is the problem "signed out of cp.pt" followed by what the call said (for "no sign-in is saved": "save one in pi cockpit: Browser panel ⋯ ▸ Saved sign-ins… on CP\'s sign-in page").',
		`3. Report with tool_cp_trains_readiness_report { id: "${b.id}", ok, problems } (problems: short phrases, empty when ok).${problems.length ? ` Add these the module found: ${problems.map((p) => JSON.stringify(p)).join(", ")} (then ok is false).` : ""}`,
	].join("\n");
}

// The prompt the server sends pi at the booking's moment.
export function startPrompt(b) {
	return `It is time for the CP booking ${b.id} (${describe(b)}). Call tool_cp_trains_booking_steps with id "${b.id}" and follow it exactly. Stop where it says to stop.`;
}
