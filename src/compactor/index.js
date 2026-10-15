const config = require("../config").config;
const history = require("../history");
const suggestions = require("../suggestions");
const notes = require("../notes");
const collapse = require("../collapse");
const offload = require("../offload");
const compaction = require("../compaction");
const tools = require("../tools");

/**
 * The compactor for one session. A harness adapter calls it at four points and applies what it returns:
 *
 *   callTool(name, args, view)          the model called one of `tools`: returns `{ text, isError }`; any change it
 *                                       makes is held until the end of the turn
 *   endTurn(view, newResultIds)         a turn ended (its tool results are in): returns `{ edits, notes }` to apply
 *                                       before the next model call
 *   startRequest(view)                  a new request is about to start: returns a note, or undefined
 *   compact(job, complete)              the host compacts: returns a Promise of `{ summary, usage }`, or undefined to
 *                                       let the host summarise
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
			if (!view.usage || !view.usage.window) {
				return out;
			}
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
			if (!tasks.length || total < (view.usage.window * cfg.boundaryAt) / 100) {
				return undefined;
			}
			state.named = tasks.map((t) => t.from);
			const tokens = history.sumTokens(view.items, perChar);
			return { kind: "boundary", level: 0, tasks: state.named.slice(), text: notes.boundaryText(tokens, view.usage.window, tasks, cfg) };
		},

		/**
		 * Write the summary of a compaction with the model, and index what it replaces.
		 * @param {{items: object[], compacted?: object[], previousSummary?: string, instructions?: string, signal?: AbortSignal, usage?: object}} job
		 *   `items`: what to summarise; `compacted`: the originals it replaces (for the index; default `items`)
		 * @param {(prompt: string, o: {maxTokens: number, signal?: AbortSignal}) => Promise<{text: string, usage?: object}>} complete
		 */
		compact: (job, complete) => {
			const prompt = compaction.request(job.items, job, cfg);
			const perChar = history.tokensPerChar(job.items, job.usage, cfg);
			return complete(prompt, { maxTokens: cfg.summaryMaxTokens, signal: job.signal }).then((r) => {
				if (!r || !String(r.text || "").trim()) {
					return undefined;
				}
				return { summary: compaction.finish(r.text, job.compacted || job.items, perChar, cfg), usage: r.usage };
			});
		}
	};
	return compactor;
};

module.exports = {
	createCompactor
};
