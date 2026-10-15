const history = require("../history");
const offload = require("../offload");
const text = require("../utils/text");

/**
 * The model's read of an item's original. With `offset` or `length`: a piece of the original text of any item of the
 * session (offloaded, collapsed or compacted ones included), changing nothing. Without them: an offloaded item put
 * back in place of its pointer. Returns `{ text, edits? }` or `{ error }`.
 * @param {object[]} items what the model sees now
 * @param {object[]} all every item of the session, originals
 * @param {{entry: string, offset?: number, length?: number}} args
 */
const restore = (items, all, args, cfg) => {
	const k = history.findRef(all, args.entry);
	if (k < 0) {
		return { error: args.entry + " is not an entry or tool call of this session" };
	}
	let original = all[k];
	if (original.role === "assistant" && history.resultOf(all, args.entry) >= 0) {
		original = all[history.resultOf(all, args.entry)];
	}
	const body = history.searchText(original);
	if (args.offset !== undefined || args.length !== undefined) {
		const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
		let max = cfg.pieceMax;
		if (cfg.resultMaxChars) {
			max = Math.min(max, cfg.resultMaxChars - 200);
		}
		const length = Math.min(max, Math.max(1, Math.floor(Number(args.length) || max)));
		const piece = body.slice(offset, offset + length);
		const end = offset + piece.length;
		let rest = "";
		if (end < body.length) {
			rest = " (" + text.count(body.length - end) + " more: offset " + end + ")";
		}
		return { text: "[entry " + original.id + ", characters " + offset + "–" + end + " of " + text.count(body.length) + rest + "]\n" + piece };
	}
	const now = items.find((i) => i.id === original.id);
	if (!now || !offload.isPointer(now)) {
		return {
			error: original.id + " isn't offloaded, so there is nothing to put back. A collapsed or compacted part was summarised on purpose: " +
				"rely on its summary, and read a piece of one of its entries with offset and length only for a detail the work needs now."
		};
	}
	return {
		edits: [{ target: original.id, restore: true }],
		text: "Restored " + original.id + " (" + text.count(body.length) + " characters) in place of its pointer, from your next turn on."
	};
};

module.exports = {
	restore
};
