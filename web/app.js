// app.js — the CP trains panel: the pass, the bookings, the favourites.
// It talks only to its own server (with the per-run secret) and, for the "… with pi" buttons, to
// the app (pi.insert: types at pi's prompt, never presses Enter).
import { followTheme } from "./theme.js";

const $ = (id) => document.getElementById(id);
const SECRET = (() => {
	const fromHash = new URLSearchParams(location.hash.slice(1)).get("pi-cockpit-secret");
	try {
		if (fromHash) sessionStorage.setItem("pi-cockpit-secret", fromHash);
		history.replaceState(null, "", location.pathname + location.search);
		return fromHash ?? sessionStorage.getItem("pi-cockpit-secret") ?? "";
	} catch {
		return fromHash ?? "";
	}
})();
const app = globalThis.piCockpit;
followTheme(app);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const when = (iso) => {
	const d = new Date(iso);
	return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function inTime(iso, now = Date.now()) {
	let ms = Date.parse(iso) - now;
	if (ms <= 0) return "now";
	const d = Math.floor(ms / 86400000);
	ms -= d * 86400000;
	const h = Math.floor(ms / 3600000);
	const m = Math.ceil((ms - h * 3600000) / 60000);
	return d ? `in ${d} d ${h} h` : h ? `in ${h} h ${m} min` : `in ${m} min`;
}

let state = null;
const status = (text, error = false) => {
	$("status").textContent = text;
	$("status").className = error ? "error" : "";
};

async function call(path, body) {
	const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json", "x-pi-cockpit-secret": SECRET }, body: JSON.stringify(body) } : { headers: { "x-pi-cockpit-secret": SECRET } });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
	return data;
}
async function act(body, done = "") {
	try {
		await call("/api/action", body);
		if (done) status(done);
		await load();
	} catch (e) {
		status(e.message, true);
	}
}
async function askPi(text) {
	try {
		await app.call("pi.insert", { text });
		status("Typed at pi's prompt: press Enter there to go.");
	} catch (e) {
		status(`pi could not be asked: ${e.message}`, true);
	}
}

async function load() {
	try {
		state = await call("/api/state");
		draw();
	} catch (e) {
		status(`Could not load: ${e.message}`, true);
	}
}

function drawPass() {
	const ps = state.passStatus;
	const bar = $("pass-bar");
	if (ps.state === "active") {
		$("pass-big").textContent = ps.daysLeft <= 1 ? `Last day (${ps.hoursLeft} h left)` : `${ps.daysLeft} days left`;
		const total = Math.round((Date.parse(`${state.pass.validUntil}T00:00:00`) - Date.parse(`${state.pass.validFrom}T00:00:00`)) / 86400000) + 1;
		bar.hidden = false;
		bar.className = ps.daysLeft <= 5 ? "bar low" : "bar";
		bar.firstElementChild.style.width = `${Math.max(2, Math.min(100, (ps.daysLeft / total) * 100))}%`;
	} else {
		$("pass-big").textContent = ps.state === "expired" ? "Expired" : ps.state === "not-started" ? "Not started yet" : "No pass kept";
		bar.hidden = ps.state !== "expired";
		bar.className = "bar out";
	}
	const src = state.pass ? ` · from ${state.pass.source === "mycp" ? "myCP" : "you"}, ${when(state.pass.checkedAt)}` : "";
	$("pass-text").textContent = state.pass ? `${state.pass.validFrom} to ${state.pass.validUntil}${state.pass.cardNumber ? ` · card ${state.pass.cardNumber}` : " · no card number"}${src}` : "Set its dates below, or let pi read them from myCP.";
	if (state.pass?.cardNumber && !$("pass-card").value) $("pass-card").value = state.pass.cardNumber;
}

function bookingButtons(b) {
	const out = [];
	if (b.state === "waiting-approval") out.push(`<button class="primary" data-act="booking-approve" data-id="${b.id}">Approve</button>`);
	if (b.state === "scheduled" || b.state === "notified") out.push(`<button data-act="run-now" data-id="${b.id}" title="Hand it to pi now (when CP's window is already open)">Run now</button>`);
	if (["waiting-approval", "scheduled", "notified", "started"].includes(b.state)) out.push(`<button class="danger" data-act="booking-cancel" data-id="${b.id}">Cancel</button>`);
	else out.push(`<button class="danger" data-act="booking-remove" data-id="${b.id}">Remove</button>`);
	return out.join("");
}

function drawBookings() {
	const list = state.bookings;
	const open = list.filter((b) => ["waiting-approval", "scheduled", "notified", "started"].includes(b.state)).length;
	$("book-count").textContent = list.length ? `(${open} open)` : "";
	$("bookings-empty").hidden = list.length > 0;
	$("bookings").innerHTML = list
		.map((b) => {
			const next = b.state === "waiting-approval" ? `Waits for your Approve · CP opens it ${when(b.opensAt)}` : b.next ? `CP opens it ${when(b.opensAt)} (${inTime(b.opensAt)})` : b.history.at(-1)?.note ?? "";
			const result = b.result ? `<div class="note">${esc(b.result.note)}${b.result.reference ? ` · ref ${esc(b.result.reference)}` : ""}${b.result.total !== null && b.result.total !== undefined ? ` · ${Number(b.result.total).toFixed(2)} €` : ""}</div>` : "";
			return `<li class="card"><div class="row"><span class="what">${esc(b.time)} ${esc(b.from.name)} → ${esc(b.to.name)}</span><span class="spacer"></span><span class="state ${esc(b.state)}">${esc(b.state)}</span></div>
				<div class="muted">${esc(b.date)}${b.train ? ` · ${esc(b.train)}` : ""} · ${b.passengers} pax · ${b.travelClass}ª · ${b.usePass ? "pass" : "no pass"} · expect ${b.expectedTotal.toFixed(2)} €${b.createdBy === "pi" ? " · proposed by pi" : ""}</div>
				<div class="note">${esc(next)}</div>${result}<div class="actions">${bookingButtons(b)}</div></li>`;
		})
		.join("");
}

function drawFavourites() {
	$("favourites-empty").hidden = state.favourites.length > 0;
	$("favourites").innerHTML = state.favourites
		.map((f) => `<li class="card"><div class="row"><span class="what">${esc(f.name)}</span><span class="spacer"></span>
			<button data-fav-book="${f.id}">Book…</button><button class="danger" data-act="favourite-remove" data-id="${f.id}" title="Remove">×</button></div>
			<div class="muted">${esc(f.from.name)} → ${esc(f.to.name)}${f.time ? ` · ${esc(f.time)}` : ""}${f.train ? ` · ${esc(f.train)}` : ""}</div></li>`)
		.join("");
	$("stations").innerHTML = state.stations.map((s) => `<option value="${esc(s.name)}">${esc(s.code)}</option>`).join("");
}

function draw() {
	drawPass();
	drawBookings();
	drawFavourites();
	preview();
}

// --- the booking form --------------------------------------------------------------------------

const form = () => ({
	from: $("b-from").value.trim(),
	to: $("b-to").value.trim(),
	date: $("b-date").value,
	time: $("b-time").value,
	train: $("b-train").value.trim(),
	passengers: Number($("b-pax").value || 1),
	travelClass: Number($("b-class").value),
	usePass: $("b-pass").checked,
	seatChoice: $("b-seat").value,
	seatNote: $("b-seatnote").value.trim(),
	expectedTotal: Number($("b-total").value || 0),
	openHoursBefore: Number($("b-hours").value || 24),
});
function preview() {
	const f = form();
	if (!f.date || !f.time) return ($("b-preview").textContent = "");
	const dep = new Date(`${f.date}T${f.time}:00`);
	const opens = new Date(dep.getTime() - f.openHoursBefore * 3600000);
	const passWarn = f.usePass && state?.pass && (f.date < state.pass.validFrom || f.date > state.pass.validUntil) ? " The pass kept does not cover that day." : "";
	$("b-preview").textContent = `CP opens it ${when(opens.toISOString())} (${inTime(opens.toISOString())}); you are notified 5 minutes before.${passWarn}`;
}
$("booking-form").addEventListener("input", preview);
$("booking-form").addEventListener("submit", (e) => {
	e.preventDefault();
	act({ action: "booking-add", ...form() }, "Scheduled.");
});
$("b-fav").addEventListener("click", () => {
	const f = form();
	act({ action: "favourite-add", from: f.from, to: f.to, time: f.time, train: f.train, passengers: f.passengers, travelClass: f.travelClass }, "Kept as a favourite.");
});
$("b-find").addEventListener("click", async () => {
	const f = form();
	try {
		const { url } = await call("/api/action", { action: "search-link", from: f.from, to: f.to, date: f.date, passengers: f.passengers, travelClass: f.travelClass });
		askPi(`Open ${url} in the Browser panel and list the trains with their times and prices. Do not choose or buy anything.`);
	} catch (e) {
		status(e.message, true);
	}
});

// --- the pass ---------------------------------------------------------------------------------

$("pass-form").addEventListener("submit", (e) => {
	e.preventDefault();
	const days = $("pass-days").value;
	act({ action: "pass-set", validFrom: $("pass-from").value, days: days ? Number(days) : undefined, validUntil: days ? undefined : $("pass-until").value, cardNumber: $("pass-card").value }, "Pass saved.");
});
$("pass-clear").addEventListener("click", () => act({ action: "pass-clear" }, "Pass forgotten."));
$("pass-mycp").addEventListener("click", () =>
	askPi("Open https://www.cp.pt/pt/mycp/carteira in the Browser panel (myCP › A minha carteira). If it asks me to sign in, stop and let me sign in myself. Open my Cartão CP Digital, read its number and, under \"Títulos no cartão\", my Passe Ferroviário Verde's first and last valid days (\"dd/mm/yyyy até dd/mm/yyyy\"), and keep them with tool_cp_trains_pass_set (source \"mycp\"). Do not buy, renew or change anything."),
);

// --- list buttons -----------------------------------------------------------------------------

document.addEventListener("click", (e) => {
	const t = e.target.closest("button");
	if (!t) return;
	if (t.dataset.act) {
		const msgs = { "booking-approve": "Approved: it will start at its moment.", "booking-cancel": "Cancelled.", "run-now": "Handed to pi.", "booking-remove": "Removed.", "favourite-remove": "Removed." };
		act({ action: t.dataset.act, id: t.dataset.id }, msgs[t.dataset.act]);
	} else if (t.dataset.favBook) {
		const f = state.favourites.find((x) => x.id === t.dataset.favBook);
		if (!f) return;
		$("new-booking").open = true;
		$("b-from").value = f.from.name;
		$("b-to").value = f.to.name;
		$("b-time").value = f.time;
		$("b-train").value = f.train;
		$("b-pax").value = f.passengers;
		$("b-class").value = String(f.travelClass);
		if (!$("b-date").value) {
			const d = new Date();
			d.setDate(d.getDate() + 2);
			$("b-date").value = dayKey(d);
		}
		preview();
		$("b-date").focus();
	}
});
$("refresh").addEventListener("click", load);

try {
	app.on("command", ({ name } = {}) => {
		if (name === "refresh") load();
	});
} catch {
	// opened outside the app
}
$("pass-from").value = dayKey(new Date());
load();
setInterval(() => {
	if (document.visibilityState === "visible") load();
}, 10000);
