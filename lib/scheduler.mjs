// scheduler.mjs — one look at the bookings (the server runs it every few seconds).
//
// What is due (schedule.due) is applied to the file first, under the lock, and only then said
// to the app, so a tick that runs twice (or a server started again) never notifies or starts a
// booking twice. A booking handed to pi that pi cannot get (no pi tab running, pi.send refused)
// is marked failed, with the reason, and the user is told.
import { passStatus } from "./pass.mjs";
import { describe, due, OPEN, opensAt, setState } from "./schedule.mjs";
import { startPrompt } from "./steps.mjs";
import * as store from "./store.mjs";

const short = (b) => `${b.time} ${b.from.name} → ${b.to.name} (${b.date})`;
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// Start one booking now: mark it started, then ask pi. Used by tick and by the panel's Run now.
export async function startBooking(dataDir, api, id, note, now = new Date()) {
	const b = await store.updateDoc(dataDir, (doc) => {
		const x = doc.bookings.find((y) => y.id === id);
		if (!x) throw new Error(`no booking ${id}`);
		if (x.state !== "scheduled" && x.state !== "notified") throw new Error(`booking is ${x.state}`);
		setState(x, "started", note, now);
		return structuredClone(x);
	});
	try {
		await api.call("pi.send", { text: startPrompt(b) });
	} catch (err) {
		const reason = `pi could not be given the booking: ${err?.message ?? err}`;
		await store.updateDoc(dataDir, (doc) => {
			const x = doc.bookings.find((y) => y.id === id);
			if (x?.state === "started") setState(x, "failed", reason, now);
		});
		await api.call("notify", { title: "CP booking did not start", body: `${short(b)}: ${reason}`.slice(0, 300) }).catch(() => {});
		return { started: false, reason };
	}
	return { started: true };
}

export async function tick(dataDir, api, now = new Date()) {
	const doc = store.loadDoc(dataDir);
	const actions = due(doc.bookings, now);
	const done = [];
	for (const { id, action } of actions) {
		if (action === "start") {
			const r = await startBooking(dataDir, api, id, "handed to pi at the opening", now).catch((e) => ({ started: false, reason: e.message }));
			done.push({ id, action, ...r });
			continue;
		}
		const b = await store
			.updateDoc(dataDir, (d) => {
				const x = d.bookings.find((y) => y.id === id);
				if (!x) return null;
				if (action === "notify" && x.state === "scheduled") setState(x, "notified", "5-minute notice shown", now);
				else if (action === "miss" && OPEN.includes(x.state) && x.state !== "started") setState(x, "missed", x.state === "waiting-approval" ? "never approved" : "its moment passed without starting", now);
				else return null;
				return structuredClone(x);
			})
			.catch(() => null);
		if (!b) continue;
		if (action === "notify") await api.call("notify", { title: "CP booking in 5 minutes", body: `${short(b)} opens at ${hhmm(opensAt(b))}. Keep pi cockpit open, and sign in to cp.pt in the Browser panel if you are not.` }).catch(() => {});
		else await api.call("notify", { title: "CP booking missed", body: `${describe(b)}`.slice(0, 300) }).catch(() => {});
		done.push({ id, action });
	}
	return done;
}

// The status bar's short text: the pass and the next booking.
export function statusText(doc, now = new Date()) {
	const ps = passStatus(doc.pass, now);
	const pass = ps.state === "active" ? `pass ${ps.daysLeft} d` : ps.state === "expired" ? "pass expired" : "";
	const next = doc.bookings
		.filter((b) => b.state === "scheduled" || b.state === "notified")
		.map((b) => opensAt(b))
		.sort((a, b) => a - b)[0];
	const nextText = next ? `booking ${String(next.getDate()).padStart(2, "0")}/${String(next.getMonth() + 1).padStart(2, "0")} ${hhmm(next)}` : "";
	const waiting = doc.bookings.filter((b) => b.state === "waiting-approval").length;
	const parts = [pass, nextText, waiting ? `${waiting} to approve` : ""].filter(Boolean);
	return parts.length ? `CP: ${parts.join(" · ")}`.slice(0, 60) : "";
}
