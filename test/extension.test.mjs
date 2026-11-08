// extension.test.mjs — pi's tools, with a stand-in for pi, in a temporary data folder (never a
// real profile's tool-data).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../pi/extension.mjs";
import * as store from "../lib/store.mjs";
import { setState } from "../lib/schedule.mjs";

const manifest = JSON.parse(readFileSync(new URL("../pi-cockpit-tool.json", import.meta.url), "utf8"));

function fakePi() {
	const tools = new Map();
	return { tools, registerTool: (def) => tools.set(def.name, def), registerCommand() {}, registerFlag() {}, on() {} };
}
const call = async (pi, name, params = {}) => {
	const r = await pi.tools.get(name).execute("c1", params);
	const text = r.content.map((c) => c.text).join("\n");
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {}
	return { error: !!r.isError, text, data };
};
function setup() {
	const base = mkdtempSync(join(tmpdir(), "cp-trains-ext-"));
	const dataDir = join(base, "tool-data", "cp-trains");
	const pi = fakePi();
	extension(pi, { id: "cp-trains", dataDir });
	return { pi, dataDir, done: () => rmSync(base, { recursive: true, force: true, maxRetries: 10 }) };
}
const soon = (days) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("every tool is named under the module's prefix; nothing without a data folder", () => {
	const { pi, done } = setup();
	try {
		assert.ok(pi.tools.size >= 10);
		for (const name of pi.tools.keys()) assert.match(name, /^tool_cp_trains_[a-z_]+$/);
		const none = fakePi();
		extension(none, {});
		assert.equal(none.tools.size, 0);
		assert.equal(manifest.id, "cp-trains");
		assert.ok(manifest.permissions.includes("pi.send"));
	} finally {
		done();
	}
});

test("search link and stations, learned from a results address", async () => {
	const { pi, done } = setup();
	try {
		const r = await call(pi, "tool_cp_trains_search_link", { from: "Oriente", to: "Campanhã", date: "2026-12-01" });
		assert.match(r.data.url, /departureStation=94-31039&arrivalStation=94-2006/);
		assert.ok((await call(pi, "tool_cp_trains_search_link", { from: "Coimbra", to: "Oriente", date: "2026-12-01" })).error);
		const learn = await call(pi, "tool_cp_trains_station_learn", { url: "https://www.cp.pt/pt/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=2026-12-01&departureStation=94-36004&arrivalStation=94-31039", fromName: "Coimbra-B", toName: "Lisboa Oriente" });
		assert.equal(learn.error, false);
		assert.match((await call(pi, "tool_cp_trains_search_link", { from: "Coimbra", to: "Oriente", date: "2026-12-01" })).data.url, /departureStation=94-36004/);
		assert.ok((await call(pi, "tool_cp_trains_station_learn", { url: "https://example.com/", fromName: "a", toName: "b" })).error);
	} finally {
		done();
	}
});

test("the pass, set by pi from myCP, and its time left", async () => {
	const { pi, dataDir, done } = setup();
	try {
		assert.equal((await call(pi, "tool_cp_trains_pass")).data.status.state, "none");
		const r = await call(pi, "tool_cp_trains_pass_set", { validFrom: soon(-5), days: 30, source: "mycp" });
		assert.equal(r.error, false);
		assert.equal(r.data.status.daysLeft, 25);
		assert.equal(store.loadDoc(dataDir).pass.source, "mycp");
		assert.ok((await call(pi, "tool_cp_trains_pass_set", { validFrom: soon(0), days: 30, source: "guess" })).error);
	} finally {
		done();
	}
});

test("pi proposes; only a started booking gets steps and a report", async () => {
	const { pi, dataDir, done } = setup();
	try {
		const p = await call(pi, "tool_cp_trains_booking_propose", { from: "Oriente", to: "Campanhã", date: soon(3), time: "08:39", train: "IC 521" });
		assert.equal(p.data.state, "waiting-approval");
		const steps = await call(pi, "tool_cp_trains_booking_steps", { id: p.data.id });
		assert.ok(steps.error);
		assert.match(steps.text, /waiting-approval/);
		assert.ok((await call(pi, "tool_cp_trains_booking_report", { id: p.data.id, outcome: "booked", note: "x" })).error);
		// what the server does at the moment (approve + start), done here by hand
		await store.updateDoc(dataDir, (doc) => setState(doc.bookings[0], "started", "test"));
		const ok = await call(pi, "tool_cp_trains_booking_steps", { id: p.data.id });
		assert.equal(ok.error, false);
		assert.match(ok.text, /Never type a password/);
		const rep = await call(pi, "tool_cp_trains_booking_report", { id: p.data.id, outcome: "booked", reference: "ABC123", total: 0, note: "bought with the pass" });
		assert.deepEqual(rep.data, { id: p.data.id, state: "booked" });
		assert.equal(store.loadDoc(dataDir).bookings[0].result.reference, "ABC123");
		assert.ok((await call(pi, "tool_cp_trains_booking_report", { id: p.data.id, outcome: "booked", note: "again" })).error);
		const list = await call(pi, "tool_cp_trains_bookings");
		assert.equal(list.data[0].state, "booked");
	} finally {
		done();
	}
});

test("favourites", async () => {
	const { pi, done } = setup();
	try {
		const f = await call(pi, "tool_cp_trains_favourite_add", { from: "Oriente", to: "Campanhã", time: "08:39" });
		assert.equal(f.data.name, "Lisboa Oriente → Porto Campanhã 08:39");
		assert.equal((await call(pi, "tool_cp_trains_favourites")).data.length, 1);
	} finally {
		done();
	}
});
