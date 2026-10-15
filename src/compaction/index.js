const history = require("../history");
const collapse = require("../collapse");
const text = require("../utils/text");

/** The instruction for the summary call of a compaction. */
const PROMPT = `Your context is nearly full, so it is being compacted. Write a summary of the work in the conversation below that lets you carry on without its messages. Don't call tools; reply with the summary only.

Include:
- The goal and the deliverable, and who asked for it.
- Decisions made, and why.
- The current state: what is done, what was tried and didn't work.
- What is still to do: the remaining steps, in order.
- Verbatim, everything the remaining work or the deliverable needs: exact line numbers, file paths, quotes, figures, ids, branches, commands, links. Copy them exactly; the messages will be gone, so a paraphrase or "see above" loses them.

- Last, a line "Keywords: …": the words a later question about this material might use, synonyms and everyday words included, so a search in other words finds it.

Be concise and factual about everything else: at most about 2,000 words. The most recent messages are kept verbatim after your summary, so focus on what came before them.`;

/** Items written out as text for a summary call, tool results cut to `cfg.serializeResultChars`. */
const serialize = (items, cfg) => {
	return items.map((item) => {
		if (item.role === "user") {
			return "[User]: " + item.text;
		}
		if (item.role === "assistant") {
			const calls = history.callsOf(item).map((c) => c.name + "(" + text.clip(text.flat(c.args), 300) + ")");
			const parts = [];
			if ((item.text || "").trim()) {
				parts.push("[Assistant]: " + item.text);
			}
			if (calls.length) {
				parts.push("[Assistant tool calls]: " + calls.join("; "));
			}
			return parts.join("\n");
		}
		if (item.role === "toolResult") {
			const body = item.text || "";
			let cut = body;
			if (body.length > cfg.serializeResultChars) {
				cut = body.slice(0, cfg.serializeResultChars) + "\n[… " + text.count(body.length - cfg.serializeResultChars) + " more characters]";
			}
			return "[Tool result" + (item.isError ? ", an error" : "") + "]: " + cut;
		}
		if (item.role === "summary") {
			return "[Earlier summary]: " + item.text;
		}
		return "[Note]: " + item.text;
	}).filter(Boolean).join("\n\n");
};

/**
 * The prompt of a summary call.
 * @param {object[]} items what to summarise
 * @param {{previousSummary?: string, instructions?: string}} o
 */
const request = (items, o, cfg) => {
	const parts = [PROMPT];
	if (o.previousSummary) {
		parts.push("The summary of what came before (fold what still matters into yours):\n<previous-summary>\n" + o.previousSummary + "\n</previous-summary>");
	}
	if (o.instructions) {
		parts.push("Also: " + o.instructions);
	}
	parts.push("<conversation>\n" + serialize(items, cfg) + "\n</conversation>");
	return parts.join("\n\n");
};

/** The summary with an index of the items it replaced (`compacted`, originals), so any of them can be read back. */
const finish = (summary, compacted, perChar, cfg) => {
	return summary.trim() + collapse.index(compacted.filter((i) => i.role !== "note"), perChar, cfg);
};

module.exports = {
	PROMPT,
	serialize,
	request,
	finish
};
