const offload = require("../index.js");
const restore = require("../../restore");
const search = require("../../search");
const history = require("../../history");
const f = require("../../utils/fixtures");
const config = require("../../config").config;

const cfg = config({ resultMaxChars: 1000, pointerHead: 100, pointerTail: 50 });
const perChar = 1 / 4;

describe("offload, restore and search", () => {
	beforeEach(() => {
		f.reset();
	});

	test("a result over the limit becomes its head and tail, and restore reads the rest in pieces", () => {
		const items = [f.user("read the log")].concat(f.reads(["big.log"], 5000), f.reads(["small.log"], 200));
		const edits = offload.oversized(items.slice(1), cfg);
		expect(edits.map((e) => e.target)).toEqual([items[2].id]);
		expect(edits[0].text).toMatch(/^\[offloaded: read returned 5,000 characters/);
		expect(edits[0].text).toContain("[… 4,850 characters left out …]");
		const view = history.applyEdits(items, edits, items);
		const piece = restore.restore(view, items, { entry: items[2].id, offset: 4900, length: 500 }, cfg);
		expect(piece.text.split("\n")[0]).toBe("[entry " + items[2].id + ", characters 4900–5000 of 5,000]");
	});

	test("results with images stay whole", () => {
		const items = f.reads(["shot.png"], 5000);
		items[1].images = 1;
		expect(offload.oversized(items, cfg)).toEqual([]);
	});

	test("the model offloads a result by its call id, and restore puts it back", () => {
		const items = [f.user("go")].concat(f.reads(["a.js"], 3000), [f.reply("ok")]);
		const r = offload.offload(items, { entry: items[1].calls[0].id, text: "a.js, the parser" }, perChar, cfg);
		expect(r.edits[0].target).toBe(items[2].id);
		const view = history.applyEdits(items, r.edits, items);
		expect(view[2].text).toMatch(/^\[offloaded: a.js, the parser\. The original \(≈\d/);
		expect(offload.offload(view, { entry: items[2].id, text: "again" }, perChar, cfg).error).toMatch(/offloaded already/);
		const back = restore.restore(view, items, { entry: items[2].id }, cfg);
		expect(history.applyEdits(view, back.edits, items)[2].text).toBe(items[2].text);
	});

	test("restore won't reopen a collapsed part whole, but reads a piece of it", () => {
		const items = [f.user("go")].concat(f.reads(["a.js"], 3000));
		const view = history.applyEdits(items, [{ target: items[2].id, drop: true }], items);
		expect(restore.restore(view, items, { entry: items[2].id }, cfg).error).toMatch(/isn't offloaded/);
		expect(restore.restore(view, items, { entry: items[2].id, offset: 0, length: 10 }, cfg).text).toContain("contents o");
	});

	test("search finds all the words newest first, else the items with the most of them", () => {
		const items = [
			{ id: "m1", role: "user", text: "The invoice from the vendor went up" },
			{ id: "m2", role: "toolResult", toolName: "read", callId: "c1", text: "spend report: invoice total 420" },
			{ id: "m3", role: "note", text: "invoice note" }
		];
		const all = search.search(items, { text: "invoice" }, cfg).text;
		expect(all.indexOf("entry m2")).toBeLessThan(all.indexOf("entry m1"));
		expect(all).not.toContain("m3");
		expect(all).toContain("read: context_restore { entry: \"m2\", offset: 0, length: 2000 }");
		const some = search.search(items, { text: "invoice spend bill" }, cfg).text;
		expect(some).toMatch(/^No entry has all of invoice, spend, bill/);
		expect(some.indexOf("entry m2")).toBeLessThan(some.indexOf("entry m1"));
		expect(search.search(items, { text: "nothing here" }, cfg).text).toMatch(/^Nothing matches/);
	});
});
