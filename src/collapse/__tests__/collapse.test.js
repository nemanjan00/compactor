const collapse = require("../index.js");
const history = require("../../history");
const suggestions = require("../../suggestions");
const f = require("../../utils/fixtures");
const config = require("../../config").config;

const cfg = config();
const perChar = 1 / 4;

/** Valid as a model exchange: every call has its result right after its turn, and no result without its call. */
const valid = (items) => {
	const calls = new Set();
	return items.every((i) => {
		history.callsOf(i).forEach((c) => calls.add(c.id));
		return i.role !== "toolResult" || calls.has(i.callId);
	}) && items.filter((i) => i.role === "toolResult").length === calls.size;
};

describe("collapse", () => {
	beforeEach(() => {
		f.reset();
	});

	test("a stretch of reads collapses into the first call's result, the index naming every result", () => {
		const first = f.reads(["a.js", "b.js"], 3000);
		const second = f.reads(["c.js"], 3000);
		const items = [f.user("review the parser")].concat(first, second, [f.reply("found it")]);
		const r = collapse.rewind(items, { from: first[1].id, to: second[1].id, summary: "a.js:12 parses dates\nKeywords: parser, dates" }, perChar, cfg);
		expect(r.error).toBeUndefined();
		const view = history.applyEdits(items, r.edits, items);
		expect(view.map((i) => i.id)).toEqual([items[0].id, first[0].id, first[1].id, items[items.length - 1].id]);
		expect(valid(view)).toBe(true);
		const summary = view[2].text;
		expect(summary).toMatch(/^\[collapsed with context_rewind: 5 entries/);
		expect(summary).toContain("a.js:12 parses dates");
		[first[1], first[2], second[1]].forEach((res) => {
			expect(summary).toContain("→ entry " + res.id);
		});
	});

	test("a call id works for from and to, and to defaults to from's turn", () => {
		const turn = f.reads(["a.js", "b.js"]);
		const items = [f.user("go")].concat(turn, [f.reply("ok")]);
		const r = collapse.rewind(items, { from: turn[0].calls[0].id, summary: "read two files" }, perChar, cfg);
		expect(r.edits.filter((e) => e.drop).map((e) => e.target)).toEqual([turn[2].id]);
	});

	test("refuses the current turn, unknown ids, a reply as from, and an empty summary", () => {
		const done = f.reads(["a.js"]);
		const now = f.pending("context_rewind");
		const items = [f.user("go")].concat(done, [now]);
		expect(collapse.rewind(items, { from: done[1].id, to: now.calls[0].id, summary: "x" }, perChar, cfg).error).toMatch(/without its result/);
		expect(collapse.rewind(items, { from: "nope", summary: "x" }, perChar, cfg).error).toMatch(/not an entry/);
		expect(collapse.rewind(items, { from: done[1].id, summary: " " }, perChar, cfg).error).toMatch(/summary is required/);
		const withReply = [f.user("go"), f.reply("hi")].concat(f.reads(["b.js"]));
		expect(collapse.rewind(withReply, { from: withReply[1].id, summary: "x" }, perChar, cfg).error).toMatch(/not a reply/);
	});

	test("a collapse of collapses lists the earlier summary in its index", () => {
		const a = f.reads(["a.js", "b.js"]);
		const b = f.reads(["c.js"]);
		const items = [f.user("go")].concat(a, b, [f.reply("ok")]);
		const r1 = collapse.rewind(items, { from: a[1].id, to: a[2].id, summary: "first part" }, perChar, cfg);
		const view = history.applyEdits(items, r1.edits, items);
		const r2 = collapse.rewind(view, { from: a[1].id, to: b[1].id, summary: "both parts" }, perChar, cfg);
		const after = history.applyEdits(view, r2.edits, items);
		const text = after.find((i) => i.id === a[1].id).text;
		expect(text).toContain("- an earlier summary → entry " + a[1].id);
		expect(text).toContain("first part");
	});

	test("the boundary collapse keeps each named request and its final reply, indexes the rest", () => {
		const t1 = [f.user("summarise the logs")].concat(f.reads(["log1", "log2"], 5000), [f.reply("two errors: E1 and E2")]);
		const t2 = [f.user("lunch anyone?"), f.reply("sure")];
		const now = [f.user("now fix E1")];
		const items = t1.concat(t2, now);
		const tasks = suggestions.earlierTasks(items, perChar, items.length - 1);
		const c = collapse.boundaryCollapse(items, tasks, [t1[0].id], perChar, cfg);
		const view = history.applyEdits(items, c.edits, items);
		expect(view.map((i) => i.id)).toEqual([t1[0].id, t1[t1.length - 1].id].concat(t2.map((i) => i.id), now.map((i) => i.id)));
		expect(view[0].text).toMatch(/^\[collapsed: an earlier request that is done/);
		expect(view[0].text).toContain("[the request:]\nsummarise the logs");
		expect(view[0].text).toContain("→ entry " + t1[2].id);
		expect(c.requests).toBe(1);
		expect(collapse.boundaryCollapse(items, tasks, ["gone"], perChar, cfg)).toBeUndefined();
	});
});
