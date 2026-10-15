const suggestions = require("../index.js");
const f = require("../../utils/fixtures");
const config = require("../../config").config;

const cfg = config({ suggestionMinTokens: 0 });
const perChar = 1 / 4;

describe("suggestions", () => {
	beforeEach(() => {
		f.reset();
	});

	test("a finished stretch of reads is suggested from its first result to its last, never the current turn", () => {
		const first = f.reads(["a.js", "b.js"], 4000);
		const second = f.reads(["c.js"], 4000);
		const current = f.reads(["d.js"], 8000);
		const items = [f.user("review the parser")].concat(first, second, current);
		const s = suggestions.suggestions(items, perChar, cfg);
		const collapse = s.find((x) => x.kind === "collapse");
		expect(collapse.from).toBe(first[1].id);
		expect(collapse.to).toBe(second[1].id);
		expect(collapse.names).toBe("read ×3");
		expect(s.some((x) => x.id === current[1].id || x.to === current[1].id)).toBe(false);
	});

	test("a turn whose call has no result breaks the stretch and isn't suggested", () => {
		const items = [f.user("deploy it")].concat(f.reads(["a.js"]), [f.pending()], f.reads(["b.js"]), [f.reply("done")]);
		const s = suggestions.suggestions(items, perChar, cfg);
		expect(s.every((x) => x.kind !== "collapse")).toBe(true);
	});

	test("earlierTasks lists finished requests before the current one, biggest first", () => {
		const t1 = [f.user("lunch anyone?"), f.reply("sure")];
		const t2 = [f.user("summarise the logs")].concat(f.reads(["log1", "log2"], 6000), [f.reply("two errors")]);
		const now = [f.user("now fix the bug")];
		const items = t1.concat(t2, now);
		const tasks = suggestions.earlierTasks(items, perChar, items.length - 1);
		expect(tasks.map((x) => x.from)).toEqual([t2[0].id, t1[0].id]);
		expect(tasks[0].to).toBe(t2[t2.length - 1].id);
		expect(tasks[0].request).toBe("summarise the logs");
	});

	test("a request still waiting on a call isn't done", () => {
		const items = [f.user("run the tests"), f.pending(), f.user("and then?")];
		expect(suggestions.earlierTasks(items, perChar, 2)).toEqual([]);
	});

	test("lines name the tool to call with the ids", () => {
		expect(suggestions.line({ kind: "offload", id: "e9", name: "read", tokens: 5000 }, cfg)).toContain("context_offload { entry: \"e9\", text }");
		expect(suggestions.line({ kind: "collapse", from: "e2", to: "e5", names: "read ×2", tokens: 5000 }, cfg)).toContain("context_rewind { from: \"e2\", to: \"e5\", summary }");
	});
});
