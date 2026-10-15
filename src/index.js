/**
 * @nemanjan00/compactor: context management for coding agents, harness-neutral. `createCompactor` is the entry
 * point; the modules are exported for adapters that need their parts. Harness adapters live in `src/adapters`.
 */
module.exports = {
	createCompactor: require("./compactor").createCompactor,
	config: require("./config"),
	history: require("./history"),
	suggestions: require("./suggestions"),
	notes: require("./notes"),
	collapse: require("./collapse"),
	offload: require("./offload"),
	restore: require("./restore"),
	search: require("./search"),
	compaction: require("./compaction"),
	tools: require("./tools")
};
