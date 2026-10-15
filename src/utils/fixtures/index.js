/**
 * Builders for history items in tests: a made-up session where someone asks for work and the model reads files.
 */
let seq = 0;

const nextId = () => {
	seq += 1;
	return "e" + String(seq).padStart(3, "0");
};

const user = (text) => ({ id: nextId(), role: "user", text });

const reply = (text) => ({ id: nextId(), role: "assistant", text, calls: [] });

/** An assistant turn calling `read` on each path, and a result for each (`size` characters). */
const reads = (paths, size) => {
	const calls = paths.map((p) => ({ id: "call_" + nextId(), name: "read", args: JSON.stringify({ path: p }) }));
	const turn = { id: nextId(), role: "assistant", text: "", calls };
	const results = calls.map((c, i) => ({
		id: nextId(),
		role: "toolResult",
		callId: c.id,
		toolName: "read",
		isError: false,
		text: ("contents of " + paths[i] + " ").repeat(Math.ceil((size || 400) / 20)).slice(0, size || 400)
	}));
	return [turn].concat(results);
};

/** An assistant turn with one call that has no result yet. */
const pending = (name) => {
	return { id: nextId(), role: "assistant", text: "", calls: [{ id: "call_" + nextId(), name: name || "bash", args: "{}" }] };
};

const reset = () => {
	seq = 0;
};

module.exports = {
	user,
	reply,
	reads,
	pending,
	reset
};
