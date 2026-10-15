const history = require("../history");
const text = require("../utils/text");

const words = (query) => {
	return String(query || "").toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((w) => w.length > 1);
};

/** A snippet of `body` around its first match of `found`. */
const snippet = (body, at, cfg) => {
	const from = Math.max(0, at - Math.floor(cfg.snippetChars / 2));
	const piece = text.flat(body.slice(from, from + cfg.snippetChars));
	return (from > 0 ? "…" : "") + piece + (from + cfg.snippetChars < body.length ? "…" : "");
};

/**
 * Full-text search over every item of the session (offloaded, collapsed and compacted ones included): every word
 * must appear, in any order, newest first; when no item has them all, the items with the most of them come back,
 * ranked. Each hit comes with a ready read of the text around it. Returns `{ text }`.
 * @param {object[]} all every item of the session, originals
 * @param {{text: string, limit?: number}} args
 */
const search = (all, args, cfg) => {
	const ws = words(args.text);
	if (!ws.length) {
		return { error: "text is required: a few words, one idea" };
	}
	const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || cfg.searchLimit)));
	const scored = all
		.map((item, k) => {
			const body = history.searchText(item);
			const lower = body.toLowerCase();
			const hits = ws.filter((w) => lower.includes(w));
			return { item, k, body, hits: hits.length, at: hits.length ? lower.indexOf(hits[0]) : -1 };
		})
		.filter((x) => x.hits > 0 && x.item.role !== "note");
	const full = scored.filter((x) => x.hits === ws.length);
	let picked = full.sort((a, b) => b.k - a.k);
	let head = "";
	if (!full.length) {
		picked = scored.sort((a, b) => b.hits - a.hits || b.k - a.k);
		head = "No entry has all of " + ws.join(", ") + "; these have the most of them.\n";
	}
	if (!picked.length) {
		return {
			text: "Nothing matches " + ws.join(", ") + ". Words match as written, not by meaning: try other words the material would use, or synonyms."
		};
	}
	const lines = picked.slice(0, limit).map((x) => {
		let what = x.item.role;
		if (x.item.role === "toolResult") {
			what = x.item.toolName + " result";
		}
		const offset = Math.max(0, x.at - 200);
		return "- entry " + x.item.id + " (" + what + "): " + snippet(x.body, x.at, cfg) + "\n  read: " + cfg.tools.restore +
			" { entry: \"" + x.item.id + "\", offset: " + offset + ", length: 2000 }";
	});
	return { text: head + lines.join("\n") };
};

module.exports = {
	search,
	words
};
