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
	assert.equal((await req("/api/action", { body: { action: "booking-remove", id } })).status, 200);
});
