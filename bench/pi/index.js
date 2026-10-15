const fs = require("fs");
const path = require("path");
const spawn = require("child_process").spawn;

/**
 * A benchmark of the compactor in pi: one long session of shipment-log tasks, then questions about the earlier ones.
 * Arms: `classic` (pi with its own compaction) and `compactor` (the same, with this extension). Both manage an
 * effective window of `--window` tokens: pi compacts there, and the compactor's notes measure against it.
 *
 *   node bench/pi [--arms classic,compactor] [--repeat 2] [--concurrency 4] [--tasks 5] [--window 64000]
 *                 [--model-window 1048576] [--model kimi-coding/kimi-for-coding] [--out bench/results]
 *
 * Prints a table and writes every run to `<out>/pi-<timestamp>.json`. Billed-equivalent tokens count uncached
 * input and cache writes at 1, cache reads at 0.1 and output at 5.
 */

const DEFAULTS = {
	arms: "classic,compactor",
	repeat: 2,
	concurrency: 4,
	tasks: 5,
	window: 64000,
	modelWindow: 1048576,
	model: "kimi-coding/kimi-for-coding",
	out: path.join(__dirname, "..", "results"),
	timeoutSeconds: 600,
	fileRows: 200
};

const EXTENSION = path.join(__dirname, "..", "..", "src", "adapters", "pi", "index.js");
const DOCKS = ["4", "7", "9", "12", "15", "21"];
const INSPECTORS = ["Ana Kovac", "Bo Lindqvist", "Cara Mendes", "Dev Rao", "Eli Novak", "Fay Osei"];

/** A small seeded random number generator, so every run gets the same files. */
const rng = (seed) => {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
};

const parseArgs = (argv) => {
	const o = Object.assign({}, DEFAULTS);
	argv.forEach((a, i) => {
		if (!a.startsWith("--")) {
			return;
		}
		const key = a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
		const v = argv[i + 1];
		o[key] = typeof DEFAULTS[key] === "number" ? Number(v) : v;
	});
	return o;
};

/**
 * The tasks: each is five logs of one shipment batch, one of which records a held crate (its id, dock and
 * inspector); the rest are cleared.
 */
const buildTasks = (n, rows) => {
	const rand = rng(7);
	return Array.from({ length: n }, (_x, k) => {
		const held = Math.floor(rand() * 5);
		const fact = {
			crate: "C-" + (k + 1) + String(100 + Math.floor(rand() * 900)),
			dock: DOCKS[Math.floor(rand() * DOCKS.length)],
			inspector: INSPECTORS[(k + Math.floor(rand() * 3)) % INSPECTORS.length],
			file: "shipments/b" + k + "-f" + held + ".log"
		};
		const files = Array.from({ length: 5 }, (_y, j) => {
			const lines = Array.from({ length: rows }, (_z, r) => {
				return "08:" + String(r % 60).padStart(2, "0") + " batch " + k + " log " + j + " pallet P" + (r * 7 + j) + " scanned, weight " + (200 + ((r * 37 + k) % 500)) + " kg, status cleared";
			});
			if (j === held) {
				lines.splice(Math.floor(rows * 0.6), 0, "09:14 HOLD crate " + fact.crate + " held at dock " + fact.dock + " for customs review, signed by inspector " + fact.inspector);
			}
			return { name: "shipments/b" + k + "-f" + j + ".log", text: lines.join("\n") + "\n" };
		});
		return { k, files, fact };
	});
};

const taskPrompt = (t) => {
	const names = t.files.map((f) => f.name).join(", ");
	return "Read the five logs of shipment batch " + t.k + " (" + names + ") with the read tool, one file per call, the whole of each file. " +
		"Then tell me which crate was held, at which dock, and which inspector signed it.";
};

/** Whether an answer names dock `n`: "dock 12", "bay 12", "dock number 12", "Dock **12**". */
const namesDock = (answer, n) => new RegExp("\\b(dock|bay)\\b[^.\\n]{0,24}?\\b" + n + "\\b", "i").test(answer.replace(/\*/g, ""));

/** Questions about earlier batches, after all tasks: one in the logs' own words, one in other words. */
const followUps = (tasks) => {
	const first = tasks[0].fact;
	const second = tasks[Math.min(1, tasks.length - 1)].fact;
	return [
		{
			kind: "by words",
			prompt: "Back to shipment batch 0: which crate was held, and which inspector signed the hold? Answer from what you found then.",
			check: (a) => a.includes(first.crate) && a.includes(first.inspector.split(" ")[1])
		},
		{
			kind: "other words",
			prompt: "In the second batch you looked at, a container got stopped for the customs people. At which loading bay was it stopped?",
			check: (a) => namesDock(a, second.dock)
		}
	];
};

const writeWorkdir = (dir, tasks, o, arm) => {
	fs.mkdirSync(path.join(dir, "work", "shipments"), { recursive: true });
	fs.mkdirSync(path.join(dir, "work", ".pi"), { recursive: true });
	fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
	tasks.forEach((t) => {
		t.files.forEach((f) => {
			fs.writeFileSync(path.join(dir, "work", f.name), f.text);
		});
	});
	// Pi compacts when the context passes the model's window less the reserve: put that at `window`.
	const settings = { compaction: { modelOverrides: {} } };
	settings.compaction.modelOverrides[o.model] = { reserveTokens: o.modelWindow - o.window };
	fs.writeFileSync(path.join(dir, "work", ".pi", "settings.json"), JSON.stringify(settings, null, 2));
	return { dir, arm };
};

/** One pi call in the run's session (`-c` after the first). Resolves with its output. */
const piCall = (run, prompt, first, o) => {
	const args = ["--approve", "--no-extensions", "--no-skills", "--no-mcp", "--no-context-files", "--no-prompt-templates",
		"--session-dir", path.join(run.dir, "sessions"), "--model", o.model, "-p", prompt];
	if (!first) {
		args.unshift("-c");
	}
	if (run.arm === "compactor") {
		args.unshift("-e", EXTENSION);
	}
	const env = Object.assign({}, process.env, {
		COMPACTOR_OPTIONS: JSON.stringify({ contextWindow: o.window, compactAt: 100 })
	});
	return new Promise((resolve) => {
		const child = spawn("pi", args, { cwd: path.join(run.dir, "work"), env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), o.timeoutSeconds * 1000);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", () => {});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out: out.trim() });
		});
	});
};

const sessionEntries = (run) => {
	const dir = path.join(run.dir, "sessions");
	const file = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))[0];
	if (!file) {
		return [];
	}
	return fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

const emptyUsage = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 });

const addUsage = (sum, u) => {
	if (!u) {
		return sum;
	}
	return {
		input: sum.input + (u.input || 0),
		cacheRead: sum.cacheRead + (u.cacheRead || 0),
		cacheWrite: sum.cacheWrite + (u.cacheWrite || 0),
		output: sum.output + (u.output || 0),
		calls: sum.calls + 1
	};
};

const billed = (u) => u.input + u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output;

/**
 * Usage and counts per phase of a session: a phase is everything from one user message to the next, in the order
 * the prompts were sent.
 */
const phases = (entries) => {
	return entries.reduce((out, e) => {
		if (e.type === "message" && e.message.role === "user") {
			out.push({ usage: emptyUsage(), reads: 0, compactions: 0, edits: 0, notes: 0, tools: {}, maxContext: 0 });
			return out;
		}
		const p = out[out.length - 1];
		if (!p) {
			return out;
		}
		if (e.type === "message" && e.message.role === "assistant") {
			const u = e.message.usage;
			p.usage = addUsage(p.usage, u);
			if (u) {
				p.maxContext = Math.max(p.maxContext, (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0));
			}
			(e.message.content || []).filter((b) => b.type === "toolCall").forEach((b) => {
				p.tools[b.name] = (p.tools[b.name] || 0) + 1;
				if (b.name === "read") {
					p.reads += 1;
				}
			});
		} else if (e.type === "compaction") {
			p.compactions += 1;
			p.usage = addUsage(p.usage, e.usage);
		} else if (e.type === "context_edit") {
			p.edits += 1;
		} else if (e.type === "custom_message" && e.customType === "compactor") {
			p.notes += 1;
		}
		return out;
	}, []);
};

const runArm = (arm, i, tasks, o, stamp) => {
	const dir = path.join(o.out, "pi-" + stamp, arm + "-" + i);
	const run = writeWorkdir(dir, tasks, o, arm);
	const prompts = tasks.map((t) => ({ kind: "task", prompt: taskPrompt(t), check: (a) => a.includes(t.fact.crate) && namesDock(a, t.fact.dock) }))
		.concat(followUps(tasks));
	const started = Date.now();
	return prompts.reduce((chain, p, k) => {
		return chain.then((answers) => {
			return piCall(run, p.prompt, k === 0, o).then((r) => answers.concat([{ kind: p.kind, prompt: p.prompt, answer: r.out, code: r.code, right: p.check(r.out) }]));
		});
	}, Promise.resolve([])).then((answers) => {
		const ps = phases(sessionEntries(run));
		const result = {
			arm,
			i,
			seconds: Math.round((Date.now() - started) / 1000),
			answers,
			phases: ps.map((p, k) => Object.assign({ kind: answers[k] ? answers[k].kind : "?", billed: Math.round(billed(p.usage)) }, p))
		};
		process.stderr.write("  " + arm + " #" + i + ": " + answers.filter((a) => a.right).length + "/" + answers.length + " right, " +
			Math.round(result.phases.reduce((n, p) => n + p.billed, 0) / 1000) + "k billed-equivalent, " + result.seconds + " s\n");
		return result;
	});
};

/** Runs `jobs` (functions returning promises) with at most `n` at a time. */
const limited = (jobs, n) => {
	const results = [];
	let next = 0;
	const worker = () => {
		if (next >= jobs.length) {
			return Promise.resolve();
		}
		const k = next;
		next += 1;
		return jobs[k]().then((r) => {
			results[k] = r;
			return worker();
		});
	};
	return Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker)).then(() => results);
};

const median = (xs) => {
	const s = xs.slice().sort((a, b) => a - b);
	return s[Math.floor((s.length - 1) / 2)];
};

const k = (n) => Math.round(n / 1000) + "k";

/** One row per arm: medians over its runs (ranges in brackets). */
const table = (results, arms) => {
	const rows = arms.map((arm) => {
		const rs = results.filter((r) => r.arm === arm);
		const sum = (r, kinds) => r.phases.filter((p) => kinds.includes(p.kind)).reduce((n, p) => n + p.billed, 0);
		const total = rs.map((r) => sum(r, ["task", "by words", "other words"]));
		const tasks = rs.map((r) => sum(r, ["task"]));
		const fu = rs.map((r) => sum(r, ["by words", "other words"]));
		const right = (kinds) => rs.reduce((n, r) => n + r.answers.filter((a) => kinds.includes(a.kind) && a.right).length, 0) + "/" +
			rs.reduce((n, r) => n + r.answers.filter((a) => kinds.includes(a.kind)).length, 0);
		const count = (field, kinds) => median(rs.map((r) => r.phases.filter((p) => kinds.includes(p.kind)).reduce((n, p) => n + p[field], 0)));
		const range = (xs) => k(median(xs)) + " (" + k(Math.min.apply(null, xs)) + "–" + k(Math.max.apply(null, xs)) + ")";
		const cache = rs.reduce((n, r) => n + r.phases.reduce((m, p) => m + p.usage.cacheRead, 0), 0) /
			Math.max(1, rs.reduce((n, r) => n + r.phases.reduce((m, p) => m + p.usage.cacheRead + p.usage.input + p.usage.cacheWrite, 0), 0));
		return "| " + arm + " | " + range(total) + " | " + range(tasks) + " | " + right(["task"]) + " | " + range(fu) + " | " + right(["by words", "other words"]) +
			" | " + count("reads", ["by words", "other words"]) + " | " + count("compactions", ["task", "by words", "other words"]) + " | " +
			count("edits", ["task", "by words", "other words"]) + " | " + Math.round(cache * 100) + "% | " +
			k(median(rs.map((r) => Math.max.apply(null, r.phases.map((p) => p.maxContext))))) + " |";
	});
	return ["| arm | billed-equivalent | tasks | tasks right | follow-ups | follow-ups right | follow-up re-reads | compactions | context edits | cached | peak context |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"].concat(rows).join("\n");
};

const main = () => {
	const o = parseArgs(process.argv.slice(2));
	const arms = o.arms.split(",").map((a) => a.trim());
	const tasks = buildTasks(o.tasks, o.fileRows);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	process.stderr.write("bench:pi " + o.model + ", window " + o.window + ", " + o.tasks + " tasks, arms " + arms.join(", ") + ", repeat " + o.repeat + "\n");
	const jobs = [];
	arms.forEach((arm) => {
		Array.from({ length: o.repeat }, (_x, i) => {
			jobs.push(() => runArm(arm, i + 1, tasks, o, stamp));
		});
	});
	return limited(jobs, o.concurrency).then((results) => {
		const file = path.join(o.out, "pi-" + stamp + ".json");
		fs.writeFileSync(file, JSON.stringify({ options: o, facts: tasks.map((t) => t.fact), results }, null, 2) + "\n");
		process.stdout.write(table(results, arms) + "\n");
		process.stderr.write("report: " + file + "\n");
	});
};

if (require.main === module) {
	main().catch((err) => {
		process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
		process.exit(1);
	});
}

module.exports = {
	namesDock,
	buildTasks,
	followUps,
	phases,
	billed,
	table
};
