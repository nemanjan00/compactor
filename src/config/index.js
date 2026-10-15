/**
 * Defaults for every threshold and size the compactor uses. A harness adapter passes overrides to
 * `createCompactor(options)`; percentages are of the model's context window.
 */
const DEFAULTS = {
	// A short note about the context size, with the biggest finished parts to free (percent of the window).
	noteAt: 70,
	// An instruction to free space before going on (percent of the window).
	nearAt: 80,
	// The window to manage against, when smaller than the model's (tokens; null = the model's).
	contextWindow: null,
	// Where the host compacts on its own, mentioned in the notes (percent of the window; null = not mentioned).
	compactAt: null,
	// Finished earlier requests that take this share of the window get a note at a new request (0 = off).
	boundaryAt: 30,
	// When the model goes on without collapsing the finished requests a boundary note named, collapse them after its
	// next turn: each request and its final reply kept, the work in between replaced by an index (no summary).
	autoCollapse: false,
	// … or this many tokens, if fewer (0 = only the share), so a big window doesn't put it off.
	boundaryTokens: 40000,
	// The least a finished earlier request must take (tokens) to be named in the note at a new request.
	taskMinTokens: 4000,
	// A finished stretch of tool calls this big (tokens) gets a short note suggesting to collapse it, whatever the
	// window (0 = off).
	nudgeTokens: 25000,
	// Tool calls that mark a finished task (e.g. a todo marked completed): `{ tool, args }`, every given argument equal.
	// When one is made, the work since the previous one gets a note suggesting to collapse it.
	milestones: [],
	// The least work (tokens) a milestone note names.
	milestoneMinTokens: 4000,
	// Points the context must fall below a noted threshold before that threshold can be noted again.
	rearmMargin: 15,
	// A tool result longer than this (characters) is replaced at once by its head and tail (0 = off).
	resultMaxChars: 20000,
	// Tools whose results are never offloaded as they arrive (the compactor's own tools never are).
	keepWhole: [],
	pointerHead: 2000,
	pointerTail: 1000,
	// The longest piece `restore` reads at once (characters); kept under `resultMaxChars` so a piece is never offloaded.
	pieceMax: 16000,
	// Lines an index of a collapsed stretch lists at most.
	indexMax: 40,
	searchLimit: 10,
	// Characters around a search hit shown in its snippet.
	snippetChars: 160,
	// Characters per token before a measured context size is known.
	charsPerToken: 3.5,
	suggestionsMax: 3,
	// Parts smaller than this (tokens) aren't suggested.
	suggestionMinTokens: 500,
	// The names of the model's tools.
	tools: {
		rewind: "context_rewind",
		offload: "context_offload",
		restore: "context_restore",
		search: "context_search"
	}
};

/**
 * The defaults with `overrides` on top (`tools` merged name by name).
 * @param {Partial<typeof DEFAULTS>} [overrides]
 */
const config = (overrides) => {
	const o = overrides || {};
	return Object.assign({}, DEFAULTS, o, { tools: Object.assign({}, DEFAULTS.tools, o.tools || {}) });
};

module.exports = {
	DEFAULTS,
	config
};
