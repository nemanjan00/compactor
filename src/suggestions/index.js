const history = require("../history");
const text = require("../utils/text");

/**
 * What the model could free now. A suggestion is one of:
 *   { kind: "collapse", from, to, calls, names, tokens }   a finished stretch of consecutive tool-call turns
 *   { kind: "offload", id, name, tokens }                 one tool result
 *   { kind: "task", from, to, request, tokens }           a finished earlier request and all its work
 * `from`, `to` and `id` are item ids (of tool results, for stretches: the first and last result).
 */

/** `read ×12, bash`: the tools of a stretch, most used first. */
const toolTally = (names) => {
	const counts = names.reduce((m, n) => {
		m.set(n, (m.get(n) || 0) + 1);
		return m;
	}, new Map());
	const sorted = Array.from(counts).sort((a, b) => b[1] - a[1]);
	const shown = sorted.slice(0, 3).map((x) => {
		if (x[1] > 1) {
			return x[0] + " ×" + x[1];
		}
		return x[0];
	});
	if (sorted.length > 3) {
		return shown.join(", ") + " and " + (sorted.length - 3) + " more";
	}
	return shown.join(", ");
};

/** Where the current work starts: the latest assistant turn with tool calls, if it is the latest assistant turn. */
const currentTurn = (items) => {
	const last = items.map((i) => i.role).lastIndexOf("assistant");
	if (last > 0 && history.callsOf(items[last]).length) {
		return last;
	}
	return items.length;
};

/**
 * The biggest finished things in `items` the model could free, biggest first, at most `cfg.suggestionsMax`:
 * stretches of consecutive tool-call turns (to collapse) and single tool results (to offload). Never the latest
 * turn (its results are unseen), never a turn with a call still waiting for its result, never the first item.
 */
const suggestions = (items, perChar, cfg) => {
	const max = cfg.suggestionsMax;
	const done = history.answered(items);
	const end = currentTurn(items);
	const stretches = [];
	const results = [];
	let cur = null;
	const close = () => {
		if (cur && cur.names.length >= 2) {
			stretches.push({ kind: "collapse", from: cur.from, to: cur.to, calls: cur.names.length, names: toolTally(cur.names), tokens: cur.tokens });
		}
		cur = null;
	};
	items.slice(1, end).forEach((item) => {
		const calls = history.callsOf(item);
		if (calls.length) {
			if (!calls.every((c) => done.has(c.id))) {
				close();
				return;
			}
			if (!cur) {
				cur = { from: null, to: null, names: [], tokens: 0 };
			}
			cur.names = cur.names.concat(calls.map((c) => c.name));
			cur.tokens += history.itemTokens(item, perChar);
			return;
		}
		if (item.role === "toolResult" && cur) {
			const t = history.itemTokens(item, perChar);
			cur.tokens += t;
			cur.from = cur.from || item.id;
			cur.to = item.id;
			if (!item.images) {
				results.push({ kind: "offload", id: item.id, name: item.toolName, tokens: t, in: cur });
			}
			return;
		}
		// Notes between turns don't break a stretch; anything else (a message, a reply, a summary) does.
		if (item.role === "note") {
			return;
		}
		close();
	});
	close();
	const big = (xs) => xs.filter((x) => x.tokens >= cfg.suggestionMinTokens).sort((a, b) => b.tokens - a.tokens);
	const s = big(stretches);
	const shown = s.slice(0, max - 1);
	// A result inside a suggested stretch is worth its own line only when it is a big part of it.
	const r = big(results).filter((x) => {
		const st = shown.find((y) => y.from === x.in.from);
		return !st || x.tokens * 3 >= st.tokens;
	}).map((x) => ({ kind: x.kind, id: x.id, name: x.name, tokens: x.tokens }));
	const pick = shown.concat(r.slice(0, 1));
	s.slice(max - 1).concat(r.slice(1)).forEach((x) => {
		if (pick.length < max) {
			pick.push(x);
		}
	});
	return pick.slice(0, max).sort((a, b) => b.tokens - a.tokens);
};

/**
 * Earlier requests in `items` (before index `end`) that are done, each with all its work: from the request to the
 * item before the next request. A request still waiting on a tool call isn't done. Biggest first.
 */
const earlierTasks = (items, perChar, end) => {
	const stop = end === undefined ? items.length : end;
	const starts = items.map((i, k) => (k < stop && history.isRequest(i) ? k : -1)).filter((k) => k >= 0);
	return starts.reduce((tasks, s, k) => {
		const last = (k + 1 < starts.length ? starts[k + 1] : stop) - 1;
		if (last <= s) {
			return tasks;
		}
		const span = items.slice(s, last + 1);
		const done = history.answered(span);
		const open = span.some((i) => history.callsOf(i).some((c) => !done.has(c.id)));
		if (open) {
			return tasks;
		}
		tasks.push({
			kind: "task",
			from: items[s].id,
			to: items[last].id,
			request: text.firstLine(items[s].text, 70),
			// The compactor's own notes aren't the task's work.
			tokens: history.sumTokens(span.filter((i) => i.role !== "note"), perChar)
		});
		return tasks;
	}, []).sort((a, b) => b.tokens - a.tokens);
};

/** One suggestion as a line of a note, with the call to make. */
const line = (x, cfg) => {
	const t = cfg.tools;
	if (x.kind === "task") {
		return "- the earlier request \"" + x.request + "\" and all its work, " + x.from + " … " + x.to + ", ≈ " + text.kTokens(x.tokens) +
			" tokens: " + t.rewind + " { from: \"" + x.from + "\", to: \"" + x.to + "\", summary } keeping only what the current work still needs";
	}
	if (x.kind === "collapse") {
		return "- " + x.from + " … " + x.to + " (" + x.names + ") ≈ " + text.kTokens(x.tokens) + " tokens: once you've noted what you need from them, " +
			t.rewind + " { from: \"" + x.from + "\", to: \"" + x.to + "\", summary }";
	}
	return "- " + x.id + " (" + x.name + ") ≈ " + text.kTokens(x.tokens) + " tokens: if you no longer need it verbatim, " +
		t.offload + " { entry: \"" + x.id + "\", text }";
};

module.exports = {
	suggestions,
	earlierTasks,
	line,
	toolTally
};
