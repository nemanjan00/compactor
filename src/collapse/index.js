const history = require("../history");
const text = require("../utils/text");

/** How a collapse's summary starts, so a later index can tell earlier summaries apart. */
const COLLAPSED = "[collapsed";
const INDEX_HEAD = "[index of what this replaced";

const isSummary = (item) => item.role === "summary" || (item.text || "").startsWith(COLLAPSED);

/**
 * The index appended to a summary: each tool call the stretch replaced, with its arguments and the item holding its
 * result, so a later question can read back the one result it needs. Messages and earlier summaries in the stretch
 * are listed too, so a collapse of collapses still leads to every part (each summary carries its own index).
 */
const index = (stretch, perChar, cfg) => {
	const results = new Map(stretch.filter((i) => i.role === "toolResult").map((i) => [i.callId, i]));
	const lines = stretch.reduce((out, item) => {
		if (isSummary(item)) {
			const first = text.firstLine((item.text || "").split(INDEX_HEAD)[0].replace(/^\[collapsed[^\]]*\]\s*/, ""), 80);
			out.push("- an earlier summary → entry " + item.id + " (≈" + text.kTokens(history.itemTokens(item, perChar)) + " tokens; its own index lists what it replaced): " + first);
		} else if (item.role === "user") {
			out.push("- a message → entry " + item.id + ": " + text.firstLine(item.text, 80));
		}
		history.callsOf(item).forEach((c) => {
			const r = results.get(c.id);
			const args = text.clip(text.flat(c.args), 100);
			let where = "";
			if (r) {
				where = " → entry " + r.id + " (≈" + text.kTokens(history.itemTokens(r, perChar)) + " tokens)";
			}
			out.push("- " + c.name + " " + args + where);
		});
		return out;
	}, []);
	if (!lines.length) {
		return "";
	}
	let more = [];
	if (lines.length > cfg.indexMax) {
		more = ["- … and " + (lines.length - cfg.indexMax) + " more (" + cfg.tools.search + " finds them)"];
	}
	return "\n\n" + INDEX_HEAD + ": find a detail in it with " + cfg.tools.search + " { text }, or read one result back with " +
		cfg.tools.restore + " { entry, offset: 0 }]\n" + lines.slice(0, cfg.indexMax).concat(more).join("\n");
};

/** Where a stretch named by `ref` starts: a tool result's turn, or the item itself. Returns -1 if it can't start there. */
const startAt = (items, ref) => {
	const k = history.findRef(items, ref);
	if (k < 0) {
		return -1;
	}
	if (items[k].role === "toolResult") {
		return history.callerOf(items, items[k].callId);
	}
	return k;
};

/** Where a stretch named by `ref` ends: after the last result of a turn's calls, or at the item itself. */
const endAt = (items, ref) => {
	const k = history.findRef(items, ref);
	if (k < 0) {
		return -1;
	}
	let turn = k;
	if (items[k].role === "toolResult") {
		turn = history.callerOf(items, items[k].callId);
	}
	const calls = turn >= 0 ? history.callsOf(items[turn]) : [];
	return calls.reduce((end, c) => Math.max(end, history.resultOf(items, c.id)), k);
};

/**
 * The edits that collapse a stretch into one summary. A stretch starting at a tool-call turn keeps that turn's first
 * call and puts the summary in its result (so the history stays a valid exchange of calls and results); one
 * starting at a message puts the summary in place of the message. Everything else in the stretch is left out.
 */
const stretchEdits = (stretch, summary) => {
	const first = stretch[0];
	const calls = history.callsOf(first);
	if (calls.length) {
		const result = stretch.find((i) => i.role === "toolResult" && i.callId === calls[0].id);
		return stretch.map((i) => {
			if (i === first) {
				return { target: i.id, calls: [calls[0].id] };
			}
			if (i === result) {
				return { target: i.id, text: summary };
			}
			return { target: i.id, drop: true };
		});
	}
	return stretch.map((i) => {
		if (i === first) {
			return { target: i.id, text: summary };
		}
		return { target: i.id, drop: true };
	});
};

/**
 * The model's collapse of a finished stretch, from `from` through `to` (ids of items or tool calls), into its
 * summary with an index appended. Returns `{ edits, text }`, or `{ error }` when the stretch can't be collapsed.
 * @param {object[]} items what the model sees now
 * @param {{from: string, to?: string, summary: string}} args
 */
const rewind = (items, args, perChar, cfg) => {
	const summary = String(args.summary || "").trim();
	if (!summary) {
		return { error: "summary is required" };
	}
	const start = startAt(items, args.from);
	if (start < 0) {
		return { error: args.from + " is not an entry or tool call in the context (each tool result starts with [entry <id>])" };
	}
	if (items[start].role === "assistant" && !history.callsOf(items[start]).length) {
		return { error: "from must be a tool result, a tool call or a message, not a reply" };
	}
	const end = endAt(items, args.to || args.from);
	if (end < start) {
		return { error: "to (" + args.to + ") must come after from (" + args.from + ")" };
	}
	const stretch = items.slice(start, end + 1);
	const done = history.answered(stretch);
	const open = stretch.find((i) => history.callsOf(i).some((c) => !done.has(c.id)));
	if (open) {
		return { error: "the stretch holds a tool call without its result (the current turn, or one still running); end it before that turn" };
	}
	const tokens = history.sumTokens(stretch, perChar);
	const block = COLLAPSED + " with " + cfg.tools.rewind + ": " + stretch.length + " entries, " + stretch[0].id + " … " + stretch[stretch.length - 1].id +
		", about " + text.kTokens(tokens) + " tokens]\n" + summary + index(stretch, perChar, cfg);
	return {
		edits: stretchEdits(stretch, block),
		tokens,
		text: "Collapsed " + stretch.length + " entries (about " + text.kTokens(tokens) + " tokens) into your summary, from your next turn on."
	};
};

/**
 * The collapse made for the model when it left finished requests a boundary note named (`named`, their request ids)
 * in its context: one stretch from the first of them to the end of the last, each request and the final reply to it
 * kept word for word, the work in between left out and indexed in front of the first request. Undefined when none of
 * them is still there. `tasks` are the finished earlier requests (`suggestions.earlierTasks`).
 */
const boundaryCollapse = (items, tasks, named, perChar, cfg) => {
	// A request the model collapsed itself is left alone.
	const ignored = tasks.filter((t) => {
		const first = items.find((i) => i.id === t.from);
		return named.includes(t.from) && first && !isSummary(first);
	});
	if (!ignored.length) {
		return undefined;
	}
	const at = (id) => items.findIndex((i) => i.id === id);
	const start = Math.min.apply(null, ignored.map((t) => at(t.from)));
	const end = Math.max.apply(null, ignored.map((t) => at(t.to)));
	const stretch = items.slice(start, end + 1).filter((i) => i.role !== "note");
	// Keep each request, and the last reply without tool calls before the next request.
	const keep = stretch.reduce((acc, item) => {
		if (history.isRequest(item)) {
			if (acc.reply) {
				acc.ids.push(acc.reply);
			}
			acc.ids.push(item.id);
			acc.reply = null;
		} else if (item.role === "assistant" && !history.callsOf(item).length && (item.text || "").trim()) {
			acc.reply = item.id;
		}
		return acc;
	}, { ids: [], reply: null });
	if (keep.reply) {
		keep.ids.push(keep.reply);
	}
	const requests = stretch.filter(history.isRequest).length;
	const tokens = history.sumTokens(stretch, perChar);
	let what = requests + " earlier requests that are done";
	if (requests === 1) {
		what = "an earlier request that is done";
	}
	const header = COLLAPSED + ": " + what + " (about " + text.kTokens(tokens) + " tokens), left in the context after a note about them. " +
		"Each request and the final reply to it are kept word for word; the work in between is in the index below]" + index(stretch, perChar, cfg);
	const first = stretch[0];
	const edits = stretch.map((i) => {
		if (i === first) {
			return { target: i.id, text: header + "\n\n[the request:]\n" + i.text };
		}
		if (keep.ids.includes(i.id)) {
			return null;
		}
		return { target: i.id, drop: true };
	}).filter(Boolean);
	return { edits, requests, tokens };
};

module.exports = {
	COLLAPSED,
	index,
	rewind,
	boundaryCollapse
};
