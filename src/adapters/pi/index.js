const Type = require("typebox").Type;
const createCompactor = require("../../compactor").createCompactor;
const session = require("./session");

/**
 * The compactor as a pi extension (https://pi.dev). Pi keeps its own compaction; this adds, on top of it:
 * - the model's tools to collapse finished work, offload results, read originals back and search the session tree
 * - each tool result labelled with its entry id, so the model can name it
 * - tool results over the size limit replaced by their head and tail
 * - notes about the context size, with the biggest finished parts to free, and a note at a new request when
 *   finished earlier requests fill the context, collapsing them after the model's next turn if it leaves them
 * Changes are pi `context_edit` entries: the session keeps every original.
 */

/** A core parameter map as a TypeBox object schema. */
const schema = (params) => {
	const props = Object.keys(params).reduce((out, key) => {
		const p = params[key];
		const base = p.type === "number" ? Type.Number({ description: p.description }) : Type.String({ description: p.description });
		out[key] = p.required ? base : Type.Optional(base);
		return out;
	}, {});
	return Type.Object(props);
};

/** Overrides of the defaults from the `COMPACTOR_OPTIONS` environment variable (JSON), e.g. `{"noteAt": 60}`. */
const envOptions = () => {
	const raw = process.env.COMPACTOR_OPTIONS;
	if (!raw) {
		return {};
	}
	return JSON.parse(raw);
};

/**
 * @param {object} pi pi's ExtensionAPI
 * @param {object} [options] overrides of the compactor's defaults (default: `COMPACTOR_OPTIONS`)
 */
const extension = (pi, options) => {
	const compactor = createCompactor(options || envOptions());

	compactor.tools.forEach((spec) => {
		pi.registerTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: schema(spec.params),
			executionMode: "sequential",
			execute: (_toolCallId, params, _signal, _onUpdate, ctx) => {
				return Promise.resolve().then(() => {
					const r = compactor.callTool(spec.name, params, session.view(ctx));
					if (r.isError) {
						throw new Error(r.text);
					}
					return { content: [{ type: "text", text: r.text }], details: undefined };
				});
			}
		});
	});

	pi.on("session_start", () => {
		compactor.reset();
	});

	// Label tool results with their entry ids, the same way before every call, so the cached prefix stays valid.
	pi.on("context", (event, ctx) => {
		return { messages: session.labelResults(event.messages, session.resultIds(ctx.sessionManager.getBranch())) };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "user") {
			return undefined;
		}
		const note = compactor.startRequest(session.view(ctx));
		if (!note) {
			return undefined;
		}
		return { message: session.noteMessage(note) };
	});

	pi.on("turn_end", (event, ctx) => {
		const projected = event.context && event.context.contextEntries;
		const out = compactor.endTurn(session.view(ctx, projected), event.toolResultEntryIds || []);
		const entries = out.edits.map((e) => session.editDraft(e, ctx.sessionManager))
			.concat(out.notes.map((n) => Object.assign({ type: "custom_message" }, session.noteMessage(n))));
		if (!entries.length) {
			return undefined;
		}
		return { entries };
	});

	return compactor;
};

module.exports = extension;
