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

	test("a new request after big finished ones gets a note, and with autoCollapse they are collapsed after the next turn if left", () => {
		const c = createCompactor({ autoCollapse: true });
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

	test("contextWindow caps the window the notes measure against", () => {
		const c = createCompactor({ contextWindow: 10000 });
		const t1 = [f.user("summarise the logs")].concat(f.reads(["log1", "log2"], 8000), [f.reply("two errors")]);
		expect(c.startRequest(viewOf(t1, t1, 1000000)).text).toContain("of 10k tokens");
	});

	test("a finished stretch over nudgeTokens gets a nudge once, whatever the window", () => {
		const c = createCompactor({ nudgeTokens: 2000 });
		const done = f.reads(["a.js", "b.js"], 6000);
		const items = [f.user("go")].concat(done, f.reads(["c.js"], 200));
		const out = c.endTurn(viewOf(items, items, 1000000), []);
		expect(out.notes).toHaveLength(1);
		expect(out.notes[0].kind).toBe("nudge");
		expect(out.notes[0].tasks).toEqual([done[1].id]);
		expect(out.notes[0].text).toContain("context_rewind { from: \"" + done[1].id + "\"");
		const nudged = items.concat([{ id: "n1", role: "note", text: out.notes[0].text, note: { kind: "nudge", level: 0, tasks: out.notes[0].tasks } }]);
		expect(c.endTurn(viewOf(nudged, nudged, 1000000), []).notes).toEqual([]);
		expect(createCompactor({ nudgeTokens: 0 }).endTurn(viewOf(items, items, 1000000), []).notes).toEqual([]);
	});

	test("work after a collapse is a stretch of its own, and a nudged stretch is named again after it grew", () => {
		const c = createCompactor({ nudgeTokens: 2000 });
		const before = f.reads(["a.js", "b.js"], 6000);
		const items = [f.user("go")].concat(before, f.reads(["x.js"], 100));
		const r = c.callTool("context_rewind", { from: before[1].id, to: before[2].id, summary: "read a and b" }, viewOf(items, items, 1000000));
		expect(r.isError).toBe(false);
		const collapsed = history.applyEdits(items, c.endTurn(viewOf(items, items, 1000000), []).edits, items);
		const after = f.reads(["c.js", "d.js"], 6000);
		const later = collapsed.concat(after, f.reads(["y.js"], 100));
		const out = c.endTurn(viewOf(later, items.concat(after), 1000000), []);
		// The first result after the collapse (x.js) starts the new stretch.
		const first = items[items.length - 1].id;
		expect(out.notes[0].tasks).toEqual([first]);
		const noted = later.concat([{ id: "n1", role: "note", text: "", note: { kind: "nudge", tasks: out.notes[0].tasks, sizes: out.notes[0].sizes } }]);
		expect(c.endTurn(viewOf(noted, noted, 1000000), []).notes).toEqual([]);
		const grown = noted.concat(f.reads(["e.js", "f.js"], 6000), f.reads(["z.js"], 100));
		expect(c.endTurn(viewOf(grown, grown, 1000000), []).notes[0].tasks).toEqual([first]);
	});

	test("a todo marked completed names the work since the previous one, once", () => {
		const todo = (status) => {
			const turn = { id: "t" + status + Math.random(), role: "assistant", text: "", calls: [{ id: "call_" + status + Math.random(), name: "todo", args: JSON.stringify({ action: "update", id: 1, status }) }] };
			return [turn, { id: turn.id + "r", role: "toolResult", callId: turn.calls[0].id, toolName: "todo", text: "ok" }];
		};
		const c = createCompactor({ milestones: [{ tool: "todo", args: { status: "completed" } }], milestoneMinTokens: 100, nudgeTokens: 0 });
		const first = f.reads(["a.js", "b.js"], 3000);
		const items = [f.user("build it")].concat(todo("in_progress"), first, todo("completed"));
		const out = c.endTurn(viewOf(items, items, 1000000), []);
		expect(out.notes[0].kind).toBe("milestone");
		expect(out.notes[0].text).toContain("context_rewind { from: \"" + items[2].id + "\", to: \"" + items[items.length - 1].id + "\"");
		const noted = items.concat([{ id: "n1", role: "note", text: "", note: { kind: "milestone", tasks: out.notes[0].tasks } }]);
		expect(c.endTurn(viewOf(noted, noted, 1000000), []).notes).toEqual([]);
		// The next task's work starts after the previous milestone.
		const second = f.reads(["c.js"], 3000);
		const later = noted.concat(todo("in_progress"), second, todo("completed"));
		const next = c.endTurn(viewOf(later, later, 1000000), []);
		expect(next.notes[0].tasks).toEqual([later[noted.length + 1].id]);
		// A task spanning requests: its work since the previous milestone counts, not only since the latest request.
		const across = later.concat(f.reads(["g.js", "h.js"], 3000), [f.reply("done with g and h"), f.user("ok, mark it done")], todo("completed"));
		const spanning = c.endTurn(viewOf(across, across, 1000000), []);
		expect(spanning.notes[0].kind).toBe("milestone");
		expect(spanning.notes[0].tasks).toEqual([across[later.length + 1].id]);
		// An in-progress update is no milestone.
		const busy = items.slice(0, items.length - 2).concat(todo("in_progress"));
		expect(c.endTurn(viewOf(busy, busy, 1000000), []).notes).toEqual([]);
	});

	test("the boundary note fires at boundaryTokens in a big window", () => {
		const t1 = [f.user("summarise the logs")].concat(f.reads(["log1", "log2"], 8000), [f.reply("two errors")]);
		expect(createCompactor({ boundaryTokens: 0 }).startRequest(viewOf(t1, t1, 1000000))).toBeUndefined();
		expect(createCompactor({ boundaryTokens: 3000 }).startRequest(viewOf(t1, t1, 1000000)).kind).toBe("boundary");
	});

	test("by default the boundary note only suggests: nothing is collapsed for the model", () => {
		const c = createCompactor();
		const t1 = [f.user("summarise the logs")].concat(f.reads(["log1", "log2"], 8000), [f.reply("two errors: E1 and E2")]);
		const note = c.startRequest(viewOf(t1, t1, 10000));
		expect(note.text).not.toContain("Left as they are");
		const now = t1.concat([f.user("now fix E1"), { id: "n1", role: "note", text: note.text, note: { kind: "boundary" } }], f.reads(["src.js"], 500));
		expect(c.endTurn(viewOf(now, now, 10000), []).edits).toEqual([]);
	});

	test("no boundary note for small earlier requests", () => {
		const c = createCompactor();
		const t1 = [f.user("lunch anyone?"), f.reply("sure")];
		expect(c.startRequest(viewOf(t1, t1, 100000))).toBeUndefined();
	});
});
