/**
 * Maps a pi session onto the core's history items, and the core's edits and notes back onto pi session entries.
 * Pi (https://pi.dev) keeps a session as a tree of entries; what the model sees is the current branch's projection,
 * with `context_edit` entries applied.
 */

/** The custom type of the compactor's own notes. */
const NOTE_TYPE = "compactor";

const blocksText = (content) => {
	if (typeof content === "string") {
		return content;
	}
	return (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
};

const imageCount = (content) => {
	if (typeof content === "string") {
		return 0;
	}
	return (content || []).filter((b) => b.type === "image").length;
};

/** One pi message (an AgentMessage) as a history item with id `id`. */
const messageItem = (id, m) => {
	if (m.role === "user") {
		return { id, role: "user", text: blocksText(m.content), images: imageCount(m.content) };
	}
	if (m.role === "assistant") {
		const content = m.content || [];
		return {
			id,
			role: "assistant",
			text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
			calls: content.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id, name: b.name, args: JSON.stringify(b.arguments || {}) }))
		};
	}
	if (m.role === "toolResult") {
		return {
			id,
			role: "toolResult",
			callId: m.toolCallId,
			toolName: m.toolName,
			isError: !!m.isError,
			text: blocksText(m.content),
			images: imageCount(m.content)
		};
	}
	if (m.role === "custom") {
		if (m.customType === NOTE_TYPE) {
			return { id, role: "note", text: blocksText(m.content), note: m.details || {} };
		}
		return { id, role: "event", text: blocksText(m.content) };
	}
	if (m.role === "compactionSummary" || m.role === "branchSummary") {
		return { id, role: "summary", text: m.summary || "" };
	}
	if (m.role === "bashExecution") {
		return { id, role: "event", text: "$ " + m.command + "\n" + (m.output || "") };
	}
	return undefined;
};

/** One session entry as a history item (its original), or undefined for entries that aren't messages. */
const entryItem = (entry) => {
	if (entry.type === "message") {
		return messageItem(entry.id, entry.message);
	}
	if (entry.type === "custom_message") {
		return messageItem(entry.id, { role: "custom", customType: entry.customType, content: entry.content, details: entry.details });
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { id: entry.id, role: "summary", text: entry.summary || "" };
	}
	return undefined;
};

/** What the model sees now: the projection's entries that contribute messages, as items (edits applied). */
const projectedItems = (projected) => {
	return projected.reduce((out, p) => {
		(p.messages || []).forEach((m) => {
			const item = messageItem(p.sourceEntry.id, m);
			if (item) {
				out.push(item);
			}
		});
		return out;
	}, []);
};

/** Every entry of the session tree as an item (originals), those off the current branch marked `offBranch`. */
const allItems = (entries, branch) => {
	const on = new Set(branch.map((e) => e.id));
	return entries.map((e) => {
		const item = entryItem(e);
		if (item && !on.has(e.id)) {
			item.offBranch = true;
		}
		return item;
	}).filter(Boolean);
};

/** Characters of the request beyond the messages: the system prompt (tool definitions are part of it in pi). */
const baseChars = (ctx) => {
	if (!ctx.getSystemPrompt) {
		return 0;
	}
	return String(ctx.getSystemPrompt() || "").length;
};

/**
 * The core's view of a pi session: `{ items, all, usage }`.
 * @param {object} ctx pi's ExtensionContext
 * @param {object[]} [projected] projection entries to use instead of the session's (a boundary event's preview)
 */
const view = (ctx, projected) => {
	const sm = ctx.sessionManager;
	const entries = projected || sm.buildSessionProjection().entries;
	const usage = ctx.getContextUsage ? ctx.getContextUsage() : undefined;
	let measured;
	if (usage && usage.contextWindow) {
		measured = { tokens: usage.tokens || 0, window: usage.contextWindow, baseChars: baseChars(ctx) };
	}
	return { items: projectedItems(entries), all: allItems(sm.getEntries(), sm.getBranch()), usage: measured };
};

const textContent = (text) => [{ type: "text", text }];

/**
 * A core edit as a pi `context_edit` draft. Pi edits change only an entry's content: a dropped entry is omitted, a
 * replaced one gets the text, `calls` keeps those tool call blocks of the original, `restore` puts the original back.
 */
const editDraft = (edit, sm) => {
	if (edit.drop) {
		return { type: "context_edit", targetId: edit.target, replacement: null };
	}
	const entry = sm.getEntry(edit.target);
	let original;
	if (entry && entry.type === "message") {
		original = entry.message.content;
	} else if (entry) {
		original = entry.content;
	}
	if (edit.restore) {
		return { type: "context_edit", targetId: edit.target, replacement: { content: original } };
	}
	if (edit.calls) {
		const kept = (original || []).filter((b) => b.type === "toolCall" && edit.calls.includes(b.id));
		return { type: "context_edit", targetId: edit.target, replacement: { content: kept } };
	}
	if (entry && entry.type === "custom_message") {
		return { type: "context_edit", targetId: edit.target, replacement: { content: edit.text } };
	}
	return { type: "context_edit", targetId: edit.target, replacement: { content: textContent(edit.text) } };
};

/** A core note as a pi custom message: hidden in the transcript, sent to the model as a user message. */
const noteMessage = (note) => {
	return {
		customType: NOTE_TYPE,
		content: note.text,
		display: false,
		details: { kind: note.kind, level: note.level || 0, tasks: note.tasks || [] }
	};
};

/** A tool result's text with its entry id in front, so the model can name it: `[entry 1a2b3c4d] …`. */
const labelResults = (messages, ids) => {
	return messages.map((m) => {
		const id = m.role === "toolResult" ? ids.get(m.toolCallId) : undefined;
		if (!id) {
			return m;
		}
		const label = "[entry " + id + "] ";
		const content = Array.isArray(m.content) ? m.content : textContent(String(m.content || ""));
		const first = content.findIndex((b) => b.type === "text");
		if (first < 0) {
			return Object.assign({}, m, { content: textContent(label.trim()).concat(content) });
		}
		if (content[first].text.startsWith(label)) {
			return m;
		}
		const next = content.slice();
		next[first] = Object.assign({}, content[first], { text: label + content[first].text });
		return Object.assign({}, m, { content: next });
	});
};

/** Tool call id → the entry id of its result, for the current branch. */
const resultIds = (branch) => {
	return new Map(branch
		.filter((e) => e.type === "message" && e.message.role === "toolResult")
		.map((e) => [e.message.toolCallId, e.id]));
};

module.exports = {
	NOTE_TYPE,
	messageItem,
	entryItem,
	projectedItems,
	allItems,
	view,
	editDraft,
	noteMessage,
	labelResults,
	resultIds
};
