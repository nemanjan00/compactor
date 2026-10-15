const createCompactor = require("../index.js").createCompactor;
const history = require("../../history");
const f = require("../../utils/fixtures");

/** A view of `items` with a context size measured at 4 characters a token. */
const viewOf = (items, all, window) => {
	const chars = items.reduce((n, i) => n + history.itemChars(i), 0);
	return { items, all: all || items, usage: { tokens: chars / 4, window } };
};

describe("createCompactor", () => {
	beforeEach(() => {
		f.reset();
	});

	test("a tool call's change waits for the end of the turn, and a later call that turn sees it", () => {
		const c = createCompactor();
		const items = [f.user("go")].concat(f.reads(["a.js"], 3000), f.reads(["b.js"], 3000), [f.pending("context_offload")]);
		const view = viewOf(items, items, 1000000);
		const first = c.callTool("context_offload", { entry: items[2].id, text: "a.js" }, view);
		expect(first.isError).toBe(false);
		expect(c.callTool("context_offload", { entry: items[2].id, text: "again" }, view).text).toMatch(/offloaded already/);
		const out = c.endTurn(view, []);
		expect(out.edits.map((e) => e.target)).toEqual([items[2].id]);
		expect(c.endTurn(view, []).edits).toEqual([]);
	});

	test("errors come back as tool errors", () => {
		const c = createCompactor();
		expect(c.callTool("context_rewind", { from: "nope", summary: "x" }, viewOf([f.user("go")], null, 1000)).isError).toBe(true);
		expect(c.callTool("nope", {}, viewOf([f.user("go")], null, 1000)).isError).toBe(true);
	});

	test("new results over the limit are offloaded at the end of their turn", () => {
		const c = createCompactor({ resultMaxChars: 1000 });
		const items = [f.user("go")].concat(f.reads(["big.log"], 5000));
		expect(c.endTurn(viewOf(items, items, 1000000), [items[2].id]).edits[0].text).toMatch(/^\[offloaded: read returned 5,000/);
	});

	test("the note fires once at 70%, the instruction at 80%, with suggestions", () => {
		const c = createCompactor({ suggestionMinTokens: 0 });
		const items = [f.user("go")].concat(f.reads(["a.js", "b.js"], 4000), f.reads(["c.js"], 4000), f.reads(["d.js"], 200));
		const size = items.reduce((n, i) => n + history.itemChars(i), 0) / 4;
		const at = (pct) => Math.ceil(size / pct * 100);
		const out = c.endTurn(viewOf(items, items, at(72)), []);
		expect(out.notes[0].kind).toBe("note");
		expect(out.notes[0].text).toContain("context_rewind { from: \"" + items[2].id + "\"");
		const noted = items.concat([{ id: "n1", role: "note", text: out.notes[0].text, note: { kind: "note", level: 70 } }]);
		expect(c.endTurn(viewOf(noted, noted, at(74)), []).notes).toEqual([]);
		expect(c.endTurn(viewOf(noted, noted, at(82)), []).notes[0].kind).toBe("near");
	});

	test("a new request after big finished ones gets a note, and they are collapsed after the next turn if left", () => {
		const c = createCompactor();
		const t1 = [f.user("summarise the logs")].concat(f.reads(["log1", "log2"], 8000), [f.reply("two errors: E1 and E2")]);
		const before = viewOf(t1, t1, 10000);
		const note = c.startRequest(before);
		expect(note.kind).toBe("boundary");
		expect(note.tasks).toEqual([t1[0].id]);
		expect(note.text).toContain("context_rewind { from: \"" + t1[0].id + "\"");
		const now = t1.concat([f.user("now fix E1"), { id: "n1", role: "note", text: note.text, note: { kind: "boundary" } }], f.reads(["src.js"], 500));
		const out = c.endTurn(viewOf(now, now, 10000), []);
		const view = history.applyEdits(now, out.edits, now);
		expect(view.map((i) => i.id)).toEqual([t1[0].id, t1[4].id].concat(now.slice(5).map((i) => i.id)));
		// Once only.
		expect(c.endTurn(viewOf(view, now, 10000), []).edits).toEqual([]);
	});

	test("no boundary note for small earlier requests", () => {
		const c = createCompactor();
		const t1 = [f.user("lunch anyone?"), f.reply("sure")];
		expect(c.startRequest(viewOf(t1, t1, 100000))).toBeUndefined();
	});

	test("compact asks the model with the prompt and indexes what it replaced", () => {
		const c = createCompactor();
		const items = [f.user("review the parser")].concat(f.reads(["a.js"], 3000));
		let prompt = "";
		return c.compact({ items, previousSummary: "earlier: set up the repo" }, (p, o) => {
			prompt = p;
			expect(o.maxTokens).toBe(8000);
			return Promise.resolve({ text: "parser reviewed\nKeywords: parser", usage: { input: 1 } });
		}).then((r) => {
			expect(prompt).toContain("<previous-summary>\nearlier: set up the repo");
			expect(prompt).toContain("[User]: review the parser");
			expect(prompt).toContain("[Assistant tool calls]: read({\"path\":\"a.js\"})");
			expect(r.summary).toMatch(/^parser reviewed\nKeywords: parser\n\n\[index of what this replaced/);
			expect(r.summary).toContain("→ entry " + items[2].id);
			return c.compact({ items }, () => Promise.resolve({ text: "  " }));
		}).then((r) => {
			expect(r).toBeUndefined();
		});
	});
});
