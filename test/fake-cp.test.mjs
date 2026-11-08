// fake-cp.test.mjs — the fake CP site the module is tried against (never the real cp.pt): the
// module's own search address opens it, and the flow pi follows (results → Comprar → sign-in →
// ticket type → confirm → reference) works on it, with the pass giving a 0,00 € total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeCp } from "./fake-cp/server.mjs";

const DIR = fileURLToPath(new URL("..", import.meta.url));

test("the module's address and steps point at the fake site when CP_TRAINS_SITE says so", async () => {
	const fake = await startFakeCp();
	try {
		// in a child process, so the override is set only there
		const code = `import { searchLink } from "./lib/links.mjs"; import { bookingSteps } from "./lib/steps.mjs"; import { makeBooking } from "./lib/schedule.mjs";
			const b = makeBooking({ from: { code: "94-31039", name: "Lisboa Oriente" }, to: { code: "94-2006", name: "Porto Campanhã" }, date: "2099-01-10", time: "08:39" });
			console.log(JSON.stringify({ url: searchLink({ from: "94-31039", to: "94-2006", date: "2099-01-10" }), steps: bookingSteps(b, null) }));`;
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: DIR, env: { ...process.env, CP_TRAINS_SITE: fake.origin }, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.ok(out.url.startsWith(`${fake.origin}/pt/resultado-pesquisa?`));
		assert.ok(out.steps.includes(new URL(fake.origin).host));
		const page = await (await fetch(out.url)).text();
		assert.match(page, /Partida às 08:39/);
	} finally {
		await fake.close();
	}
});

test("the fake site's flow: sign-in first, the pass gives 0,00 €, a reference at the end", async () => {
	const fake = await startFakeCp();
	try {
		const o = fake.origin;
		const buy = await fetch(`${o}/pt/comprar?train=ic521&date=2099-01-10&pax=1`, { redirect: "manual" });
		assert.equal(buy.status, 303);
		assert.match(buy.headers.get("location"), /^\/login/);
		const login = await fetch(`${o}/login`, { method: "POST", body: new URLSearchParams({ back: "/pt/comprar?train=ic521&date=2099-01-10&pax=1" }), redirect: "manual" });
		const cookie = login.headers.get("set-cookie").split(";")[0];
		const typePage = await (await fetch(`${o}${login.headers.get("location")}`, { headers: { cookie } })).text();
		assert.match(typePage, /Passe Ferroviário Verde/);
		const cart = typePage.match(/name="cart" value="(c\d+)"/)[1];
		const confirm = await (await fetch(`${o}/pt/confirmar?cart=${cart}&type=verde`, { headers: { cookie } })).text();
		assert.match(confirm, /Total: <b>0,00 €<\/b>/);
		const done = await fetch(`${o}/pt/confirmar`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ cart }), redirect: "manual" });
		assert.match(done.headers.get("location"), /ref=FAKE-100000/);
		assert.deepEqual(fake.purchases, [{ reference: "FAKE-100000", train: "IC 521", time: "08:39", date: "2099-01-10", pax: 1, type: "verde", total: 0 }]);
	} finally {
		await fake.close();
	}
});
