// scheduler.mjs — one look at the bookings (the server runs it every few seconds).
//
// What is due (schedule.due) is applied to the file first, under the lock, and only then said
// to the app, so a tick that runs twice (or a server started again) never notifies or starts a
// booking twice. A booking handed to pi that pi cannot get (no pi tab running, pi.send refused)
// is marked failed, with the reason, and the user is told.
//
// Every ended booking's result (booked, failed, stopped, no report, missed) is notified once,
// by resultNotices, and stays in the panel and the status bar until the user presses Seen.
import { passStatus } from "./pass.mjs";
import { due, finish, OPEN, opensAt, setState, unseen } from "./schedule.mjs";
import { localProblems, readinessPrompt, startPrompt } from "./steps.mjs";
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
			if (x?.state === "started") finish(x, "failed", { note: reason, notified: true }, now);
		});
		await api.call("notify", { title: "CP booking did not start", body: `${short(b)}: ${reason}`.slice(0, 300) }).catch(() => {});
		return { started: false, reason };
	}
	return { started: true };
}

// A readiness check: what the module sees missing, then pi looks at the rest (signed in, the
// switch, the site). pi answers with tool_cp_trains_readiness_report; tick tells the user when
// the answer is not ok, or when pi does not answer within READINESS_ANSWER_MS.
export const READINESS_ANSWER_MS = 5 * 60 * 1000;
export async function checkBooking(dataDir, api, id, now = new Date()) {
	const { b, problems } = await store.updateDoc(dataDir, (doc) => {
		const x = doc.bookings.find((y) => y.id === id);
		if (!x) throw new Error(`no booking ${id}`);
		if (x.state !== "scheduled" && x.state !== "notified") throw new Error(`booking is ${x.state}`);
		x.readiness = { askedAt: now.toISOString() };
		return { b: structuredClone(x), problems: localProblems(x, doc.pass, now) };
	});
	try {
		await api.call("pi.send", { text: readinessPrompt(b, problems) });
		return { asked: true, problems };
	} catch (err) {
		const problem = `pi could not be asked (${err?.message ?? err}): is pi cockpit open with a pi tab running?`;
		await store.updateDoc(dataDir, (doc) => {
			const x = doc.bookings.find((y) => y.id === id);
			if (x) x.readiness = { askedAt: now.toISOString(), reportedAt: now.toISOString(), ok: false, problems: [problem, ...problems], notified: true };
		});
		await api.call("notify", { title: "CP booking not ready", body: `${short(b)}: ${problem}`.slice(0, 300) }).catch(() => {});
		return { asked: false, problems: [problem, ...problems] };
	}
}

// Readiness answers to pass on: not ok, or no answer in time. Each said once.
async function readinessNotices(dataDir, api, now) {
	const said = await store
		.updateDoc(dataDir, (doc) => {
			const out = [];
			for (const x of doc.bookings) {
				const r = x.readiness;
				if (!r || r.notified || (x.state !== "scheduled" && x.state !== "notified")) continue;
				if (r.reportedAt && r.ok === false) out.push({ b: structuredClone(x), text: (r.problems ?? []).join("; ") || "pi found a problem" });
				else if (!r.reportedAt && now - new Date(r.askedAt) > READINESS_ANSWER_MS) out.push({ b: structuredClone(x), text: "pi did not answer the readiness check: is pi cockpit open with a pi tab running?" });
				else continue;
				r.notified = true;
			}
			return out;
		})
		.catch(() => []);
	for (const { b, text } of said) await api.call("notify", { title: "CP booking not ready", body: `${short(b)}: ${text}`.slice(0, 300) }).catch(() => {});
	return said.length;
}

// The likely reason something did not happen on time, from when the clock last looked:
// `lastTickAt` null means this server has just started (pi cockpit was not running before).
export const AWAY_MS = 2 * 60 * 1000;
export function awayReason(now, lastTickAt) {
	if (!lastTickAt) return "pi cockpit was not running then (closed, or the computer off or asleep)";
	const gap = now - new Date(lastTickAt);
	if (gap > AWAY_MS) return `the computer was asleep or busy (no check for ${Math.round(gap / 60000)} min)`;
	return null;
}

const OUTCOME_TITLE = {
	booked: "CP booking done: booked",
	failed: "CP booking failed",
	stopped: "CP booking stopped",
	"no-report": "CP booking: no report from pi",
	missed: "CP booking missed",
};

// Results not notified yet: each notified once (marked first, under the lock, then said).
async function resultNotices(dataDir, api, now) {
	const said = await store
		.updateDoc(dataDir, (doc) => {
			const out = [];
			for (const x of doc.bookings) {
				if (!x.result?.at || x.result.notifiedAt) continue;
				x.result.notifiedAt = now.toISOString();
				out.push(structuredClone(x));
			}
			return out;
		})
		.catch(() => []);
	for (const b of said) {
		const r = b.result;
		const extra = [r.reference ? `ref ${r.reference}` : "", r.total !== null && r.total !== undefined ? `${Number(r.total).toFixed(2)} €` : ""].filter(Boolean).join(", ");
		await api.call("notify", { title: OUTCOME_TITLE[r.outcome] ?? `CP booking ${r.outcome}`, body: `${short(b)}: ${r.note}${extra ? ` (${extra})` : ""}`.slice(0, 300) }).catch(() => {});
	}
	return said.length;
}

export async function tick(dataDir, api, now = new Date(), { lastTickAt = now } = {}) {
	const doc = store.loadDoc(dataDir);
	const actions = due(doc.bookings, now);
	const away = awayReason(now, lastTickAt);
	const done = [];
	for (const { id, action } of actions) {
		if (action === "check") {
			const r = await checkBooking(dataDir, api, id, now).catch((e) => ({ asked: false, problems: [e.message] }));
			done.push({ id, action, ...r });
			continue;
		}
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
				else if (action === "miss" && OPEN.includes(x.state) && x.state !== "started") {
					const why = x.state === "waiting-approval" ? "never approved" : `its moment passed without starting${away ? `: ${away}` : ""}`;
					finish(x, "missed", { note: why, state: "missed" }, now);
				} else if (action === "unreported" && x.state === "started") {
					const why = away ?? "pi did not report: its tab was closed, pi stopped, or it is stuck (look at the pi tab and the Browser panel)";
					finish(x, "no-report", { note: `no report: ${why}`, state: "failed" }, now);
				} else return null;
				return structuredClone(x);
			})
			.catch(() => null);
		if (!b) continue;
		if (action === "notify") await api.call("notify", { title: "CP booking in 5 minutes", body: `${short(b)} opens at ${hhmm(opensAt(b))}. Keep pi cockpit open, and sign in to cp.pt in the Browser panel if you are not.` }).catch(() => {});
		done.push({ id, action });
	}
	if (await readinessNotices(dataDir, api, now)) done.push({ action: "readiness-notice" });
	if (await resultNotices(dataDir, api, now)) done.push({ action: "result-notice" });
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
	const toSee = unseen(doc.bookings).length;
	const parts = [toSee ? `${toSee} result${toSee === 1 ? "" : "s"} to see` : "", pass, nextText, waiting ? `${waiting} to approve` : ""].filter(Boolean);
	return parts.length ? `CP: ${parts.join(" · ")}`.slice(0, 60) : "";
}
