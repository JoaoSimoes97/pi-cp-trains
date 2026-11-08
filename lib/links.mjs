// links.mjs — cp.pt's search-results address, built and read back.
//
// cp.pt opens a search straight from its address (seen 2026-11-07):
//   https://www.cp.pt/pt/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=2026-11-07
//     &departureStation=94-31039&arrivalStation=94-2006
// So the module never calls CP's internal API: it builds this address, and pi (or the user)
// opens it in the Browser panel. Station codes are CP's own ("94-31039" is Lisboa Oriente).
// The known ones are in stations.mjs; more are learned from a results address the user or pi
// pastes (parseSearchLink).

export const CP_ORIGIN = "https://www.cp.pt";
const RESULTS_PATH = "/pt/resultado-pesquisa";

// For tests and smoke runs only: CP_TRAINS_SITE=http://127.0.0.1:<port> points every address at
// the fake CP site (test/fake-cp/server.mjs) instead of cp.pt. Anything but a loopback http
// origin is ignored, so the override can never send the user to another real site.
export function siteOrigin(env = process.env) {
	const v = String(env.CP_TRAINS_SITE ?? "");
	return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v) ? v : CP_ORIGIN;
}
const CODE = /^\d{2}-\d{1,7}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isStationCode(v) {
	return typeof v === "string" && CODE.test(v);
}

export function isDay(v) {
	if (typeof v !== "string" || !DAY.test(v)) return false;
	const [y, m, d] = v.split("-").map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// { from, to, date, passengers = 1, travelClass = 2 } -> the results address.
export function searchLink({ from, to, date, passengers = 1, travelClass = 2 } = {}) {
	if (!isStationCode(from)) throw new Error(`from must be a CP station code like 94-31039, not ${JSON.stringify(from)}`);
	if (!isStationCode(to)) throw new Error(`to must be a CP station code like 94-2006, not ${JSON.stringify(to)}`);
	if (from === to) throw new Error("from and to are the same station");
	if (!isDay(date)) throw new Error(`date must be a day as YYYY-MM-DD, not ${JSON.stringify(date)}`);
	const n = Number(passengers);
	if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("passengers must be 1 to 9");
	const c = Number(travelClass);
	if (c !== 1 && c !== 2) throw new Error("travelClass must be 1 or 2");
	// One way only: the return trip's parameter has not been seen on cp.pt yet, so it is not guessed.
	const q = new URLSearchParams({ passageiros: String(n), selectedClass: String(c), startDate: date, departureStation: from, arrivalStation: to });
	return `${siteOrigin()}${RESULTS_PATH}?${q}`;
}

// A results address (pasted by the user, or read by pi from the Browser panel) -> its search,
// or null when it is not one. Only www.cp.pt over https counts.
export function parseSearchLink(text) {
	let u;
	try {
		u = new URL(String(text ?? "").trim());
	} catch {
		return null;
	}
	const real = u.protocol === "https:" && (u.hostname === "www.cp.pt" || u.hostname === "cp.pt");
	if (!real && u.origin !== siteOrigin()) return null;
	if (!/^\/(pt|en)\/resultado-pesquisa\/?$/.test(u.pathname)) return null;
	const p = u.searchParams;
	const out = {
		from: p.get("departureStation"),
		to: p.get("arrivalStation"),
		date: p.get("startDate"),
		passengers: Number(p.get("passageiros") ?? 1),
		travelClass: Number(p.get("selectedClass") ?? 2),
	};
	if (!isStationCode(out.from) || !isStationCode(out.to) || !isDay(out.date)) return null;
	if (!Number.isInteger(out.passengers) || out.passengers < 1 || out.passengers > 9) out.passengers = 1;
	if (out.travelClass !== 1 && out.travelClass !== 2) out.travelClass = 2;
	return out;
}
