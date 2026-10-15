const suggestions = require("../suggestions");
const text = require("../utils/text");

/**
 * The compactor's notes to the model: its context size with what to free (`note`), an instruction to free space
 * now (`near`), and the point of a new request (`boundary`). A note item carries `note: { kind, level, tasks }`.
 */

/** The highest threshold noted since the latest summary of the host (a compaction resets it). */
const notedIn = (items) => {
	return items.reduce((noted, item) => {
		if (item.role === "summary") {
			return 0;
		}
		if (item.role === "note" && item.note && typeof item.note.level === "number" && item.note.level > noted) {
			return item.note.level;
		}
		return noted;
	}, 0);
};

/**
 * Whether to note the context size now. A threshold is noted once; it is armed again only when the context falls
 * `margin` points below it, so small dips and rises don't repeat it. Returns the threshold to note, or 0.
 */
const decide = (percent, noted, thresholds, margin) => {
	const crossed = thresholds.filter((t) => percent >= t);
	const top = crossed.length ? Math.max.apply(null, crossed) : 0;
	const held = thresholds.filter((t) => t <= noted && percent >= t - margin);
	const armed = held.length ? Math.max.apply(null, held) : 0;
	if (top > armed) {
		return top;
	}
	return 0;
};

const head = (tokens, window) => {
	const pct = Math.round((tokens / window) * 100);
	return "[context: about " + text.kTokens(tokens) + " of " + text.kTokens(window) + " tokens (" + pct + "%)]";
};

const auto = (cfg, own) => {
	if (!cfg.compactAt) {
		return "";
	}
	return " At " + cfg.compactAt + "% the host compacts automatically" + (own ? " with its own summary." : ".");
};

/** The advisory note, naming the biggest finished parts to free. */
const noteText = (tokens, window, picks, cfg) => {
	const t = cfg.tools;
	if (!picks.length) {
		return head(tokens, window) + " Nothing big is finished yet. When you finish a part, note what the rest needs, then collapse it with " +
			t.rewind + " { from: its first tool result, to: its last, summary }." + auto(cfg);
	}
	return head(tokens, window) + " The biggest finished parts:\n" + picks.map((x) => suggestions.line(x, cfg)).join("\n") + "\n" +
		"Collapse a part when it is done, keeping in the summary what the rest of the work needs verbatim (line numbers, quotes, ids)." + auto(cfg);
};

/** The instruction near the limit: the model's next turn should free space. */
const nearText = (tokens, window, picks, cfg) => {
	const pct = Math.round((tokens / window) * 100);
	let suggested = " ";
	if (picks.length) {
		suggested = " Suggested:\n" + picks.map((x) => suggestions.line(x, cfg)).join("\n") + "\n";
	}
	return "[context] Context nearly full (≈" + text.kTokens(tokens) + " of " + text.kTokens(window) + " tokens, " + pct + "%). " +
		"Before continuing, free space: collapse finished work with " + cfg.tools.rewind + " { from, to, summary }, or offload big results you have used with " +
		cfg.tools.offload + "." + suggested +
		"Keep in any summary everything the remaining work needs verbatim (exact line numbers, quotes, numbers, ids, paths) and what's still to do." + auto(cfg, true);
};

/** The note at a new request when the context holds big finished requests: the moment to keep only what's needed. */
const boundaryText = (tokens, window, tasks, cfg) => {
	const total = tasks.reduce((n, x) => n + x.tokens, 0);
	return "[context: about " + text.kTokens(tokens) + " of " + text.kTokens(window) + " tokens, " + text.kTokens(total) + " of it earlier requests that are done] " +
		"A new request is a good point to keep only what it needs. Unless you need their detail now, collapse them, each into a " +
		"summary of what the current work still needs from it (decisions, results, exact ids); the detail stays findable with " + cfg.tools.search + ". " +
		(cfg.autoCollapse ? "Left as they are, they are collapsed after your next turn, keeping each request and the final reply to it word for word:\n" : "") +
		tasks.map((x) => suggestions.line(x, cfg)).join("\n");
};

/** The nudge to collapse finished work early, before the context is anywhere near full. */
const nudgeText = (picks, cfg) => {
	return "[context: finished work you could collapse now]\n" + picks.map((x) => suggestions.line(x, cfg)).join("\n") + "\n" +
		"If you are done with it, collapse it now rather than when the context is full: put what the rest of the work needs in the summary " +
		"(exact paths, line numbers, ids, decisions). A smaller context is cheaper and keeps you focused; the detail stays findable with " +
		cfg.tools.search + " and " + cfg.tools.restore + ". If you still need it verbatim, go on and ignore this.";
};

/** The note when a task is marked done: collapse its work now. */
const milestoneText = (x, cfg) => {
	return "[context: a task is done] Its work, " + x.from + " … " + x.to + ", is about " + text.kTokens(x.tokens) + " tokens: " +
		cfg.tools.rewind + " { from: \"" + x.from + "\", to: \"" + x.to + "\", summary }. Collapse it now, keeping in the summary what the " +
		"remaining tasks need from it (exact paths, line numbers, ids, decisions), unless the next task needs it verbatim. " +
		"A small context is cheaper and keeps you focused; the detail stays findable with " + cfg.tools.search + ".";
};

module.exports = {
	milestoneText,
	nudgeText,
	notedIn,
	decide,
	noteText,
	nearText,
	boundaryText
};
