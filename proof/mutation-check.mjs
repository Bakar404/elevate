// The mutation check: plant one bug per requirement in a scratch copy of
// verified/src/lib.rs and require Verus to reject it on that requirement's
// clause. A mutant that proves means its clause rules out nothing.
// Then show the gap a draft spec leaves: the guard's safety clauses (W1-W6)
// alone allow a guard that refuses everything; W7 closes it.
//
//   node proof/mutation-check.mjs [--json proof/results/mutation.json]
//
// VERUS overrides the verus binary (default %TEMP%\verus\verus-arm64-win).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "verified", "src", "lib.rs"), "utf8").replace(/\r\n/g, "\n");
const verus = process.env.VERUS ?? join(process.env.TEMP ?? tmpdir(), "verus", "verus-arm64-win", "verus.exe");
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

/** Each edit: find (exactly once, or the nth / all occurrences) → replace. */
export const MUTANTS = [
	{ id: "ML1", target: "L1", bug: "the prior outweighs the reviewer", edits: [{ find: "let score = (2 * prior + 3 * review) / 5;", replace: "let score = (3 * prior + 2 * review) / 5;" }] },
	{ id: "ML2", target: "L2", bug: "the score can exceed 100 (spec and code agree)", edits: [{ find: "(2 * prior + 3 * review) / 5", replace: "(2 * prior + 3 * review) / 4", all: true }] },
	{ id: "ML3", target: "L3", bug: "more evidence lowers the score (spec and code agree)", edits: [{ find: "(2 * prior + 3 * review) / 5", replace: "(2 * (100 - prior) + 3 * review) / 5", all: true }] },
	{ id: "ML4", target: "L4", bug: "the reviewer's veto is ignored", edits: [{ find: "let passed = legit && prior >= prior_floor && score >= threshold;", replace: "let passed = prior >= prior_floor && score >= threshold;" }] },
	{ id: "ML5", target: "L5", bug: "the model alone can pass a technique", edits: [{ find: "let passed = legit && prior >= prior_floor && score >= threshold;", replace: "let passed = legit && score >= threshold;" }] },
	{ id: "ML6", target: "L6", bug: "a score exactly at the threshold fails", edits: [{ find: "score >= threshold;", replace: "score > threshold;" }] },
	{ id: "MS1", target: "S1", bug: "Gate 2 ignores Gate 1", edits: [{ find: "gate1_passed && sound && measurable && score >= required", replace: "sound && measurable && score >= required" }] },
	{ id: "MS2", target: "S2", bug: "the reviewer's 'unsound' is ignored", edits: [{ find: "gate1_passed && sound && measurable && score >= required", replace: "gate1_passed && measurable && score >= required" }] },
	{ id: "MS3", target: "S3", bug: "an unmeasurable change can pass", edits: [{ find: "gate1_passed && sound && measurable && score >= required", replace: "gate1_passed && sound && score >= required" }] },
	{ id: "MS4", target: "S4", bug: "high risk gets no margin (spec and code agree)", edits: [{ find: "Risk::High => 15,", replace: "Risk::High => 0,", all: true }] },
	{ id: "MS5", target: "S5", bug: "a score exactly at the bar fails", edits: [{ find: "score >= required", replace: "score > required" }] },
	{ id: "MS6", target: "S6", bug: "the rank under-weights soundness", edits: [{ find: "40 * soundness) / 100", replace: "30 * soundness) / 100", nth: 2 }] },
	{ id: "MS6m", target: "S6", bug: "a sounder change ranks lower (spec and code agree)", edits: [{ find: "40 * soundness) / 100", replace: "40 * (100 - soundness)) / 100", all: true }] },
	{ id: "MT1", target: "T1", bug: "a candidate can be approved before the gates", edits: [{ find: "Event::GateFail => Some(Status::GatedOut),", replace: "Event::GateFail => Some(Status::GatedOut),\n            Event::Approve => Some(Status::Approved)," }] },
	{ id: "MT2", target: "T2", bug: "a swarm starts from open, without approval", edits: [{ find: "Event::Approve => Some(Status::Approved),", replace: "Event::Approve => Some(Status::Approved),\n            Event::Start => Some(Status::InProgress)," }] },
	{ id: "MT3", target: "T3", bug: "a rejected recommendation reopens straight into the inbox", edits: [{ find: "Event::Reopen => Some(Status::Candidate),", replace: "Event::Reopen => Some(Status::Open)," }] },
	{ id: "MT4", target: "T4", bug: "a gated-out recommendation can be rejected and reopened around the gates", edits: [{ find: "Event::Regate => Some(Status::Candidate),", replace: "Event::Regate => Some(Status::Rejected),", nth: 1 }] },
	{ id: "MT5", target: "T5", bug: "an opened PR can be rejected and reopened", edits: [{ find: "Status::PrOpened => None,", replace: "Status::PrOpened => match e {\n            Event::Retry => Some(Status::Rejected),\n            _ => None,\n        }," }] },
	{ id: "MT6", target: "T6", bug: "a rejected recommendation can't be reopened", edits: [{ find: "Event::Reopen => Some(Status::Candidate),", replace: "Event::Reopen => None," }] },
	{ id: "MT7", target: "T7", bug: "replay starts past the gates", edits: [{ find: "let mut cur = Status::Candidate;", replace: "let mut cur = Status::Open;" }] },
	{ id: "MW1", target: "W1", bug: "force-push is not forbidden", edits: [{ find: "Action::MergePr | Action::PushDefaultBranch | Action::ForcePush => {", replace: "Action::MergePr | Action::PushDefaultBranch => {" }] },
	{ id: "MW2", target: "W2", bug: "an open (unapproved) recommendation may write", edits: [{ find: "Status::Approved | Status::InProgress => {},", replace: "Status::Approved | Status::InProgress | Status::Open => {}," }] },
	{ id: "MW3", target: "W3", bug: "the allow-list is skipped", edits: [{ find: "if !q.allow_swarm {", replace: "if false && !q.allow_swarm {" }] },
	{ id: "MW4", target: "W4", bug: "a swarm may write to another repo", edits: [{ find: "if !q.same_repo {", replace: "if false && !q.same_repo {" }] },
	{ id: "MW5", target: "W5", bug: "a ready-for-review PR may be opened", edits: [{ find: "if !q.draft {", replace: "if false {" }] },
	{ id: "MW6", target: "W6", bug: "the agent-turn budget is not enforced", edits: [{ find: "q.tasks_used >= q.max_tasks || q.minutes_used >= q.max_minutes || q.turns_used >= q.max_turns", replace: "q.tasks_used >= q.max_tasks || q.minutes_used >= q.max_minutes" }] },
	{ id: "MW7", target: "W7", bug: "draft work is refused everywhere (over-strict)", edits: [{ find: "if !q.same_repo {", replace: "if !q.same_repo || q.draft {" }] },
];

export function applyEdits(text, edits, label) {
	for (const e of edits) {
		const count = text.split(e.find).length - 1;
		if (e.all) {
			if (count < 1) throw new Error(`${label}: not found: ${JSON.stringify(e.find)}`);
			text = text.split(e.find).join(e.replace);
		} else if (e.nth) {
			if (count < e.nth) throw new Error(`${label}: occurrence ${e.nth} not found: ${JSON.stringify(e.find)}`);
			let at = -1;
			for (let i = 0; i < e.nth; i++) at = text.indexOf(e.find, at + 1);
			text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
		} else {
			if (count !== 1) throw new Error(`${label}: must occur exactly once (found ${count}): ${JSON.stringify(e.find)}`);
			text = text.replace(e.find, e.replace);
		}
	}
	return text;
}

function dropClause(text, tag) {
	const lines = text.split("\n");
	const kept = lines.filter((line) => !line.trimEnd().endsWith(`// ${tag}`));
	if (kept.length !== lines.length - 1) throw new Error(`expected exactly one clause tagged ${tag}`);
	return kept.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const scratch = mkdtempSync(join(tmpdir(), "elevate-pdd-mut-"));
	const prove = (text, name) => {
		const dir = join(scratch, name);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "lib.rs");
		writeFileSync(file, text);
		const run = spawnSync(verus, [file, "--crate-type=lib", "--edition=2021", "--multiple-errors", "20"], {
			encoding: "utf8",
			env: { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.99.1-aarch64-pc-windows-msvc" },
		});
		if (run.error) throw run.error;
		const output = `${run.stdout}\n${run.stderr}`;
		const lines = text.split("\n");
		const caughtBy = [
			...new Set(
				[...output.matchAll(/-->\s+.*lib\.rs:(\d+):\d+/g)]
					.map((m) => lines[Number(m[1]) - 1]?.match(/\/\/ ([LSTW]\d+)\s*$/)?.[1])
					.filter(Boolean),
			),
		].sort();
		const summary = output.match(/verification results:: \d+ verified, \d+ errors/)?.[0] ?? "no verification summary";
		return { proved: run.status === 0, caughtBy, summary, output };
	};

	const results = { verus, baseline: null, mutants: [], draftGap: null };
	let failures = 0;
	try {
		const baseline = prove(source, "baseline");
		results.baseline = { proved: baseline.proved, summary: baseline.summary };
		console.log(`baseline  ${baseline.proved ? "proved" : "FAILED"}  (${baseline.summary})`);
		if (!baseline.proved) {
			console.log(baseline.output);
			failures++;
		}
		for (const m of MUTANTS) {
			const r = prove(applyEdits(source, m.edits, m.id), m.id);
			const ok = !r.proved && r.caughtBy.includes(m.target);
			if (!ok) failures++;
			results.mutants.push({ id: m.id, target: m.target, bug: m.bug, rejected: !r.proved, caughtBy: r.caughtBy, ok });
			console.log(`${m.id.padEnd(5)} -> ${m.target}  ${ok ? "rejected" : "NOT CAUGHT"}  by ${r.caughtBy.join(", ") || "nothing"}  (${m.bug})`);
			if (!ok) console.log(r.output.slice(0, 4000));
		}
		// The gap: W1-W6 are all "never allow when ..." clauses. Without W7, a
		// guard that refuses every write proves, so W7 is what keeps it usable.
		const draft = dropClause(source, "W7");
		const mw7 = MUTANTS.find((m) => m.id === "MW7");
		const draftToday = prove(draft, "draft-today");
		const draftMW7 = prove(applyEdits(draft, mw7.edits, "draft MW7"), "draft-MW7");
		const gapShown = draftToday.proved && draftMW7.proved;
		if (!gapShown) failures++;
		results.draftGap = { withoutW7: { todayProves: draftToday.proved, mw7Proves: draftMW7.proved }, gapShown };
		console.log(`draft without W7: today's code ${draftToday.proved ? "proves" : "fails"}, MW7 ${draftMW7.proved ? "also proves (the gap)" : "fails"}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	if (jsonOut) {
		const out = resolve(process.cwd(), jsonOut);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(results, null, "\t")}\n`);
	}
	console.log(failures === 0 ? "mutation check: PASS" : `mutation check: ${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}
