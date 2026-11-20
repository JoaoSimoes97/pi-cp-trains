// server.test.mjs — the panel's server, started as the app starts it, with a temporary data
// folder and its own secret, and no app API (so notify / pi.send fail and are said to fail).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "s".repeat(64);
let base, proc, url;

before(async () => {
	base = mkdtempSync(join(tmpdir(), "cp-trains-server-"));
	const env = { ...process.env, PI_COCKPIT_TOOL_SECRET: SECRET, PI_COCKPIT_TOOL_DATA: join(base, "data"), CP_TRAINS_TICK_MS: "3600000" };
	delete env.PI_COCKPIT_API;
	delete env.PI_COCKPIT_API_TOKEN;
	delete env.CP_TRAINS_SITE;
	proc = spawn(process.execPath, ["server.mjs"], { cwd: DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	url = await new Promise((resolve, reject) => {
		let out = "";
		proc.stdout.on("data", (c) => {
			out += c;
			const m = out.match(/PI_COCKPIT_TOOL_READY (http:\/\/127\.0\.0\.1:\d+\/)/);
			if (m) resolve(m[1]);
		});
		proc.on("exit", (code) => reject(new Error(`server exited ${code}`)));
		setTimeout(() => reject(new Error("no ready line")), 10000);
	});
});
after(() => {
	proc?.kill();
	rmSync(base, { recursive: true, force: true, maxRetries: 10 });
});

const req = (path, { body, secret = SECRET, headers = {} } = {}) =>
	fetch(new URL(path, url), { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(secret ? { "x-pi-cockpit-secret": secret } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const soon = (days) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("the page is served; the API answers only the panel the app opened", async () => {
	assert.equal((await req("/", { secret: null })).status, 200);
	assert.equal((await req("/theme.js", { secret: null })).status, 200);
	assert.equal((await req("/api/state", { secret: null })).status, 403);
	assert.equal((await req("/api/state", { secret: "x".repeat(64) })).status, 403);
	assert.equal((await req("/api/state", { headers: { origin: "http://evil.example" } })).status, 403);
	const s = await (await req("/api/state")).json();
	assert.equal(s.passStatus.state, "none");
	assert.equal(s.stations.length, 2);
});

test("pass, favourite, booking: the panel's actions", async () => {
	assert.equal((await req("/api/action", { body: { action: "pass-set", validFrom: soon(-10), days: 30 } })).status, 200);
	assert.equal((await req("/api/action", { body: { action: "favourite-add", from: "Oriente", to: "Campanhã", time: "08:39" } })).status, 200);
	assert.equal((await req("/api/action", { body: { action: "booking-add", from: "Oriente", to: "Campanhã", date: soon(4), time: "08:39", train: "IC 521" } })).status, 200);
	const bad = await req("/api/action", { body: { action: "booking-add", from: "Faro", to: "Campanhã", date: soon(4), time: "08:39" } });
	assert.equal(bad.status, 400);
	assert.match((await bad.json()).error, /no known station/);
	assert.equal((await req("/api/action", { body: { action: "nope" } })).status, 400);
	const s = await (await req("/api/state")).json();
	assert.equal(s.passStatus.daysLeft, 20);
	assert.equal(s.favourites.length, 1);
	assert.equal(s.bookings[0].state, "scheduled");
	const link = await (await req("/api/action", { body: { action: "search-link", from: "Oriente", to: "Campanhã", date: soon(4) } })).json();
	assert.match(link.url, /^https:\/\/www\.cp\.pt\/pt\/resultado-pesquisa\?/);
});

test("Run now without a running app: refused with the reason, booking marked failed", async () => {
	const s = await (await req("/api/state")).json();
	const id = s.bookings[0].id;
	const r = await req("/api/action", { body: { action: "run-now", id } });
	assert.equal(r.status, 409);
	assert.match((await r.json()).error, /pi could not be given the booking/);
	const after = await (await req("/api/state")).json();
	assert.equal(after.bookings[0].state, "failed");
	// its result is to see until Seen
	assert.ok(after.bookings[0].result.at);
	assert.equal(after.bookings[0].result.seenAt, null);
	assert.equal((await req("/api/action", { body: { action: "result-seen", id } })).status, 200);
	const seen = await (await req("/api/state")).json();
	assert.ok(seen.bookings[0].result.seenAt);
	assert.equal((await req("/api/action", { body: { action: "booking-remove", id } })).status, 200);
});

test("Seen: refused for a booking with no result; All seen marks every result", async () => {
	assert.equal((await req("/api/action", { body: { action: "booking-add", from: "Oriente", to: "Campanhã", date: soon(5), time: "09:39" } })).status, 200);
	const s = await (await req("/api/state")).json();
	const r = await req("/api/action", { body: { action: "result-seen", id: s.bookings[0].id } });
	assert.equal(r.status, 400);
	assert.match((await r.json()).error, /no result to see/);
	assert.equal((await req("/api/action", { body: { action: "run-now", id: s.bookings[0].id } })).status, 409);
	assert.equal((await req("/api/action", { body: { action: "results-seen" } })).status, 200);
	const after = await (await req("/api/state")).json();
	assert.ok(after.bookings.every((b) => !b.result?.at || b.result.seenAt));
});

test("a booking with Allow paying up to: the panel hears back at once; without pi cockpit's API it says the allowance is not there", async () => {
	const r = await req("/api/action", { body: { action: "booking-add", from: "Oriente", to: "Campanhã", date: soon(6), time: "10:39", expectedTotal: 2.5, payUpTo: 3 } });
	assert.equal(r.status, 200);
	assert.equal((await r.json()).pay, "asking you in pi cockpit");
	const bad = await req("/api/action", { body: { action: "booking-add", from: "Oriente", to: "Campanhã", date: soon(6), time: "11:39", expectedTotal: 5, payUpTo: 3 } });
	assert.equal(bad.status, 400);
	assert.match((await bad.json()).error, /below the expected total/);
	let b;
	for (let i = 0; i < 50; i++) {
		b = (await (await req("/api/state")).json()).bookings.find((x) => x.time === "10:39");
		if (b.pay) break;
		await new Promise((res) => setTimeout(res, 100));
	}
	assert.equal(b.payUpTo, 3);
	assert.equal(b.pay.granted, false);
	assert.match(b.pay.note, /pi cockpit 0\.20 or later/);
	// cancel and remove go through without the API too
	assert.equal((await req("/api/action", { body: { action: "booking-cancel", id: b.id } })).status, 200);
	assert.equal((await req("/api/action", { body: { action: "booking-remove", id: b.id } })).status, 200);
});
