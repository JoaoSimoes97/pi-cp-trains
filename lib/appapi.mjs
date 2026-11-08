// appapi.mjs — the pi cockpit API from the module's server process (docs/modules.md, "The API
// from a process"): a named pipe (Windows) or Unix socket at PI_COCKPIT_API, a hello with
// PI_COCKPIT_API_TOKEN first, then one JSON message per line. Connected on first use, and again
// after it drops.
import net from "node:net";

export function appApi({ address = process.env.PI_COCKPIT_API, token = process.env.PI_COCKPIT_API_TOKEN, timeoutMs = 10000 } = {}) {
	let conn = null; // Promise<{ socket, pending }>
	let seq = 0;

	function connect() {
		if (!address || !token) return Promise.reject(new Error("the app's API is not available (not started by pi cockpit)"));
		return new Promise((resolve, reject) => {
			const socket = net.connect(address);
			const pending = new Map();
			let buf = "";
			let ready = false;
			const fail = (err) => {
				for (const p of pending.values()) p.reject(err);
				pending.clear();
				conn = null;
				if (!ready) reject(err);
			};
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", token })}\n`));
			socket.on("data", (chunk) => {
				buf += chunk;
				let nl;
				while ((nl = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					let msg;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					if (msg.type === "ready") {
						ready = true;
						resolve({ socket, pending });
					} else if (msg.id !== undefined && pending.has(msg.id)) {
						const p = pending.get(msg.id);
						pending.delete(msg.id);
						if (msg.ok) p.resolve(msg.data);
						else p.reject(new Error(msg.error || "the app refused"));
					}
					// events ({ type: "event" }) are not used here
				}
			});
			socket.on("error", fail);
			socket.on("close", () => fail(new Error("the app's API connection closed")));
		});
	}

	async function call(method, params = {}) {
		if (!conn) conn = connect();
		const { socket, pending } = await conn;
		const id = ++seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`the app did not answer ${method}`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	return { call, close: () => conn?.then(({ socket }) => socket.end(), () => {}) };
}
