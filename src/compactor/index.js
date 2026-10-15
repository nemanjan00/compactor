const config = require("../config").config;
const history = require("../history");
const suggestions = require("../suggestions");
const notes = require("../notes");
const collapse = require("../collapse");
const offload = require("../offload");
const tools = require("../tools");

/**
 * The compactor for one session. It never writes a summary itself: it tells the model what to free and gives it the
 * tools; the model writes every summary. A harness adapter calls it at three points and applies what it returns:
 *
 *   callTool(name, args, view)          the model called one of `tools`: returns `{ text, isError }`; any change it
 *                                       makes is held until the end of the turn
 *   endTurn(view, newResultIds)         a turn ended (its tool results are in): returns `{ edits, notes }` to apply
 *                                       before the next model call
 *   startRequest(view)                  a new request is about to start: returns a note, or undefined
 *
 * `view` is `{ items, all, usage: { tokens, window } }` (see `history`). Edits are `{ target, drop | text | calls |
 * restore }`; a note is `{ kind, level, tasks, text }`.
 * @param {object} [options] overrides of `config.DEFAULTS`
 */
const createCompactor = (options) => {
	const cfg = config(options);
	const specs = tools.specs(cfg);
	const state = { pending: [], named: [] };

	/** The view with its window capped at `cfg.contextWindow`. */
	const capped = (view) => {
		if (!cfg.contextWindow || !view.usage || !(view.usage.window > cfg.contextWindow)) {
			return view;
		}
		return Object.assign({}, view, { usage: Object.assign({}, view.usage, { window: cfg.contextWindow }) });
	};

	const perCharOf = (view) => history.tokensPerChar(view.items, view.usage, cfg);

	/** The view with the changes held for the end of the turn applied, so a later call this turn sees them. */
	const withPending = (view) => {
		return Object.assign({}, view, { items: history.applyEdits(view.items, state.pending, view.all), perChar: perCharOf(view) });
	};

	/**
	 * A short note naming finished stretches of at least `cfg.nudgeTokens`, whatever the window: so the model collapses
	 * finished work early. A stretch is named again only after it grew by another `cfg.nudgeTokens`.
	 */
	const nudgeFor = (items, perChar) => {
		if (!cfg.nudgeTokens) {
			return undefined;
		}
		// The size each stretch (by where it starts) had when it was last named.
		const nudged = items
			.filter((i) => i.role === "note" && i.note && i.note.kind === "nudge")
			.reduce((m, i) => {
				(i.note.tasks || []).forEach((from, k) => {
					m.set(from, ((i.note.sizes || [])[k]) || Infinity);
				});
				return m;
			}, new Map());
		const picks = suggestions.suggestions(items, perChar, Object.assign({}, cfg, { suggestionMinTokens: cfg.nudgeTokens }))
			.filter((x) => x.kind === "collapse" && (!nudged.has(x.from) || x.tokens >= nudged.get(x.from) + cfg.nudgeTokens));
		if (!picks.length) {
			return undefined;
		}
		return { kind: "nudge", level: 0, tasks: picks.map((x) => x.from), sizes: picks.map((x) => x.tokens), text: notes.nudgeText(picks, cfg) };
	};

	/** Whether a tool call marks a finished task (`cfg.milestones`). */
	const isMilestone = (call) => {
		let args = {};
		try {
			args = JSON.parse(call.args || "{}");
		} catch {
			return false;
		}
		return (cfg.milestones || []).some((m) => {
			return m.tool === call.name && Object.keys(m.args || {}).every((k) => args[k] === m.args[k]);
		});
	};

	const hasMilestone = (item) => history.callsOf(item).some(isMilestone);

	/**
	 * When the latest turn marked a task finished: a note naming the work since the previous milestone (or the start of
	 * the request), through this turn, to collapse it now. Each milestone is named once.
	 */
	const milestoneFor = (items, perChar) => {
		if (!(cfg.milestones || []).length) {
			return undefined;
		}
		const last = items.map((i) => history.callsOf(i).length > 0).lastIndexOf(true);
		if (last < 0 || !hasMilestone(items[last])) {
			return undefined;
		}
		const request = latestRequest(items);
		let start = Math.max(0, request === items.length ? 0 : request);
		for (let k = last - 1; k > start; k--) {
			if (hasMilestone(items[k])) {
				start = k;
				break;
			}
		}
		// The previous milestone's own results belong to it.
		const before = new Set(history.callsOf(items[start]).map((c) => c.id));
		while (start + 1 < items.length && items[start + 1].role === "toolResult" && before.has(items[start + 1].callId)) {
			start += 1;
		}
		const span = items.slice(start + 1).filter((i) => i.role !== "note");
		const results = span.filter((i) => i.role === "toolResult");
		if (!results.length) {
			return undefined;
		}
		const from = results[0].id;
		const named = items.some((i) => i.role === "note" && i.note && i.note.kind === "milestone" && (i.note.tasks || []).includes(from));
		const tokens = history.sumTokens(span, perChar);
		if (named || tokens < cfg.milestoneMinTokens) {
			return undefined;
		}
		const to = results[results.length - 1].id;
		return { kind: "milestone", level: 0, tasks: [from], text: notes.milestoneText({ from, to, tokens }, cfg) };
	};

	const latestRequest = (items) => {
		const k = items.map(history.isRequest).lastIndexOf(true);
		return k < 0 ? items.length : k;
	};

	const compactor = {
		config: cfg,
		tools: specs,

		/** Forget what is held (a new or switched session). */
		reset: () => {
			state.pending = [];
			state.named = [];
		},

		callTool: (name, args, view) => {
			const spec = specs.find((s) => s.name === name);
			if (!spec) {
				return { text: "unknown tool " + name, isError: true };
			}
			const r = spec.run(args || {}, withPending(view));
			if (r.error) {
				return { text: r.error, isError: true };
			}
			state.pending = state.pending.concat(r.edits || []);
			return { text: r.text, isError: false };
		},

		endTurn: (input, newResultIds) => {
			const view = capped(input);
			const perChar = perCharOf(view);
			const fresh = view.items.filter((i) => (newResultIds || []).includes(i.id));
			let edits = state.pending.concat(offload.oversized(fresh, cfg));
			state.pending = [];
			let items = history.applyEdits(view.items, edits, view.all);
			if (state.named.length) {
				const tasks = suggestions.earlierTasks(items, perChar, latestRequest(items));
				const c = collapse.boundaryCollapse(items, tasks, state.named, perChar, cfg);
				state.named = [];
				if (c) {
					edits = edits.concat(c.edits);
					items = history.applyEdits(items, c.edits, view.all);
				}
			}
			const out = { edits, notes: [] };
			if (view.usage && view.usage.window) {
				const tokens = history.sumTokens(items, perChar);
				const percent = (tokens / view.usage.window) * 100;
				const thresholds = [cfg.noteAt, cfg.nearAt].filter((t) => t > 0 && (!cfg.compactAt || t < cfg.compactAt));
				const level = notes.decide(percent, notes.notedIn(items), thresholds, cfg.rearmMargin);
				if (level) {
					const picks = suggestions.suggestions(items, perChar, cfg);
					const near = level >= cfg.nearAt;
					out.notes.push({
						kind: near ? "near" : "note",
						level,
						text: near ? notes.nearText(tokens, view.usage.window, picks, cfg) : notes.noteText(tokens, view.usage.window, picks, cfg)
					});
					return out;
				}
			}
			const nudge = milestoneFor(items, perChar) || nudgeFor(items, perChar);
			if (nudge) {
				out.notes.push(nudge);
			}
			return out;
		},

		startRequest: (input) => {
			const view = capped(input);
			state.named = [];
			if (!cfg.boundaryAt || !view.usage || !view.usage.window) {
				return undefined;
			}
			const perChar = perCharOf(view);
			const tasks = suggestions.earlierTasks(view.items, perChar, view.items.length);
			const total = tasks.reduce((n, t) => n + t.tokens, 0);
			let threshold = (view.usage.window * cfg.boundaryAt) / 100;
			if (cfg.boundaryTokens) {
				threshold = Math.min(threshold, cfg.boundaryTokens);
			}
			if (!tasks.length || total < threshold) {
				return undefined;
			}
			if (cfg.autoCollapse) {
				state.named = tasks.map((t) => t.from);
			}
			const tokens = history.sumTokens(view.items, perChar);
			return { kind: "boundary", level: 0, tasks: tasks.map((t) => t.from), text: notes.boundaryText(tokens, view.usage.window, tasks, cfg) };
		}
	};
	return compactor;
};

module.exports = {
	createCompactor
};
