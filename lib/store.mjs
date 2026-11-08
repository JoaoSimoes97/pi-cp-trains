// store.mjs — the module's one file, cp-trains.json, in its data folder.
//
//   { version: 1, pass: null | {…}, favourites: [ … ], bookings: [ … ], stations: [ { code, name } ] }
//
// The panel's server and pi's tools (pi/extension.mjs) both change it, so every change goes
// through updateDoc: a lock file taken with "wx", the file read fresh, changed, written to a
// temporary file and renamed over. Nothing here keeps a password, a card or anything of
// payment: the module never has them.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FILE = "cp-trains.json";
const LIMITS = { favourites: 50, bookings: 200, stations: 500 };

export const emptyDoc = () => ({ version: 1, pass: null, favourites: [], bookings: [], stations: [] });

function check(doc) {
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
	const out = { ...emptyDoc(), ...doc };
	for (const k of ["favourites", "bookings", "stations"]) if (!Array.isArray(out[k])) throw new Error(`${k} is not a list`);
	if (out.pass !== null && typeof out.pass !== "object") throw new Error("pass is not an object");
	return out;
}

// For reading only: a missing file is an empty document.
export function loadDoc(dataDir) {
	let text;
	try {
		text = readFileSync(join(dataDir, FILE), "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return emptyDoc();
		throw new Error(`${FILE} could not be read (${e.code ?? e.message})`);
	}
	try {
		return check(JSON.parse(text));
	} catch (e) {
		throw new Error(`${FILE} could not be read (${e.message}): fix or move it`);
	}
}

function saveDoc(dataDir, doc) {
	for (const [k, max] of Object.entries(LIMITS)) if (doc[k].length > max) doc[k].splice(0, doc[k].length - max);
	const tmp = join(dataDir, `${FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(doc, null, "\t")}\n`);
	renameSync(tmp, join(dataDir, FILE));
}

// change(doc) mutates the document and returns what the caller wants back. A lock older than
// `stale` ms is a writer that died: it is taken over.
export async function updateDoc(dataDir, change, { wait = 5000, stale = 10000 } = {}) {
	mkdirSync(dataDir, { recursive: true });
	const lock = join(dataDir, `${FILE}.lock`);
	const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
	const until = Date.now() + wait;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch (e) {
			if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EBUSY") throw e;
			try {
				if (e.code === "EEXIST" && Date.now() - statSync(lock).mtimeMs > stale) {
					rmSync(lock, { force: true });
					continue;
				}
			} catch {
				continue; // gone meanwhile
			}
			if (Date.now() > until) throw new Error("the CP trains data is busy (another change holds it): try again");
			await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
		}
	}
	try {
		const doc = loadDoc(dataDir); // strict: a file that cannot be read is not replaced
		const result = change(doc);
		saveDoc(dataDir, doc);
		return result;
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
		} catch {
			// gone already
		}
	}
}

// --- favourites ----------------------------------------------------------------------------

const label = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function addFavourite(doc, { name, from, to, time, train, passengers = 1, travelClass = 2 }, now = new Date()) {
	if (!from?.code || !to?.code) throw new Error("a favourite needs from and to stations");
	const fav = {
		id: `f${now.getTime().toString(36)}${randomBytes(2).toString("hex")}`,
		name: label(name) || `${from.name} → ${to.name}${time ? ` ${time}` : ""}`,
		from: { code: from.code, name: label(from.name) },
		to: { code: to.code, name: label(to.name) },
		time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(time ?? "")) ? time : "",
		train: label(train),
		passengers: Number(passengers) || 1,
		travelClass: Number(travelClass) === 1 ? 1 : 2,
	};
	doc.favourites.push(fav);
	return fav;
}

export function removeById(list, id, what) {
	const i = list.findIndex((x) => x.id === id);
	if (i === -1) throw new Error(`no ${what} ${id}`);
	return list.splice(i, 1)[0];
}

// --- stations learned from cp.pt results addresses ------------------------------------------

export function learnStation(doc, code, name) {
	const n = label(name);
	if (!n) throw new Error("a station needs its name");
	const known = doc.stations.find((s) => s.code === code);
	if (known) known.name = n;
	else doc.stations.push({ code, name: n });
	return { code, name: n };
}
