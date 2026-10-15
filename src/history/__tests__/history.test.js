const history = require("../index.js");
const f = require("../../utils/fixtures");
const config = require("../../config").config;

describe("history", () => {
	beforeEach(() => {
		f.reset();
	});

	test("findRef resolves an item id, a call id and the id of the call a result answers", () => {
		const items = [f.user("fix the parser")].concat(f.reads(["a.js", "b.js"]));
		const call = items[1].calls[1];
		expect(history.findRef(items, items[2].id)).toBe(2);
		expect(history.findRef(items, call.id)).toBe(3);
		expect(history.findRef(items, "nope")).toBe(-1);
	});

	test("tokensPerChar uses the measured size, else the default", () => {
		const items = [f.user("x".repeat(80))];
		const chars = history.itemChars(items[0]);
		expect(history.tokensPerChar(items, { tokens: chars / 2, window: 1000 }, config())).toBeCloseTo(0.5);
		expect(history.tokensPerChar(items, undefined, config())).toBeCloseTo(1 / 3.5);
		// A system prompt as long as the messages halves the ratio.
		expect(history.tokensPerChar(items, { tokens: chars / 2, window: 1000, baseChars: chars }, config())).toBeCloseTo(0.25);
	});

	test("applyEdits drops, replaces, keeps calls and restores, the last edit of a target winning", () => {
		const items = [f.user("fix the parser")].concat(f.reads(["a.js", "b.js"]));
		const all = items.slice();
		const view = history.applyEdits(items, [
			{ target: items[1].id, calls: [items[1].calls[0].id] },
			{ target: items[2].id, text: "summary" },
			{ target: items[3].id, drop: true },
			{ target: items[0].id, text: "changed" },
			{ target: items[0].id, restore: true }
		], all);
		expect(view.map((i) => i.id)).toEqual([items[0].id, items[1].id, items[2].id]);
		expect(view[0].text).toBe("fix the parser");
		expect(view[1].calls.map((c) => c.id)).toEqual([items[1].calls[0].id]);
		expect(view[2].text).toBe("summary");
	});
});
