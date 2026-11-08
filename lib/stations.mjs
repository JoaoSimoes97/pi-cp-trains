// stations.mjs — CP station names and codes.
//
// Only codes seen on cp.pt itself are built in. Every other station is learned: when a cp.pt
// results address is pasted or read (links.parseSearchLink) together with the names the page
// shows, the pair is kept in the module's data (store: `stations`). Nothing here calls CP.

export const BUILT_IN = Object.freeze([
	Object.freeze({ code: "94-31039", name: "Lisboa Oriente" }),
	Object.freeze({ code: "94-2006", name: "Porto Campanhã" }),
]);

// Lower case, without accents or punctuation: "Campanha" finds "Porto Campanhã".
export function fold(s) {
	return String(s ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// The built-in stations and the learned ones, one per code (a learned name wins: it is what
// the user's own page showed).
export function allStations(learned = []) {
	const byCode = new Map(BUILT_IN.map((s) => [s.code, { ...s, source: "built-in" }]));
	for (const s of learned) if (s && typeof s.code === "string" && typeof s.name === "string") byCode.set(s.code, { code: s.code, name: s.name, source: "learned" });
	return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, "pt"));
}

// A station by code or by (part of its) name. Exactly one match, or an error that says why.
export function findStation(query, learned = []) {
	const list = allStations(learned);
	const q = String(query ?? "").trim();
	if (!q) throw new Error("no station given");
	const byCode = list.find((s) => s.code === q);
	if (byCode) return byCode;
	const f = fold(q);
	const exact = list.filter((s) => fold(s.name) === f);
	if (exact.length === 1) return exact[0];
	const part = list.filter((s) => fold(s.name).includes(f));
	if (part.length === 1) return part[0];
	if (part.length > 1) throw new Error(`"${q}" matches ${part.map((s) => s.name).join(", ")}: say which`);
	throw new Error(`no known station "${q}". Known: ${list.map((s) => s.name).join(", ")}. Search it once on cp.pt and add the results address (tool_cp_trains_station_learn) to teach it`);
}
