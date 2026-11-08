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

test("the fake site's flow: terms, sign-in, pass with card number, 0,00 €, a reference", async () => {
	const fake = await startFakeCp();
	try {
		const o = fake.origin;
		const results = await (await fetch(`${o}/pt/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=2099-01-10&departureStation=94-31039&arrivalStation=94-2006&sel=ic521`)).text();
		assert.match(results, /Selecionar ida das 08:39 às 11:43/);
		assert.match(results, /Aceitar termos e condições enumerados de seguida/);
		assert.equal((await fetch(`${o}/pt/iniciar?train=ic521&date=2099-01-10&pax=1`, { redirect: "manual" })).status, 400); // no terms
		const start = await fetch(`${o}/pt/iniciar?train=ic521&date=2099-01-10&pax=1&terms=on`, { redirect: "manual" });
		assert.match(start.headers.get("location"), /^\/login/);
		const login = await fetch(`${o}/login`, { method: "POST", body: new URLSearchParams({ back: "/pt/iniciar?train=ic521&date=2099-01-10&pax=1&terms=on" }), redirect: "manual" });
		const cookie = login.headers.get("set-cookie").split(";")[0];
		const full = await fetch(`${o}/pt/iniciar?train=ic509&date=2099-01-10&pax=1&terms=on`, { headers: { cookie }, redirect: "manual" });
		assert.equal(full.headers.get("location"), "/pt/sem-lugares");
		const toCart = await fetch(`${o}${login.headers.get("location")}`, { headers: { cookie }, redirect: "manual" });
		const step1Url = toCart.headers.get("location");
		const cart = step1Url.match(/cart=(c\d+)/)[1];
		const step1 = await (await fetch(`${o}${step1Url}`, { headers: { cookie } })).text();
		assert.match(step1, /Passe Ferroviário Verde/);
		assert.match(step1, /Tempo para comprar/);
		assert.equal((await fetch(`${o}/pt/compra-online?cart=${cart}&step=2&desconto=verde&info=`, { headers: { cookie } })).status, 400); // card number missing
		const step2 = await (await fetch(`${o}/pt/compra-online?cart=${cart}&step=2&desconto=verde&info=V0012345678`, { headers: { cookie } })).text();
		assert.match(step2, /Total a pagar · Taxas incluídas <b>0,00€<\/b>/);
		const edit = await (await fetch(`${o}/pt/compra-online?cart=${cart}&step=2&alterar=1`, { headers: { cookie } })).text();
		assert.match(edit, /Carruagem 24, 60% lotação/);
		assert.match(edit, /Carruagem 21, 100% lotação, lotada/);
		assert.equal((await fetch(`${o}/pt/compra-online?cart=${cart}&step=2&carriage=21&seat=1`, { headers: { cookie } })).status, 400); // full carriage
		const saved = await (await fetch(`${o}/pt/compra-online?cart=${cart}&step=2&carriage=24&seat=91`, { headers: { cookie } })).text();
		assert.match(saved, /Carruagem C24 · Lugares L91/);
		const step3 = await (await fetch(`${o}/pt/compra-online?cart=${cart}&step=3`, { headers: { cookie } })).text();
		assert.match(step3, /Carruagem C24 · Lugares L91/);
		assert.match(step3, /Descontos aplicados: Passe Ferroviário Verde/);
		assert.match(step3, /Avançar para pagamento/);
		const done = await fetch(`${o}/pt/compra-online`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ cart }), redirect: "manual" });
		assert.match(done.headers.get("location"), /ref=FAKE-100000/);
		assert.deepEqual(fake.purchases, [{ reference: "FAKE-100000", train: "IC 521", time: "08:39", date: "2099-01-10", pax: 1, discount: "verde", card: "V0012345678", seat: "C24 L91", total: 0 }]);
	} finally {
		await fake.close();
	}
});

test("the fake site: a total above 0 ends at a payment page, nothing bought", async () => {
	const fake = await startFakeCp();
	try {
		const o = fake.origin;
		const login = await fetch(`${o}/login`, { method: "POST", body: new URLSearchParams({ back: "/" }), redirect: "manual" });
		const cookie = login.headers.get("set-cookie").split(";")[0];
		const cart = (await fetch(`${o}/pt/iniciar?train=ic523&date=2099-01-10&pax=1&terms=on`, { headers: { cookie }, redirect: "manual" })).headers.get("location").match(/cart=(c\d+)/)[1];
		await fetch(`${o}/pt/compra-online?cart=${cart}&step=2&desconto=inteiro`, { headers: { cookie } });
		const pay = await (await fetch(`${o}/pt/compra-online`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ cart }) })).text();
		assert.match(pay, /Escolha o método de pagamento/);
		assert.deepEqual(fake.purchases, []);
	} finally {
		await fake.close();
	}
});
