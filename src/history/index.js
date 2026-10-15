/**
 * The history the core works on: a list of plain items, oldest first, that a harness adapter builds from its own
 * session. An item:
 *
 *   {
 *     id,                       the harness's id for it, unique in the session
 *     role,                     "user" (a request), "assistant", "toolResult", "summary" (a host's compaction),
 *                               "note" (one of the compactor's own notes) or "event" (anything else)
 *     text,                     its text as the model sees it now (in `all`: the original text)
 *     calls: [{ id, name, args }]   an assistant's tool calls, args as a JSON string
 *     callId, toolName, isError     a tool result: the call it answers
 *     images                    how many images it carries (they are never offloaded)
 *     note: { kind, level, tasks }  a note: what it was about
 *   }
 *
 * `items` is what the model sees now, with edits applied; `all` holds every item the session ever had (originals,
 * compacted ones included), for search and restore.
 */

/** The tool calls of an item (none unless it's an assistant item). */
const callsOf = (item) => {
	if (item.role !== "assistant" || !item.calls) {
		return [];
	}
	return item.calls;
};

/** The ids of the calls that have a result in `items`. */
const answered = (items) => {
	return new Set(items.filter((i) => i.role === "toolResult").map((i) => i.callId));
};

/** Characters of an item as the model gets it. */
const itemChars = (item) => {
	return callsOf(item).reduce((n, c) => {
		return n + c.name.length + (c.args || "").length + 20;
	}, (item.text || "").length + 20);
};

/**
 * Tokens per character: `usage.tokens` (the context size the host measured or estimated) over the characters of
 * `items`, else the configured default.
 * @param {object[]} items
 * @param {{tokens: number, window: number}|undefined} usage
 * @param {{charsPerToken: number}} cfg
 */
const tokensPerChar = (items, usage, cfg) => {
	const chars = items.reduce((n, i) => {
		return n + itemChars(i);
	}, 0);
	if (usage && usage.tokens > 0 && chars > 0) {
		return usage.tokens / chars;
	}
	return 1 / cfg.charsPerToken;
};

const itemTokens = (item, perChar) => Math.ceil(itemChars(item) * perChar);

const sumTokens = (items, perChar) => {
	return items.reduce((n, i) => {
		return n + itemTokens(i, perChar);
	}, 0);
};

/** The index of the assistant item that made call `callId`, or -1. */
const callerOf = (items, callId) => {
	return items.findIndex((i) => {
		return callsOf(i).some((c) => c.id === callId);
	});
};

/** The index of the result of call `callId`, or -1. */
const resultOf = (items, callId) => {
	return items.findIndex((i) => i.role === "toolResult" && i.callId === callId);
};

/** The index of the item `ref` names: its id, the id of a call it makes, or the id of the call it answers. */
const findRef = (items, ref) => {
	const byId = items.findIndex((i) => i.id === ref);
	if (byId >= 0) {
		return byId;
	}
	const result = resultOf(items, ref);
	if (result >= 0) {
		return result;
	}
	return callerOf(items, ref);
};

/** Whether an item is a request: a message from a person, not a note of the compactor's. */
const isRequest = (item) => item.role === "user";

/** The text of an item with its calls, as a search sees it. */
const searchText = (item) => {
	const calls = callsOf(item).map((c) => c.name + " " + (c.args || ""));
	return [item.text || ""].concat(calls).join("\n");
};

/**
 * `items` with `edits` applied, the way the model will see them:
 * - `{ target, drop: true }` leaves an item out
 * - `{ target, text }` replaces its text (and its calls, for an assistant item)
 * - `{ target, calls: [callId] }` keeps only those tool calls of an assistant item, and no text
 * - `{ target, restore: true }` puts back the original from `all`
 * The last edit of a target wins.
 */
const applyEdits = (items, edits, all) => {
	const last = new Map();
	edits.forEach((e) => {
		last.set(e.target, e);
	});
	return items.reduce((out, item) => {
		const e = last.get(item.id);
		if (!e) {
			out.push(item);
		} else if (e.restore) {
			out.push((all || []).find((o) => o.id === item.id) || item);
		} else if (e.drop) {
			return out;
		} else if (e.calls) {
			out.push(Object.assign({}, item, {
				text: "",
				calls: callsOf(item).filter((c) => e.calls.includes(c.id))
			}));
		} else {
			out.push(Object.assign({}, item, { text: e.text, calls: [] }));
		}
		return out;
	}, []);
};

module.exports = {
	callsOf,
	answered,
	itemChars,
	tokensPerChar,
	itemTokens,
	sumTokens,
	callerOf,
	resultOf,
	findRef,
	isRequest,
	searchText,
	applyEdits
};
