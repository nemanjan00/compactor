const notes = require("../index.js");
const config = require("../../config").config;

describe("notes", () => {
	test("a threshold is noted once, and again only after the context fell well below it", () => {
		const t = [70, 80];
		expect(notes.decide(72, 0, t, 15)).toBe(70);
		expect(notes.decide(75, 70, t, 15)).toBe(0);
		expect(notes.decide(65, 70, t, 15)).toBe(0);
		expect(notes.decide(72, 70, t, 15)).toBe(0);
		expect(notes.decide(81, 70, t, 15)).toBe(80);
		// Fell to 50: 70 is armed again.
		expect(notes.decide(50, 80, t, 15)).toBe(0);
		expect(notes.decide(71, 0, t, 15)).toBe(70);
	});

	test("notedIn takes the highest note since the latest summary", () => {
		const items = [
			{ id: "a", role: "note", text: "", note: { kind: "note", level: 80 } },
			{ id: "b", role: "summary", text: "s" },
			{ id: "c", role: "note", text: "", note: { kind: "note", level: 70 } }
		];
		expect(notes.notedIn(items)).toBe(70);
		expect(notes.notedIn(items.slice(0, 2))).toBe(0);
	});

	test("texts give the size and the calls", () => {
		const cfg = config({ compactAt: 90 });
		const picks = [{ kind: "offload", id: "e9", name: "read", tokens: 5000 }];
		expect(notes.noteText(70000, 100000, picks, cfg)).toContain("[context: about 70k of 100k tokens (70%)]");
		expect(notes.noteText(70000, 100000, picks, cfg)).toContain("At 90% the host compacts automatically.");
		expect(notes.nearText(80000, 100000, picks, cfg)).toContain("context_offload { entry: \"e9\"");
		expect(notes.boundaryText(40000, 100000, [{ kind: "task", from: "e1", to: "e8", request: "summarise the logs", tokens: 30000 }], cfg))
			.toContain("30k of it earlier requests that are done");
	});
});
