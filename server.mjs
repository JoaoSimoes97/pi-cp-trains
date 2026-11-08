// server.mjs — CP trains' panel server and booking clock.
//
// Started with the app ("start": "launch") so scheduled bookings fire while the panel is
// closed. Every 15 s it looks at the bookings (lib/scheduler.mjs) and talks to the app through
// its process API (notify, pi.send, status.set).
//
// The API answers only the panel the app opened (Todo's pattern, tools-builtin/daily-todos):
// the request names this server as its Host, comes from its own origin, and carries the
// per-run secret PI_COCKPIT_TOOL_SECRET. Data lives in PI_COCKPIT_TOOL_DATA.
//   GET  /api/state            → { now, pass, passStatus, favourites, bookings, stations }
//   POST /api/action { action, … }
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appApi } from "./lib/appapi.mjs";
import { searchLink } from "./lib/links.mjs";
import { makePass, passStatus } from "./lib/pass.mjs";
import { approve, cancel, describe, makeBooking, nextMoment, OPEN, opensAt } from "./lib/schedule.mjs";
import { startBooking, statusText, tick } from "./lib/scheduler.mjs";
import { allStations, findStation } from "./lib/stations.mjs";
import * as store from "./lib/store.mjs";

const SECRET = Buffer.from(process.env.PI_COCKPIT_TOOL_SECRET || randomBytes(32).toString("hex"));
const DATA = process.env.PI_COCKPIT_TOOL_DATA || join(process.cwd(), "data");
const TICK_MS = Number(process.env.CP_TRAINS_TICK_MS) > 0 ? Number(process.env.CP_TRAINS_TICK_MS) : 15000;
const MAX_BODY = 32 * 1024;
const api = appApi();

const hasSecret = (req) => {
	const given = Buffer.from(String(req.headers["x-pi-cockpit-secret"] ?? ""));
	return given.length === SECRET.length && timingSafeEqual(given, SECRET);
};
const file = (name) => readFileSync(new URL(`./web/${name}`, import.meta.url));
const STATIC = {
	"/": [file("index.html"), "text/html; charset=utf-8"],
	"/style.css": [file("style.css"), "text/css; charset=utf-8"],
	"/app.js": [file("app.js"), "text/javascript; charset=utf-8"],
	"/theme.js": [file("theme.js"), "text/javascript; charset=utf-8"],
};

function readBody(req) {
	return new Promise((res, rej) => {
		const chunks = [];
		let bytes = 0;
		req.on("data", (c) => {
			bytes += c.length;
			if (bytes <= MAX_BODY) chunks.push(c);
		});
		req.on("end", () => {
			if (bytes > MAX_BODY) return rej(new Error("body too large"));
			const s = Buffer.concat(chunks).toString("utf8");
			try {
				res(s ? JSON.parse(s) : {});
			} catch (e) {
				rej(e);
			}
		});
		req.on("error", rej);
	});
}

export function stateOf(doc, now = new Date()) {
	return {
		now: now.toISOString(),
		pass: doc.pass,
		passStatus: passStatus(doc.pass, now),
		favourites: doc.favourites.map((f) => ({ ...f })),
		bookings: [...doc.bookings].reverse().map((b) => ({ ...b, what: describe(b), opensAt: opensAt(b).toISOString(), next: nextMoment(b) })),
		stations: allStations(doc.stations),
	};
}

const station = (doc, q) => {
	const s = findStation(q, doc.stations);
	return { code: s.code, name: s.name };
};
const byId = (doc, id) => {
	const b = doc.bookings.find((x) => x.id === id);
	if (!b) throw new Error(`no booking ${id}`);
	return b;
};

// The panel's actions. Each changes the file under the lock; "run-now" then asks pi.
const ACTIONS = {
	"pass-set": (doc, b) => {
		doc.pass = makePass({ kind: "verde", validFrom: b.validFrom, validUntil: b.validUntil, days: b.days, cardNumber: b.cardNumber, source: "manual" });
	},
	"pass-clear": (doc) => {
		doc.pass = null;
	},
	"favourite-add": (doc, b) => store.addFavourite(doc, { ...b, from: station(doc, b.from), to: station(doc, b.to) }),
	"favourite-remove": (doc, b) => store.removeById(doc.favourites, b.id, "favourite"),
	"booking-add": (doc, b) => doc.bookings.push(makeBooking({ ...b, from: station(doc, b.from), to: station(doc, b.to) }, { by: "panel" })),
	"booking-approve": (doc, b) => approve(byId(doc, b.id)),
	"booking-cancel": (doc, b) => cancel(byId(doc, b.id)),
	"booking-remove": (doc, b) => {
		if (OPEN.includes(byId(doc, b.id).state)) throw new Error("cancel it first");
		store.removeById(doc.bookings, b.id, "booking");
	},
};

let lastStatus = null;
async function refreshStatus() {
	try {
		const text = statusText(store.loadDoc(DATA));
		if (text !== lastStatus) {
			await api.call("status.set", { text });
			lastStatus = text;
		}
	} catch {
		// no app API (run by hand), or the file is unreadable: the panel says so
	}
}

const server = http.createServer(async (req, res) => {
	const send = (code, body, type = "application/json; charset=utf-8") => {
		res.writeHead(code, { "content-type": type, "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'" });
		res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
	};
	try {
		const u = new URL(req.url, "http://127.0.0.1");
		const self = `127.0.0.1:${server.address().port}`;
		if (req.headers.host !== self) return send(421, { error: "wrong host" });
		if (req.headers.origin !== undefined && req.headers.origin !== `http://${self}`) return send(403, { error: "wrong origin" });
		if (u.pathname.startsWith("/api/") && !hasSecret(req)) return send(403, { error: "not the panel the app opened" });
		if (req.method === "GET" && STATIC[u.pathname]) return send(200, ...STATIC[u.pathname]);
		if (req.method === "GET" && u.pathname === "/api/state") return send(200, stateOf(store.loadDoc(DATA)));
		if (req.method === "POST" && u.pathname === "/api/action") {
			const b = await readBody(req);
			if (b.action === "run-now") {
				const r = await startBooking(DATA, api, String(b.id ?? ""), "Run now, pressed in the panel");
				refreshStatus();
				return send(r.started ? 200 : 409, r.started ? { ok: true } : { error: r.reason });
			}
			if (b.action === "search-link") {
				const doc = store.loadDoc(DATA);
				return send(200, { url: searchLink({ from: station(doc, b.from).code, to: station(doc, b.to).code, date: b.date, passengers: b.passengers, travelClass: b.travelClass }) });
			}
			const act = Object.hasOwn(ACTIONS, b.action) ? ACTIONS[b.action] : null;
			if (!act) return send(400, { error: "unknown action" });
			await store.updateDoc(DATA, (doc) => act(doc, b));
			refreshStatus();
			return send(200, { ok: true });
		}
		return send(404, { error: "not found" });
	} catch (e) {
		return send(400, { error: e?.message || String(e) });
	}
});

let ticking = false;
async function loop() {
	if (ticking) return;
	ticking = true;
	try {
		await tick(DATA, api);
	} catch (e) {
		console.error(`[cp-trains] tick failed: ${e?.message ?? e}`);
	} finally {
		ticking = false;
	}
	refreshStatus();
}

server.listen(0, "127.0.0.1", () => {
	console.log(`PI_COCKPIT_TOOL_READY http://127.0.0.1:${server.address().port}/`);
	loop();
	setInterval(loop, TICK_MS).unref?.();
});

if (process.env.PI_COCKPIT_TOOL_LIFELINE === "1") {
	process.stdin.on("end", () => process.exit(0));
	process.stdin.resume();
}
