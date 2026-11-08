// test-probe/locked-screen.probe.mjs — Phase 0: can pi buy a ticket in pi cockpit's Browser panel
// while Windows is locked?
//
// Not part of `npm test`: it starts pi cockpit (from a development checkout, PI_COCKPIT_DIR) with
// pi cockpit's own end-to-end helpers, so in a throwaway profile, with the fake pi and the fake
// harness, never the real %APPDATA%\pi-cockpit or ~/.pi. The fake pi calls the app's real browser
// tools (pi_cockpit_browser_*) against the fake CP site (test/fake-cp/server.mjs), the whole way to
// "Compra realizada com sucesso". The app's "Allow once" questions are answered yes by the probe
// (in Phase 1 a pre-approval will answer them); what is measured is only whether the steps work
// while the screen is locked.
//
//   PI_COCKPIT_DIR=C:\…\pi-cockpit  WAIT_BEFORE_S=60  node --test test-probe/locked-screen.probe.mjs
//
// WAIT_BEFORE_S: seconds to wait before the steps start (lock the screen then, Win+L). Electron's
// powerMonitor says when the screen locks and unlocks; every step is logged with whether the screen
// was locked at that moment, to PROBE_LOG (default: a file in the temp folder, printed at the end).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { pathToFileURL } from "node:url";
import { startFakeCp } from "../test/fake-cp/server.mjs";

const COCKPIT = process.env.PI_COCKPIT_DIR;
if (!COCKPIT || !fs.existsSync(path.join(COCKPIT, "test-e2e", "helpers.js"))) throw new Error("set PI_COCKPIT_DIR to a pi cockpit development checkout");
const { launchApp, openSafety, quitApp, tempDir, until, waitForTerminal } = await import(pathToFileURL(path.join(COCKPIT, "test-e2e", "helpers.js")).href);

const WAIT_BEFORE_S = Number(process.env.WAIT_BEFORE_S ?? 0);
const LOG = process.env.PROBE_LOG || path.join(os.tmpdir(), `cp-trains-locked-probe-${Date.now()}.log`);
const log = (line) => {
	const l = `${new Date().toISOString()} ${line}`;
	fs.appendFileSync(LOG, `${l}\n`);
	console.log(l);
};

let fake, app, page, piPty;
const results = path.join(tempDir("cp-trains-probe-results-"), "results.jsonl");
const lines = () => (fs.existsSync(results) ? fs.readFileSync(results, "utf8").split("\n").filter(Boolean) : []);
// Two signals: Electron's powerMonitor, and Windows' own lock screen process (LogonUI.exe runs
// while the session is locked).
const logonUi = () => {
	if (process.platform !== "win32") return false;
	try {
		return /LogonUI\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"], { encoding: "utf8", windowsHide: true }));
	} catch {
		return false;
	}
};
const locked = async () => (await app.evaluate(() => globalThis.__locked === true)) || logonUi();
async function tool(name, args = {}) {
	const was = lines().length;
	const lockedAtStart = await locked();
	await page.evaluate(([id, text]) => window.cockpit.pty.write(id, text), [piPty, `tool ${name} ${JSON.stringify(args)}\r`]);
	await until(`${name} to answer`, () => lines().length > was, 90000);
	const r = JSON.parse(lines()[was]);
	log(`${lockedAtStart || (await locked()) ? "LOCKED  " : "unlocked"} ${name} ${JSON.stringify(args)} -> ${r.isError ? "ERROR " : "ok "}${String(r.text).split("\n").slice(r.isError ? 0 : 1).join(" ").slice(0, 160)}`);
	return r;
}
async function snap() {
	const s = await tool("pi_cockpit_browser_snapshot");
	assert.equal(s.isError, false, s.text);
	return s.text;
}
const ref = (text, re) => {
	const m = re.exec(text);
	assert.ok(m, `not in the snapshot: ${re}\n${text.slice(0, 1500)}`);
	return m[1];
};
// Scroll the element into view first, as pi does, then click it.
async function clickRef(r) {
	await tool("pi_cockpit_browser_scroll", { ref: r });
	return tool("pi_cockpit_browser_click", { ref: r });
}
async function click(re) {
	const r = await clickRef(ref(await snap(), re));
	assert.equal(r.isError, false, r.text);
	await tool("pi_cockpit_browser_wait_for", { timeoutMs: 1500, text: "zzz-never" }); // let the page load
}

before(async () => {
	fake = await startFakeCp();
	log(`probe log: ${LOG}`);
	log(`fake CP at ${fake.origin}`);
	({ app, page } = await launchApp({ env: { FAKE_PI_RESULTS: results } }));
	await waitForTerminal(page, "#harness-terminal", /READY/);
	await page.evaluate(() => {
		window.__ptyOut = {};
		window.cockpit.pty.onData((id, data) => (window.__ptyOut[id] = (window.__ptyOut[id] ?? "") + data));
	});
	await page.locator("#harness-terminal").click();
	await page.keyboard.type("hello");
	await page.keyboard.press("Enter");
	await until("pi's echo", async () => (piPty = await page.evaluate(() => Object.entries(window.__ptyOut).find(([, t]) => t.includes("ECHO:hello"))?.[0] ?? null)) !== null);
	piPty = Number(piPty);
	// The screen's state, from Electron; the app's questions answered "Allow once" (logged).
	await app.evaluate(({ dialog, powerMonitor }) => {
		globalThis.__locked = false;
		globalThis.__asked = [];
		powerMonitor.on("lock-screen", () => (globalThis.__locked = true));
		powerMonitor.on("unlock-screen", () => (globalThis.__locked = false));
		dialog.showMessageBoxSync = () => {
			throw new Error("a synchronous dialog holds the whole main process");
		};
		dialog.showMessageBox = async (...args) => {
			const o = args.at(-1);
			globalThis.__asked.push(o.message);
			return { response: o.buttons?.[0] === "Allow once" ? 0 : o.defaultId };
		};
	});
	// The user signed in to the fake CP site (pi never types a password): its cookie, set directly.
	await app.evaluate(({ session }, url) => session.fromPartition("persist:pi-browser").cookies.set({ url, name: "fake_session", value: "ok", httpOnly: true }), fake.origin);
	await openSafety(page);
	const badge = page.locator("#status-agent-browser");
	await badge.click();
	await badge.filter({ hasText: "pi drives the browser ON" }).waitFor({ state: "attached" });
	const nav = await tool("pi_cockpit_browser_navigate", { url: `${fake.origin}/` });
	assert.equal(nav.isError, false, nav.text);
});

after(async () => {
	if (app) {
		const asked = await app.evaluate(() => globalThis.__asked).catch(() => []);
		log(`questions the app asked (answered Allow once): ${asked.length}`);
		await quitApp(app);
	}
	await fake?.close();
	log(`purchases on the fake site: ${JSON.stringify(fake?.purchases ?? [])}`);
	log(`probe log: ${LOG}`);
});

it("buys a 0 € ticket on the fake CP site through the Browser panel", { timeout: 15 * 60 * 1000 }, async () => {
	if (WAIT_BEFORE_S > 0) {
		log(`waiting ${WAIT_BEFORE_S} s: lock the screen now (Win+L) and leave it locked until the probe ends`);
		await new Promise((r) => setTimeout(r, WAIT_BEFORE_S * 1000));
		log(`starting; screen ${(await locked()) ? "LOCKED" : "unlocked"}`);
	}
	const nav = await tool("pi_cockpit_browser_navigate", { url: `${fake.origin}/pt/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=2099-01-10&departureStation=94-31039&arrivalStation=94-2006` });
	assert.equal(nav.isError, false, nav.text);
	await click(/button "Selecionar ida das 08:39 às 11:43" \[ref=(e\d+)\]/);
	let terms = await clickRef(ref(await snap(), /checkbox "Aceitar termos e condições enumerados de seguida" \[ref=(e\d+)\]/));
	if (terms.isError && /covered by another element/.test(terms.text)) {
		// the fallback pi's steps give: click where the box is (pi reads it from a screenshot)
		const box = await app.evaluate(({ webContents, session }) => webContents.getAllWebContents().find((w) => w.session === session.fromPartition("persist:pi-browser") && w.getURL().startsWith("http"))?.executeJavaScript(`(() => { const r = document.getElementById("terms").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
		terms = await tool("pi_cockpit_browser_click", box);
	}
	assert.equal(terms.isError, false, terms.text);
	assert.match(await snap(), /checkbox "Aceitar termos e condições enumerados de seguida" \[ref=e\d+\] \(checked\)|checked/);
	await click(/button "Avançar para compra" \[ref=(e\d+)\]/);
	let s = await snap();
	const sel = await tool("pi_cockpit_browser_select", { ref: ref(s, /combobox "Desconto \*" \[ref=(e\d+)\]/), label: "Passe Ferroviário Verde" });
	assert.equal(sel.isError, false, sel.text);
	const typed = await tool("pi_cockpit_browser_type", { ref: ref(s, /textbox "Informação adicional" \[ref=(e\d+)\]/), text: "V0012345678" });
	assert.equal(typed.isError, false, typed.text);
	await click(/button "Avançar" \[ref=(e\d+)\]/);
	await click(/button "Alterar lugares" \[ref=(e\d+)\]/);
	s = await snap();
	const radio = await clickRef(ref(s, /radio "Carruagem 24, 60% lotação" \[ref=(e\d+)\]/));
	assert.equal(radio.isError, false, radio.text);
	const seat = await tool("pi_cockpit_browser_type", { ref: ref(s, /textbox "Assento" \[ref=(e\d+)\]/), text: "91" });
	assert.equal(seat.isError, false, seat.text);
	await click(/button "Guardar novos lugares" \[ref=(e\d+)\]/);
	assert.match(await snap(), /Carruagem C24 · Lugares L91/);
	await click(/button "Avançar" \[ref=(e\d+)\]/);
	await click(/button "Avançar para pagamento" \[ref=(e\d+)\]/);
	assert.match(await snap(), /Total a pagar · Taxas incluídas/);
	await click(/button "Confirmar" \[ref=(e\d+)\]/);
	assert.match(await snap(), /Compra realizada com sucesso/);
	const shot = await tool("pi_cockpit_browser_screenshot");
	log(`screenshot at the end: ${shot.isError ? `ERROR ${shot.text.slice(0, 120)}` : "ok"}`);
	assert.equal(fake.purchases.length, 1);
	assert.equal(fake.purchases[0].seat, "C24 L91");
});
