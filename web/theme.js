// theme.js — the app's colours on this page (docs/modules.md, "The theme"). The same file is in
// each built-in module's web/ (a module is its own folder and cannot share one):
// test/tools-builtin.test.js keeps the copies the same.
//
// The page's stylesheet names its colours --bg, --fg, --muted, --line, --accent, --accent-fg,
// --ok, --warn, --danger, --hover, --card and --code, with light and dark values of its own
// under data-theme. The app's theme, when it sends one, is set over them; an app that sends only
// { dark } leaves the stylesheet's own.

// The page's variable -> the app's colour (theme.colors) it takes.
export const THEME_VARS = Object.freeze({
	bg: "bg",
	fg: "fg",
	muted: "fg-muted",
	line: "border",
	accent: "accent",
	"accent-fg": "accent-fg",
	ok: "ok",
	warn: "warn",
	hover: "bg-hover",
	card: "bg-side",
	code: "bg-bar",
});

// The variables a theme gives this page: { "--bg": "#…", … }, or {} without one. The app has no
// red of its own: a light theme's terminal red, a dark theme's "invalid" code colour (each
// readable on that theme's background).
export function themeVars(theme) {
	const colors = theme?.colors;
	if (!colors || typeof colors !== "object") return {};
	const out = {};
	for (const [name, key] of Object.entries(THEME_VARS)) if (typeof colors[key] === "string") out[`--${name}`] = colors[key];
	const danger = theme.base === "light" ? theme.terminal?.red : theme.syntax?.invalid;
	if (typeof danger === "string") out["--danger"] = danger;
	return out;
}

const NAMES = [...Object.keys(THEME_VARS), "danger"].map((n) => `--${n}`);

// What theme.get and the `theme` event say, applied to the page.
export function applyTheme(said, root = document.documentElement) {
	const { dark, theme } = said ?? {};
	root.dataset.theme = dark ? "dark" : "light";
	const vars = themeVars(theme);
	for (const name of NAMES) {
		if (vars[name]) root.style.setProperty(name, vars[name]);
		else root.style.removeProperty(name);
	}
}

// Before the app answers: the address's ?theme=, else the page's own prefers-color-scheme.
export function initialDark() {
	const asked = new URLSearchParams(location.search).get("theme");
	if (asked === "dark" || asked === "light") return asked === "dark";
	return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

// Follow the app: now, at every change, and safely when it cannot be asked.
export function followTheme(api = globalThis.piCockpit) {
	applyTheme({ dark: initialDark() });
	try {
		api.call("theme.get").then(applyTheme, () => {});
		api.on("theme", applyTheme);
	} catch {
		// no tool API (the page opened on its own): the stylesheet's own colours stay
	}
}
