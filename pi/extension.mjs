// pi/extension.mjs — CP trains' agent tools.
//
// Loaded into pi by pi cockpit (the manifest's `piExtension`) with the module's data folder as
// `dataDir`, the same folder the panel's server gets as PI_COCKPIT_TOOL_DATA. Every change goes
// through lib/store.mjs's updateDoc, under the lock the server takes too.
//
// pi can look things up, keep favourites and the pass dates, propose a booking (which waits for
// the user's Approve in the panel: pi cannot schedule one on its own), get the steps for a
// booking and report how it went. Buying itself happens in the Browser panel with the app's
// browser tools and their safety gates (lib/steps.mjs).
import path from "node:path";
import { parseSearchLink, searchLink } from "../lib/links.mjs";
import { makePass, passStatus } from "../lib/pass.mjs";
import { describe, makeBooking, nextMoment, setState } from "../lib/schedule.mjs";
import { allStations, findStation } from "../lib/stations.mjs";
import { bookingSteps } from "../lib/steps.mjs";
import * as store from "../lib/store.mjs";

const answer = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const refuse = (err) => ({ content: [{ type: "text", text: `CP trains: ${err?.message ?? err}` }], isError: true });
const S = (description) => ({ type: "string", description });
const N = (description) => ({ type: "number", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const STATION = S("A station: its name (or part of it, e.g. \"Oriente\") or its CP code (e.g. 94-31039)");
const DATE = S("A day as YYYY-MM-DD");

export default function (pi, { dataDir } = {}) {
	if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) return;
	const tool = (name, label, description, parameters, run) =>
		pi.registerTool({
			name: `tool_cp_trains_${name}`,
			label,
			description,
			parameters,
			async execute(_id, params = {}) {
				try {
					return answer(await run(params ?? {}));
				} catch (err) {
					return refuse(err);
				}
			},
		});
	const station = (q) => {
		const s = findStation(q, store.loadDoc(dataDir).stations);
		return { code: s.code, name: s.name };
	};

	tool("stations", "CP stations", "List the CP stations this module knows (name and code), or find one. Stations not listed are taught with tool_cp_trains_station_learn.", obj({ query: S("Optional: part of a name, or a code") }), ({ query }) => {
		const learned = store.loadDoc(dataDir).stations;
		return query ? findStation(query, learned) : allStations(learned);
	});

	tool(
		"station_learn",
		"Teach a CP station",
		"Teach the module the two stations of a cp.pt search: give the results address (https://www.cp.pt/pt/resultado-pesquisa?…) and the names the page shows for its origin and destination.",
		obj({ url: S("The cp.pt results address"), fromName: S("The origin's name as the page shows it"), toName: S("The destination's name as the page shows it") }, ["url", "fromName", "toName"]),
		async ({ url, fromName, toName }) => {
			const s = parseSearchLink(url);
			if (!s) throw new Error("that is not a cp.pt search results address");
			return store.updateDoc(dataDir, (doc) => [store.learnStation(doc, s.from, fromName), store.learnStation(doc, s.to, toName)]);
		},
	);

	tool(
		"search_link",
		"CP search address",
		"The cp.pt address that shows the trains between two stations on a day (open it in the Browser panel). One way only.",
		obj({ from: STATION, to: STATION, date: DATE, passengers: N("1 to 9 (default 1)"), travelClass: N("1 or 2 (default 2)") }, ["from", "to", "date"]),
		({ from, to, date, passengers, travelClass }) => {
			const f = station(from);
			const t = station(to);
			return { from: f, to: t, date, url: searchLink({ from: f.code, to: t.code, date, passengers, travelClass }) };
		},
	);

	tool("favourites", "CP favourite routes", "The user's favourite CP routes (stations, usual train time).", obj({}), () => store.loadDoc(dataDir).favourites);

	tool(
		"favourite_add",
		"Add a CP favourite",
		"Keep a route as one of the user's favourites. Only when the user asked for it.",
		obj({ from: STATION, to: STATION, time: S("Optional usual departure, HH:MM"), train: S("Optional train, e.g. IC 523"), name: S("Optional short name"), passengers: N("1 to 9"), travelClass: N("1 or 2") }, ["from", "to"]),
		async (p) => {
			const from = station(p.from);
			const to = station(p.to);
			return store.updateDoc(dataDir, (doc) => store.addFavourite(doc, { ...p, from, to }));
		},
	);

	tool("pass", "Pass time left", "The user's Passe Ferroviário Verde as the module keeps it: its days and how long it has left.", obj({}), () => {
		const { pass } = store.loadDoc(dataDir);
		return { pass, status: passStatus(pass) };
	});

	tool(
		"pass_set",
		"Set the pass dates",
		"Keep the user's Passe Ferroviário Verde: its days and the Cartão CP number it is on. Use only what the user told you, or what you read on their own myCP page in the Browser panel, signed in by them (myCP › A minha carteira › the Cartão CP Digital: its number, and under \"Títulos no cartão\" a line like \"Passe Ferroviário Verde Digital 30 — 01/12/2026 até 30/12/2026\"); say which with source. Give validUntil, or days (30, 60 or 90).",
		obj(
			{
				validFrom: DATE,
				validUntil: S("The last valid day, YYYY-MM-DD"),
				days: N("30, 60 or 90, instead of validUntil"),
				cardNumber: S("The Cartão CP number, e.g. V0012345678 (CP's checkout asks for it with the pass)"),
				source: S("\"manual\" (the user said) or \"mycp\" (read on myCP)"),
			},
			["validFrom", "source"],
		),
		async (p) => {
			const pass = makePass({ kind: "verde", ...p });
			await store.updateDoc(dataDir, (doc) => {
				doc.pass = pass;
			});
			return { pass, status: passStatus(pass) };
		},
	);

	tool("bookings", "CP bookings", "The scheduled CP bookings and what became of them (state, next moment, history).", obj({}), () =>
		store.loadDoc(dataDir).bookings.map((b) => ({ id: b.id, what: describe(b), state: b.state, next: nextMoment(b), result: b.result ?? null })),
	);

	tool(
		"booking_propose",
		"Propose a CP booking",
		"Propose a booking for one train, to be taken as soon as CP opens it (24 h before departure with the pass). It waits for the user to press Approve in the CP trains panel: tell them to. Only for a train the user asked for.",
		obj(
			{
				from: STATION,
				to: STATION,
				date: DATE,
				time: S("Departure, HH:MM"),
				train: S("Optional train, e.g. IC 523"),
				passengers: N("1 to 9 (default 1)"),
				travelClass: N("1 or 2 (default 2)"),
				usePass: { type: "boolean", description: "Use the Passe Ferroviário Verde (default true)" },
				seatChoice: S("\"cp\" (keep the seat CP picks, default) or \"emptiest\" (move to the emptiest carriage)"),
				seatNote: S("Optional seat wish pi tries, e.g. \"with a socket\""),
				expectedTotal: N("The total in euros the user expects (default 0 with the pass): pi stops if the page says otherwise"),
			},
			["from", "to", "date", "time"],
		),
		async (p) => {
			const b = makeBooking({ ...p, from: station(p.from), to: station(p.to) }, { by: "pi" });
			await store.updateDoc(dataDir, (doc) => doc.bookings.push(b));
			return { id: b.id, state: b.state, what: describe(b), next: "The user must press Approve in the CP trains panel. Nothing happens until then." };
		},
	);

	tool("booking_steps", "Steps for a CP booking", "The exact steps and rules to carry out one booking in the Browser panel. Follow them exactly.", obj({ id: S("The booking's id") }, ["id"]), ({ id }) => {
		const doc = store.loadDoc(dataDir);
		const b = doc.bookings.find((x) => x.id === id);
		if (!b) throw new Error(`no booking ${id}`);
		if (b.state !== "started") throw new Error(`booking ${id} is ${b.state}: only a started booking is carried out (the panel's Approve and its moment, or Run now)`);
		return bookingSteps(b, doc.pass);
	});

	tool(
		"booking_report",
		"Report a CP booking",
		"Say how a started booking ended: booked (with the reference and total from CP's page), failed (CP would not), or stopped (a rule said stop).",
		obj({ id: S("The booking's id"), outcome: S("booked, failed or stopped"), reference: S("Optional: CP's ticket or booking reference"), total: N("Optional: the total the page showed, euros"), note: S("What happened, one line") }, ["id", "outcome", "note"]),
		async ({ id, outcome, reference, total, note }) => {
			if (!["booked", "failed", "stopped"].includes(outcome)) throw new Error("outcome must be booked, failed or stopped");
			return store.updateDoc(dataDir, (doc) => {
				const b = doc.bookings.find((x) => x.id === id);
				if (!b) throw new Error(`no booking ${id}`);
				if (b.state !== "started") throw new Error(`booking ${id} is ${b.state}, not started`);
				b.result = { outcome, reference: String(reference ?? "").slice(0, 80), total: Number.isFinite(Number(total)) ? Number(total) : null, note: String(note ?? "").slice(0, 300) };
				setState(b, outcome, note);
				return { id, state: b.state };
			});
		},
	);
}
