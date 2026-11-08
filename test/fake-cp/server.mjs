// test/fake-cp/server.mjs — a stand-in for cp.pt, so the module (and pi in a smoke run) is
// tested without ever touching the real site. Plain HTML forms, in Portuguese like CP's, in the
// order seen on cp.pt: results → Comprar → sign-in (if not signed in) → ticket type → confirm →
// ticket. Nothing is real: no account, no payment, the "password" is not checked.
//
//   node test/fake-cp/server.mjs [port]      prints FAKE_CP_READY http://127.0.0.1:<port>
//   GET /__purchases                          what was "bought" (JSON), for tests
import http from "node:http";
import { pathToFileURL } from "node:url";

const TRAINS = [
	{ id: "ic521", train: "IC 521", time: "08:39", arrives: "11:43", price: 28.05 },
	{ id: "ic523", train: "IC 523", time: "22:39", arrives: "01:43", price: 28.05 },
];
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title} | Fake CP</title><main><h1>${title}</h1>${body}</main>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function startFakeCp(port = 0) {
	const purchases = [];
	const carts = new Map(); // cart id -> { train, date, pax, type }
	let seq = 0;
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, "http://127.0.0.1");
		const signedIn = /(?:^|;\s*)fake_session=ok/.test(req.headers.cookie ?? "");
		const html = (code, body, headers = {}) => {
			res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
			res.end(body);
		};
		const go = (to, headers = {}) => html(303, "", { location: to, ...headers });
		const readForm = () =>
			new Promise((r) => {
				let s = "";
				req.on("data", (c) => (s += c));
				req.on("end", () => r(new URLSearchParams(s)));
			});

		if (u.pathname === "/__purchases") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify(purchases));
		}
		if (u.pathname === "/pt/resultado-pesquisa") {
			const q = u.searchParams;
			const rows = TRAINS.map(
				(t) => `<li><p>Partida às ${t.time} · Chegada às ${t.arrives} · ${t.train} · Preço ${t.price.toFixed(2)}€</p>
				<form method="get" action="/pt/comprar"><input type="hidden" name="train" value="${t.id}"><input type="hidden" name="date" value="${esc(q.get("startDate"))}"><input type="hidden" name="pax" value="${esc(q.get("passageiros") ?? 1)}">
				<button type="submit" aria-label="Selecionar ida das ${t.time} às ${t.arrives}">Selecionar ida e Comprar</button></form></li>`,
			).join("");
			return html(200, page(`${esc(q.get("departureStation"))} › ${esc(q.get("arrivalStation"))}`, `<p>${esc(q.get("startDate"))}</p><ul>${rows}</ul>`));
		}
		if (u.pathname === "/pt/comprar") {
			if (!signedIn) return go(`/login?back=${encodeURIComponent(u.pathname + u.search)}`);
			const t = TRAINS.find((x) => x.id === u.searchParams.get("train"));
			if (!t) return html(404, page("Comboio não encontrado", ""));
			const id = `c${++seq}`;
			carts.set(id, { train: t, date: u.searchParams.get("date"), pax: Number(u.searchParams.get("pax") ?? 1) });
			return html(
				200,
				page(
					"Tipo de bilhete",
					`<p>${t.train} ${t.time}</p><form method="get" action="/pt/confirmar"><input type="hidden" name="cart" value="${id}">
					<label for="type">Tipo de bilhete / desconto</label>
					<select id="type" name="type"><option value="normal">Normal</option><option value="verde">Passe Ferroviário Verde</option><option value="jovem">Cartão Jovem (25%)</option></select>
					<button type="submit">Continuar</button></form>`,
				),
			);
		}
		if (u.pathname === "/pt/confirmar" && req.method === "GET") {
			const cart = carts.get(u.searchParams.get("cart"));
			if (!cart) return html(404, page("Carrinho expirado", ""));
			cart.type = u.searchParams.get("type") ?? "normal";
			const each = cart.type === "verde" ? 0 : cart.type === "jovem" ? cart.train.price * 0.75 : cart.train.price;
			cart.total = Math.round(each * cart.pax * 100) / 100;
			return html(
				200,
				page(
					"Confirmar compra",
					`<p>${cart.train.train} ${cart.train.time} · ${esc(cart.date)} · ${cart.pax} passageiro(s) · ${esc(cart.type)}</p><p>Total: <b>${cart.total.toFixed(2).replace(".", ",")} €</b></p>
					<form method="post" action="/pt/confirmar"><input type="hidden" name="cart" value="${esc(u.searchParams.get("cart"))}"><button type="submit">Confirmar compra</button></form>`,
				),
			);
		}
		if (u.pathname === "/pt/confirmar" && req.method === "POST") {
			return readForm().then((f) => {
				const cart = carts.get(f.get("cart"));
				if (!cart || !signedIn) return html(400, page("Erro", "<p>Sessão expirada.</p>"));
				carts.delete(f.get("cart"));
				const reference = `FAKE-${String(100000 + purchases.length)}`;
				purchases.push({ reference, train: cart.train.train, time: cart.train.time, date: cart.date, pax: cart.pax, type: cart.type, total: cart.total });
				go(`/pt/bilhete?ref=${reference}`);
			});
		}
		if (u.pathname === "/pt/bilhete") return html(200, page("Compra concluída", `<p>Referência: <b>${esc(u.searchParams.get("ref"))}</b></p>`));
		if (u.pathname === "/login" && req.method === "GET") {
			return html(
				200,
				page(
					"Iniciar sessão",
					`<form method="post" action="/login"><input type="hidden" name="back" value="${esc(u.searchParams.get("back") ?? "/")}">
					<label for="user">Email</label><input id="user" name="user" type="email" autocomplete="username">
					<label for="pw">Palavra-passe</label><input id="pw" name="pw" type="password" autocomplete="current-password">
					<button type="submit">Entrar</button></form>`,
				),
			);
		}
		if (u.pathname === "/login" && req.method === "POST") {
			return readForm().then((f) => {
				const back = f.get("back") ?? "/";
				go(back.startsWith("/") && !back.startsWith("//") ? back : "/", { "set-cookie": "fake_session=ok; Path=/; HttpOnly; SameSite=Lax" });
			});
		}
		return html(200, page("Fake CP", '<p>A stand-in for cp.pt used by tests. Nothing here is real.</p>'));
	});
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, purchases, close: () => new Promise((r) => server.close(r)) })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { origin } = await startFakeCp(Number(process.argv[2] ?? 0));
	console.log(`FAKE_CP_READY ${origin}`);
}
