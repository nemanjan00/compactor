const collapse = require("../collapse");
const offload = require("../offload");
const restore = require("../restore");
const search = require("../search");

/**
 * The model's context tools, harness-neutral: a name, a description, parameters as a flat map of
 * `{ type: "string"|"number", description, required }`, and `run(args, view)` returning `{ text, edits? }` or
 * `{ error }`. `view` is `{ items, all, perChar }`. An adapter registers them with its harness.
 */
const specs = (cfg) => {
	const t = cfg.tools;
	return [
		{
			name: t.rewind,
			label: "Collapse",
			description: "Shrink your context by replacing a finished stretch of your history with your summary. " +
				"Give from and to: everything from the turn of from through the results of to becomes your summary, while everything after it stays word for word. " +
				"E.g. you read many files: from = the first result, to = the last one, summary = what you learned from them. " +
				"from and to are entry ids (each tool result starts with [entry <id>]) or tool call ids. " +
				"The summary is all that's left of the stretch: put in every fact, id, path, decision and open item you still need, and copy exact values verbatim (line numbers, ids, names, figures, quotes). " +
				"End it with a line \"Keywords: …\": the words a later question about this material might use, synonyms and everyday words included (e.g. \"cost, invoice, spend, bill went up\"), so a search in other words finds it. " +
				"An index of the replaced calls and the entries holding their results is appended, so one result can be read back later with " + t.restore + ". " +
				"Finished stretches worth collapsing are named, with their ids, when the context grows. Takes effect from your next turn.",
			params: {
				from: { type: "string", required: true, description: "The entry id of an earlier tool result (as in the [entry <id>] it starts with), a tool call id, or a message's entry id: where the stretch starts." },
				to: { type: "string", description: "The entry id of a later tool result (or a tool call id): the stretch ends after its turn's results. Default: the turn of from." },
				summary: { type: "string", required: true, description: "What the stretch did and found: everything from it you still need. End with a line \"Keywords: …\" of words a later question might use, synonyms included." }
			},
			run: (args, view) => collapse.rewind(view.items, args, view.perChar, cfg)
		},
		{
			name: t.offload,
			label: "Offload",
			description: "Replace one big item of your history (a tool result you have already used, a long message) with a one-line pointer. " +
				"Name it by its entry id (each tool result starts with [entry <id>]) or by the id of the tool call whose result it is. " +
				"The original stays stored: " + t.restore + " reads it back. Takes effect from your next turn.",
			params: {
				entry: { type: "string", required: true, description: "The entry id, or the id of the tool call whose result to offload." },
				text: { type: "string", required: true, description: "One line saying what the pointer stands for." }
			},
			run: (args, view) => offload.offload(view.items, args, view.perChar, cfg)
		},
		{
			name: t.restore,
			label: "Restore",
			description: "Two things, and only these. With offset and length: reads a piece of the original text of one entry of this session by its id, changing nothing: " +
				"an offloaded result, a big result in parts, or one entry of a collapsed or compacted stretch (their indexes and " + t.search + " give the ids). " +
				"Without offset and length: puts an offloaded entry back in place of its pointer (it costs context). " +
				"A collapsed or compacted stretch was summarised on purpose: rely on its summary, and read an entry of it only for a detail the work needs now.",
			params: {
				entry: { type: "string", required: true, description: "The entry id (pointers and indexes name it), or a tool call id." },
				offset: { type: "number", description: "Character to start reading at (0 is the start)." },
				length: { type: "number", description: "Characters to read (at most " + cfg.pieceMax + ")." }
			},
			run: (args, view) => restore.restore(view.items, view.all, args, cfg)
		},
		{
			name: t.search,
			label: "Search",
			description: "Full-text search over everything in this session, including what was offloaded, collapsed or compacted: messages, tool call arguments and tool results. " +
				"Every word must appear, in any order, newest first; when no entry has them all, the entries with the most of them come back, ranked. " +
				"Words match as written, not by meaning: when the words of a question may not be the material's, search a few short queries, one idea each, " +
				"with the words the material would use and their synonyms (e.g. \"cost\", \"invoice\", \"spend\" for a bill that went up), rather than one long phrase. " +
				"Each hit comes with a ready " + t.restore + " call that reads the text around it.",
			params: {
				text: { type: "string", required: true, description: "Words to find, e.g. \"parser dates\": a few words, one idea." },
				limit: { type: "number", description: "How many hits (default " + cfg.searchLimit + ")." }
			},
			run: (args, view) => search.search(view.all, args, cfg)
		}
	];
};

module.exports = {
	specs
};
