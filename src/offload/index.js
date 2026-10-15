const history = require("../history");
const text = require("../utils/text");

/** How a pointer starts, so restore can tell an offloaded item from a collapsed one. */
const OFFLOADED = "[offloaded";

const isPointer = (item) => (item.text || "").startsWith(OFFLOADED);

/** The pointer standing for a tool result too big to keep: its head and tail, and how to read the rest. */
const oversizedText = (item, cfg) => {
	const t = cfg.tools;
	return OFFLOADED + ": " + item.toolName + " returned " + text.count(item.text.length) + " characters" + (item.isError ? " (an error)" : "") +
		", too many to keep in the context; the full result is stored as entry " + item.id + "] " +
		"Below are its first " + text.count(cfg.pointerHead) + " and last " + text.count(cfg.pointerTail) + " characters. " +
		"To read more, call " + t.restore + " { entry: \"" + item.id + "\", offset, length } for one piece at a time, " +
		"or without offset and length to put the whole result back (it costs context). Or ask the tool for less.\n\n" +
		text.headAndTail(item.text, cfg.pointerHead, cfg.pointerTail);
};

/** Edits replacing new tool results longer than `cfg.resultMaxChars` with their head and tail. Results with images stay. */
const oversized = (results, cfg) => {
	if (!cfg.resultMaxChars) {
		return [];
	}
	return results
		.filter((r) => r.role === "toolResult" && !r.images && (r.text || "").length > cfg.resultMaxChars)
		.map((r) => ({ target: r.id, text: oversizedText(r, cfg) }));
};

/**
 * The model's offload of one item (a tool result or a message it no longer needs verbatim): a one-line pointer in
 * its place. Returns `{ edits, text }` or `{ error }`.
 * @param {{entry: string, text: string}} args
 */
const offload = (items, args, perChar, cfg) => {
	const what = String(args.text || "").trim();
	if (!what) {
		return { error: "text is required: one line saying what the pointer stands for" };
	}
	const k = history.findRef(items, args.entry);
	if (k < 0) {
		return { error: args.entry + " is not an entry or tool call in the context (each tool result starts with [entry <id>])" };
	}
	let item = items[k];
	if (item.role === "assistant") {
		// A call names its result.
		const r = history.resultOf(items, args.entry);
		if (r < 0) {
			return { error: args.entry + " has no result to offload yet" };
		}
		item = items[r];
	}
	if (item === items[0]) {
		return { error: "the first entry can't be offloaded" };
	}
	if (item.role !== "toolResult" && item.role !== "user" && item.role !== "event") {
		return { error: "only a tool result or a message can be offloaded" };
	}
	if (item.images) {
		return { error: "a result with images can't be offloaded" };
	}
	if (isPointer(item)) {
		return { error: item.id + " is offloaded already" };
	}
	const tokens = history.itemTokens(item, perChar);
	const pointer = OFFLOADED + ": " + what + ". The original (≈" + text.kTokens(tokens) + " tokens) is entry " + item.id + ": " +
		cfg.tools.restore + " { entry: \"" + item.id + "\" } puts it back, with offset and length it reads a piece]";
	return {
		edits: [{ target: item.id, text: pointer }],
		text: "Offloaded " + item.id + " (about " + text.kTokens(tokens) + " tokens), from your next turn on."
	};
};

module.exports = {
	OFFLOADED,
	isPointer,
	oversized,
	offload
};
