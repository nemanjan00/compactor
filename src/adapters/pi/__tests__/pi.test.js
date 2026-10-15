// TypeBox ships as ES modules only; pi provides it at run time. Its schemas are JSON Schema, so a stand-in will do.
jest.mock("typebox", () => {
	const optional = Symbol("optional");
	return {
		Type: {
			String: (o) => Object.assign({ type: "string" }, o),
			Number: (o) => Object.assign({ type: "number" }, o),
			Optional: (s) => Object.assign({ [optional]: true }, s),
			Object: (props) => ({
				type: "object",
				properties: props,
				required: Object.keys(props).filter((k) => !props[k][optional])
			})
		}
	};
});

const extension = require("../index.js");
const session = require("../session");

/** A made-up pi session: a request, a turn reading two files, and a reply. */
const entries = () => {
	const msg = (id, message) => ({ type: "message", id, message });
	return [
		msg("u1", { role: "user", content: [{ type: "text", text: "review the parser" }] }),
		msg("a1", { role: "assistant", content: [
			{ type: "text", text: "reading" },
			{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.js" } },
			{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.js" } }
		] }),
		msg("r1", { role: "toolResult", toolCallId: "call_a", toolName: "read", isError: false, content: [{ type: "text", text: "x".repeat(30000) }] }),
		msg("r2", { role: "toolResult", toolCallId: "call_b", toolName: "read", isError: false, content: [{ type: "text", text: "parse dates at line 12" }] }),
		msg("a2", { role: "assistant", content: [{ type: "text", text: "line 12 parses dates" }] })
	];
};

const fakeSessionManager = (list) => ({
	getEntries: () => list,
	getBranch: () => list,
	getEntry: (id) => list.find((e) => e.id === id),
	buildSessionProjection: () => ({
		entries: list.map((e) => ({ sourceEntry: e, messages: e.type === "message" ? [e.message] : [] }))
	})
});

const fakePi = () => {
	const pi = { tools: [], handlers: {} };
	pi.registerTool = (t) => pi.tools.push(t);
	pi.on = (name, fn) => {
		pi.handlers[name] = fn;
	};
	return pi;
};

const ctxOf = (list) => ({
	sessionManager: fakeSessionManager(list),
	getContextUsage: () => ({ tokens: 9000, contextWindow: 200000, percent: 4.5 })
});

describe("pi adapter", () => {
	test("registers the four tools with TypeBox parameters", () => {
		const pi = fakePi();
		extension(pi, {});
		expect(pi.tools.map((t) => t.name)).toEqual(["context_rewind", "context_offload", "context_restore", "context_search"]);
		expect(pi.tools[0].parameters.required).toEqual(["from", "summary"]);
		["session_start", "context", "before_agent_start", "turn_end"].forEach((h) => {
			expect(typeof pi.handlers[h]).toBe("function");
		});
		expect(pi.handlers.session_before_compact).toBeUndefined();
	});

	test("labels tool results with their entry ids, once", () => {
		const pi = fakePi();
		extension(pi, {});
		const list = entries();
		const messages = list.map((e) => e.message);
		const out = pi.handlers.context({ messages }, ctxOf(list)).messages;
		expect(out[2].content[0].text.startsWith("[entry r1] ")).toBe(true);
		expect(out[3].content[0].text).toBe("[entry r2] parse dates at line 12");
		expect(out[0]).toBe(messages[0]);
		const again = pi.handlers.context({ messages: out }, ctxOf(list)).messages;
		expect(again[3].content[0].text).toBe("[entry r2] parse dates at line 12");
	});

	test("a big new result becomes a context_edit at the end of its turn, but a read stays whole", () => {
		const pi = fakePi();
		extension(pi, {});
		const list = entries();
		expect(pi.handlers.turn_end({ toolResultEntryIds: ["r1", "r2"] }, ctxOf(list))).toBeUndefined();
		list[2].message.toolName = "bash";
		const out = pi.handlers.turn_end({ toolResultEntryIds: ["r1", "r2"] }, ctxOf(list));
		expect(out.entries).toHaveLength(1);
		expect(out.entries[0].type).toBe("context_edit");
		expect(out.entries[0].targetId).toBe("r1");
		expect(out.entries[0].replacement.content[0].text).toMatch(/^\[offloaded: bash returned 30,000 characters/);
	});

	test("a rewind keeps the first call block and puts the summary in its result", () => {
		const pi = fakePi();
		extension(pi, {});
		const list = entries();
		const rewind = pi.tools.find((t) => t.name === "context_rewind");
		list[2].message.content[0].text = "x".repeat(3000);
		return rewind.execute("call_x", { from: "r1", to: "r2", summary: "line 12 parses dates\nKeywords: parser, dates" }, undefined, undefined, ctxOf(list)).then((r) => {
			expect(r.content[0].text).toMatch(/^Collapsed 3 entries/);
			const out = pi.handlers.turn_end({ toolResultEntryIds: [] }, ctxOf(list));
			const byTarget = new Map(out.entries.map((e) => [e.targetId, e.replacement]));
			expect(byTarget.get("a1").content).toEqual([list[1].message.content[1]]);
			expect(byTarget.get("r1").content[0].text).toMatch(/^\[collapsed with context_rewind/);
			expect(byTarget.get("r2")).toBeNull();
		});
	});

	test("a tool error is thrown, so pi reports a failed tool call", () => {
		const pi = fakePi();
		extension(pi, {});
		const restore = pi.tools.find((t) => t.name === "context_restore");
		return expect(restore.execute("c", { entry: "nope" }, undefined, undefined, ctxOf(entries()))).rejects.toThrow(/not an entry/);
	});

	test("a note is a hidden custom message the next session load reads back as a note", () => {
		const m = session.noteMessage({ kind: "note", level: 70, text: "[context: …]" });
		expect(m).toEqual({ customType: "compactor", content: "[context: …]", display: false, details: { kind: "note", level: 70, tasks: [] } });
		const item = session.entryItem(Object.assign({ type: "custom_message", id: "n1" }, m));
		expect(item.role).toBe("note");
		expect(item.note.level).toBe(70);
	});

	test("search covers entries off the current branch, and says so", () => {
		const list = entries();
		const other = { type: "message", id: "o1", message: { role: "user", content: [{ type: "text", text: "try the invoice parser instead" }] } };
		const all = session.allItems(list.concat([other]), list);
		expect(all.find((i) => i.id === "o1").offBranch).toBe(true);
		const pi = fakePi();
		extension(pi, {});
		const ctx = ctxOf(list);
		ctx.sessionManager.getEntries = () => list.concat([other]);
		const search = pi.tools.find((t) => t.name === "context_search");
		return search.execute("c", { text: "invoice" }, undefined, undefined, ctx).then((r) => {
			expect(r.content[0].text).toContain("entry o1 (user, on another branch)");
		});
	});

	test("compactedItems are the branch's entries since the previous compaction's kept boundary", () => {
		const list = entries();
		const withCompaction = list.slice(0, 2).concat([{ type: "compaction", id: "c1", firstKeptEntryId: "a1", summary: "s" }], list.slice(2));
		expect(session.compactedItems(withCompaction, "a2").map((i) => i.id)).toEqual(["a1", "r1", "r2"]);
	});
});
