// test/fake-cp/server.mjs — a stand-in for cp.pt, so the module (and pi in a smoke run) is
// tested without ever touching the real site. Plain HTML forms with cp.pt's own words, in the
// order walked on cp.pt on 2026-11-08 (lib/steps.mjs has the same):
//   results → "Selecionar ida das …" → dialog "Viagens selecionadas" (terms box, "Avançar para
//   compra") → sign-in if needed → /pt/compra-online: 1 Dados dos passageiros (Desconto,
//   Informação adicional) → 2 Reserva de lugares → 3 "Confirme os dados da reserva antes de
//   avançar" → "Avançar para pagamento" → ticket (total 0) or a payment page (total > 0).
// A full train goes to /pt/sem-lugares. Nothing is real: no account, no payment; the "password"
// is not checked.
//
//   node test/fake-cp/server.mjs [port]      prints FAKE_CP_READY http://127.0.0.1:<port>
//   GET /__purchases                          what was "bought" (JSON), for tests
import http from "node:http";
import { pathToFileURL } from "node:url";

const TRAINS = [
	{ id: "ic509", train: "IC 509", time: "06:39", arrives: "09:43", price: 28.05, full: true },
	{ id: "ic521", train: "IC 521", time: "08:39", arrives: "11:43", price: 28.05 },
	{ id: "ic523", train: "IC 523", time: "22:39", arrives: "01:43", price: 28.05 },
];
const CARRIAGES = [
	{ n: 24, load: 60, free: [91, 82, 42] },
	{ n: 23, load: 68, free: [12, 55] },
	{ n: 22, load: 82, free: [107, 95] },
	{ n: 21, load: 100, full: true, free: [] },
];
const DISCOUNTS = { inteiro: ["Inteiro", 1], verde: ["Passe Ferroviário Verde", 0], jovem: ["Cartão Jovem", 0.75] };
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title} | Fake CP</title><main><h1>${title}</h1>${body}</main>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const eur = (n) => `${n.toFixed(2).replace(".", ",")}€`;
const hidden = (o) => Object.entries(o).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");

export function startFakeCp(port = 0) {
	const purchases = [];
	const carts = new Map();
	let seq = 0;
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, "http://127.0.0.1");
		const q = u.searchParams;
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
			const base = { passageiros: q.get("passageiros") ?? "1", selectedClass: q.get("selectedClass") ?? "2", startDate: q.get("startDate") ?? "", departureStation: q.get("departureStation") ?? "", arrivalStation: q.get("arrivalStation") ?? "" };
			const rows = TRAINS.map(
				(t) => `<li><p>Partida às ${t.time} · Chegada às ${t.arrives} · ${t.train} · Preço ${t.price.toFixed(2)}€</p>
				<form method="get" action="/pt/resultado-pesquisa">${hidden({ ...base, sel: t.id })}<button type="submit">Selecionar ida das ${t.time} às ${t.arrives}</button></form></li>`,
			).join("");
			const t = TRAINS.find((x) => x.id === q.get("sel"));
			const dialog = t
				? `<section role="dialog" aria-label="Viagens selecionadas"><h2>Viagens selecionadas</h2><p>${t.time} ${esc(base.departureStation)} → ${t.arrives} ${esc(base.arrivalStation)}</p>
					<p>Total a pagar · Preço indicativo ${t.price.toFixed(2)}€</p>
					<form method="get" action="/pt/iniciar">${hidden({ train: t.id, date: base.startDate, pax: base.passageiros })}
					<label><input type="checkbox" name="terms" value="on"> Aceitar termos e condições enumerados de seguida</label>
					<ul><li>Li e aceito as Condições de venda da Bilheteira Online.</li><li>Li e aceito os Termos e a Política de Privacidade.</li><li>Tenho mais de 16 anos.</li></ul>
					<button type="submit">Avançar para compra</button></form></section>`
				: "";
			return html(200, page(`${esc(base.departureStation)} › ${esc(base.arrivalStation)}`, `<p>${esc(base.startDate)}</p><ul>${rows}</ul>${dialog}`));
		}
		if (u.pathname === "/pt/iniciar") {
			if (q.get("terms") !== "on") return html(400, page("Aceite os termos", "<p>Tem de aceitar os termos e condições.</p>"));
			if (!signedIn) return go(`/login?back=${encodeURIComponent(u.pathname + u.search)}`);
			const t = TRAINS.find((x) => x.id === q.get("train"));
			if (!t || t.full) return go("/pt/sem-lugares");
			const id = `c${++seq}`;
			carts.set(id, { train: t, date: q.get("date"), pax: Number(q.get("pax") ?? 1), discount: "inteiro", info: "" });
			return go(`/pt/compra-online?cart=${id}&step=1`);
		}
		if (u.pathname === "/pt/sem-lugares") return html(200, page("Não foi possível iniciar o processo de compra", "<p>De momento, não é possível iniciar a compra com os parâmetros selecionados.</p>"));
		if (u.pathname === "/pt/compra-online" && req.method === "GET") {
			const cart = carts.get(q.get("cart"));
			if (!cart || !signedIn) return html(410, page("Tempo esgotado", "<p>O tempo para comprar terminou.</p>"));
			const step = q.get("step");
			const timer = "<p>Tempo para comprar: 15:00</p>";
			if (step === "1") {
				const opts = Object.entries(DISCOUNTS).map(([k, [name]]) => `<option value="${k}">${name}</option>`).join("");
				return html(
					200,
					page(
						"Dados dos passageiros",
						`${timer}<form method="get" action="/pt/compra-online">${hidden({ cart: q.get("cart"), step: "2" })}
						<label for="nome">Nome e apelido *</label><input id="nome" value="Passageiro Teste" readonly>
						<label for="doc">Número do documento de identificação *</label><input id="doc" value="00000000" readonly>
						<label for="desconto">Desconto *</label><select id="desconto" name="desconto">${opts}</select>
						<label for="info">Informação adicional</label><input id="info" name="info" placeholder="Insira a informação necessária">
						<button type="submit">Avançar</button></form>`,
					),
				);
			}
			if (step === "2") {
				if (q.has("desconto")) {
					const d = q.get("desconto");
					if (!Object.hasOwn(DISCOUNTS, d)) return html(400, page("Erro", "<p>Desconto inválido.</p>"));
					if (d === "verde" && !/^[A-Z]\d{6,14}$/.test(q.get("info") ?? "")) return html(400, page("Dados dos passageiros", "<p>Informação adicional: campo obrigatório.</p>"));
					cart.discount = d;
					cart.info = q.get("info") ?? "";
					cart.total = Math.round(cart.train.price * DISCOUNTS[d][1] * cart.pax * 100) / 100;
					cart.seat ??= { carriage: 22, seat: 107 };
				}
				if (cart.total === undefined) return html(400, page("Erro", "<p>Dados dos passageiros em falta.</p>"));
				// "Guardar novos lugares": a carriage that is not full, a seat that is free
				if (q.has("carriage")) {
					const c = CARRIAGES.find((x) => x.n === Number(q.get("carriage")));
					const s = Number(q.get("seat"));
					if (!c || c.full || !c.free.includes(s)) return html(400, page("Reserva de lugares", "<p>Lugar indisponível.</p>"));
					cart.seat = { carriage: c.n, seat: s };
				}
				const edit = q.get("alterar") === "1";
				const picker = edit
					? `<form method="get" action="/pt/compra-online">${hidden({ cart: q.get("cart"), step: "2" })}<p>Selecione a carruagem</p>
						${CARRIAGES.map((c) => `<label><input type="radio" name="carriage" value="${c.n}" ${c.full ? "disabled" : ""}> Carruagem ${c.n}, ${c.load}% lotação${c.full ? ", lotada" : ""}</label>`).join("")}
						<p>Selecione o lugar na carruagem</p><label for="seat">Assento</label><input id="seat" name="seat" inputmode="numeric">
						<p>${CARRIAGES.filter((c) => !c.full).map((c) => `Carruagem ${c.n}: ${c.free.map((s) => `Assento ${s}, disponível`).join(", ")}`).join(" · ")}</p>
						<button type="submit">Guardar novos lugares</button></form>`
					: `<form method="get" action="/pt/compra-online">${hidden({ cart: q.get("cart"), step: "2", alterar: "1" })}<button type="submit">Alterar lugares</button></form>`;
				return html(
					200,
					page(
						"Reserva de lugares",
						`${timer}<p>Carruagem C${cart.seat.carriage} · Lugares L${cart.seat.seat}</p>${picker}<p>Total a pagar · Taxas incluídas <b>${eur(cart.total)}</b></p><form method="get" action="/pt/compra-online">${hidden({ cart: q.get("cart"), step: "3" })}<button type="submit">Avançar</button></form>`,
					),
				);
			}
			if (step === "3") {
				return html(
					200,
					page(
						"Confirme os dados da reserva antes de avançar",
						`${timer}<p>IDA · ${esc(cart.date)} · ${cart.train.time} → ${cart.train.arrives} · Carruagem C${cart.seat.carriage} · Lugares L${cart.seat.seat}</p><p>Descontos aplicados: ${DISCOUNTS[cart.discount][0]}</p>
						<p>Total a pagar · Taxas incluídas <b>${eur(cart.total)}</b></p><form method="post" action="/pt/compra-online">${hidden({ cart: q.get("cart") })}<button type="submit">Avançar para pagamento</button></form>`,
					),
				);
			}
			return html(404, page("Passo desconhecido", ""));
		}
		// "Avançar para pagamento": step 3 "Pagamento". At 0,00 € only Cancelar / Confirmar (as on
		// cp.pt); above 0, payment methods (where pi must stop).
		if (u.pathname === "/pt/compra-online" && req.method === "POST") {
			return readForm().then((f) => {
				const cart = carts.get(f.get("cart"));
				if (!cart || !signedIn || cart.total === undefined) return html(400, page("Erro", "<p>Sessão expirada.</p>"));
				const delivery = `<p>Dados para envio de bilhetes</p><label for="email">Email *</label><input id="email" value="passageiro@example.com" readonly><p>Dados para faturação</p>`;
				if (cart.total > 0) return html(200, page("Pagamento", `<p>Tempo para comprar: 12:00</p>${delivery}<p>Total a pagar ${eur(cart.total)}</p><p>Escolha o método de pagamento: MB WAY · Multibanco · Cartão</p>`));
				return html(
					200,
					page(
						"Pagamento",
						`<p>Tempo para comprar: 12:00</p>${delivery}<p>Total a pagar · Taxas incluídas <b>${eur(cart.total)}</b></p>
						<form method="get" action="/pt/resultado-pesquisa"><button type="submit">Cancelar</button></form>
						<form method="post" action="/pt/confirmar-compra">${hidden({ cart: f.get("cart") })}<button type="submit">Confirmar</button></form>`,
					),
				);
			});
		}
		if (u.pathname === "/pt/confirmar-compra" && req.method === "POST") {
			return readForm().then((f) => {
				const cart = carts.get(f.get("cart"));
				if (!cart || !signedIn || cart.total !== 0) return html(400, page("Erro", "<p>Sessão expirada.</p>"));
				carts.delete(f.get("cart"));
				const id = String(137000000 + purchases.length);
				purchases.push({ id, train: cart.train.train, time: cart.train.time, date: cart.date, pax: cart.pax, discount: cart.discount, card: cart.info, seat: `C${cart.seat.carriage} L${cart.seat.seat}`, total: cart.total });
				go("/pt/sucesso-bilhetes");
			});
		}
		if (u.pathname === "/pt/sucesso-bilhetes") return html(200, page("Compra realizada com sucesso", `<p>A sua compra foi registada com sucesso.</p><a href="/pt/mycp/viagens">Ver viagens</a>`));
		if (u.pathname === "/pt/mycp/viagens") return html(200, page("As minhas viagens", `<ul>${purchases.map((p) => `<li><a href="/pt/mycp/viagens/${p.id}/detalhes">${esc(p.date)} · Estado Confirmado</a></li>`).join("")}</ul>`));
		const trip = u.pathname.match(/^\/pt\/mycp\/viagens\/(\d+)\/detalhes$/);
		if (trip) {
			const p = purchases.find((x) => x.id === trip[1]);
			if (!p) return html(404, page("Viagem não encontrada", ""));
			const [c, l] = p.seat.split(" ");
			return html(200, page("Detalhe da viagem", `<p>Nº Comboio ${p.train} · Carruagem ${c} · Lugares ${l} · Estado Confirmado · Preço total € ${p.total.toFixed(2).replace(".", ",")}</p><button>Pedir reembolso</button><button>Trocar viagem</button><button>Ver bilhete</button>`));
		}
		if (u.pathname === "/login" && req.method === "GET") {
			return html(
				200,
				page(
					"Já tem registo no myCP?",
					`<form method="post" action="/login">${hidden({ back: q.get("back") ?? "/" })}
					<label for="user">Email</label><input id="user" name="user" type="email" autocomplete="username">
					<label for="pw">Palavra-passe</label><input id="pw" name="pw" type="password" autocomplete="current-password">
					<button type="submit">Entrar agora</button></form>`,
				),
			);
		}
		if (u.pathname === "/login" && req.method === "POST") {
			return readForm().then((f) => {
				const back = f.get("back") ?? "/";
				go(back.startsWith("/") && !back.startsWith("//") ? back : "/", { "set-cookie": "fake_session=ok; Path=/; HttpOnly; SameSite=Lax" });
			});
		}
		return html(200, page("Fake CP", "<p>A stand-in for cp.pt used by tests. Nothing here is real.</p>"));
	});
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, purchases, close: () => new Promise((r) => server.close(r)) })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { origin } = await startFakeCp(Number(process.argv[2] ?? 0));
	console.log(`FAKE_CP_READY ${origin}`);
}
