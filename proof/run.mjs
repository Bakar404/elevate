// Runs the proof pipeline and writes proof/RECEIPT.md from proof/results/.
//
//   1. Prove: Verus checks the spec and the code in verified/src/lib.rs.
//   2. Mutation check: one planted bug per requirement must fail on its clause.
//   3. Build the verified crate to WASM, into proof/build/.
//   4. Test D: packages/policy against the WASM on every input class.
//   5. Negative control: build mutant MW2 to WASM. D must fail against it.
//
//   node proof/run.mjs        (pnpm proof)
//
// VERUS, RUSTUP_TOOLCHAIN and ELEVATE_PDD_TARGET override the defaults.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTANTS, applyEdits } from "./mutation-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const results = join(here, "results");
const logs = join(results, "logs");
const lib = join(here, "verified", "src", "lib.rs");
const wasm = join(here, "build", "elevate_policy.wasm");
const verus = process.env.VERUS ?? join(process.env.TEMP ?? tmpdir(), "verus", "verus-arm64-win", "verus.exe");
const toolchain = process.env.RUSTUP_TOOLCHAIN ?? "1.99.1-aarch64-pc-windows-msvc";
const targetDir = process.env.ELEVATE_PDD_TARGET ?? join(tmpdir(), "elevate-pdd-target");
const NEGATIVE = "MW2";

mkdirSync(logs, { recursive: true });
mkdirSync(dirname(wasm), { recursive: true });
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const rel = (f) => relative(root, f).replaceAll("\\", "/");

function run(log, cmd, args, opts = {}) {
	const t0 = Date.now();
	const r = spawnSync(cmd, args, {
		cwd: opts.cwd ?? root,
		encoding: "utf8",
		shell: process.platform === "win32" && !cmd.endsWith(".exe"),
		env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain, ...opts.env },
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error}` : ""}`;
	writeFileSync(join(logs, `${log}.log`), output);
	return { status: r.status ?? -1, seconds: (Date.now() - t0) / 1000, output };
}

const steps = [];
const add = (id, name, command, r, ok, detail) => {
	steps.push({ id, name, command, exit: r.status, seconds: r.seconds, ok, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail} (${r.seconds.toFixed(1)} s)`);
};
const cargoBuild = (cwd, target, log) =>
	run(log, "cargo", [`+${toolchain}`, "build", "--release", "--target", "wasm32-unknown-unknown"], { cwd, env: { CARGO_TARGET_DIR: target } });

// 1. Prove
let r = run("prove", verus, [lib, "--crate-type=lib", "--edition=2021"]);
const proveSummary = r.output.match(/verification results:: (\d+) verified, (\d+) errors/);
add("prove", "Prove", "verus proof/verified/src/lib.rs --crate-type=lib --edition=2021", r, r.status === 0, proveSummary ? `${proveSummary[1]} verified, ${proveSummary[2]} errors` : "no summary");

// 2. Mutation check
r = run("mutation", process.execPath, [join(here, "mutation-check.mjs"), "--json", join(results, "mutation.json")], { env: { VERUS: verus } });
const mutation = existsSync(join(results, "mutation.json")) ? JSON.parse(readFileSync(join(results, "mutation.json"), "utf8")) : { mutants: [] };
const caught = mutation.mutants.filter((m) => m.ok).length;
add("mutation", "Mutation check", "node proof/mutation-check.mjs", r, r.status === 0, `${caught} of ${mutation.mutants.length} mutants rejected on their clause; draft gap ${mutation.draftGap?.gapShown ? "shown" : "NOT shown"}`);

// 3. Build to WASM
r = cargoBuild(join(here, "verified"), targetDir, "build");
const built = join(targetDir, "wasm32-unknown-unknown", "release", "elevate_policy.wasm");
const buildOk = r.status === 0 && existsSync(built);
if (buildOk) copyFileSync(built, wasm);
add("build", "Build to WASM", "cargo build --release --target wasm32-unknown-unknown", r, buildOk, buildOk ? `${rel(wasm)}, ${readFileSync(wasm).length} bytes` : "the build failed");

// 4. Test D
const vitest = (log, wasmFile, out) =>
	run(log, "pnpm", ["exec", "vitest", "run", "packages/policy/test/differential.test.ts"], {
		env: { ELEVATE_POLICY_WASM: wasmFile, PDD_RESULTS: out, PDD_REQUIRE_WASM: "1" },
	});
const diffJson = join(results, "differential.json");
rmSync(diffJson, { force: true });
r = vitest("test", wasm, diffJson);
const diff = existsSync(diffJson) ? JSON.parse(readFileSync(diffJson, "utf8")) : { sections: [] };
const totalInputs = diff.sections.reduce((s, x) => s + x.inputs, 0);
const totalMismatch = diff.sections.reduce((s, x) => s + x.mismatches, 0);
add("test", "Test D", "vitest run packages/policy/test/differential.test.ts", r, r.status === 0 && totalInputs > 0 && totalMismatch === 0, `${totalMismatch} of ${totalInputs.toLocaleString("en-US")} inputs differ`);

// 5. Negative control: the MW2 mutant built to WASM must make D fail.
const negDir = join(tmpdir(), "elevate-pdd-negative");
rmSync(negDir, { recursive: true, force: true });
mkdirSync(join(negDir, "src"), { recursive: true });
const mutant = MUTANTS.find((m) => m.id === NEGATIVE);
writeFileSync(join(negDir, "src", "lib.rs"), applyEdits(readFileSync(lib, "utf8").replace(/\r\n/g, "\n"), mutant.edits, NEGATIVE));
for (const f of ["Cargo.toml", "Cargo.lock"]) copyFileSync(join(here, "verified", f), join(negDir, f));
const negTarget = `${targetDir}-negative`;
const nb = cargoBuild(negDir, negTarget, "negative-control-build");
const negWasm = join(negTarget, "wasm32-unknown-unknown", "release", "elevate_policy.wasm");
const negJson = join(results, "negative-control.json");
rmSync(negJson, { force: true });
r = nb.status === 0 ? vitest("negative-control", negWasm, negJson) : nb;
r.seconds += nb.status === 0 ? nb.seconds : 0;
const neg = existsSync(negJson) ? JSON.parse(readFileSync(negJson, "utf8")) : { sections: [] };
const negSection = neg.sections.find((s) => s.mismatches > 0);
const negOk = nb.status === 0 && r.status !== 0 && !!negSection;
add("negative-control", "Negative control", `${NEGATIVE} to WASM; vitest run differential.test.ts`, r, negOk, negSection ? `D failed, as it must: ${negSection.mismatches.toLocaleString("en-US")} of ${negSection.inputs.toLocaleString("en-US")} ${negSection.name} inputs differ` : "D did NOT fail");

// ─── Receipt ─────────────────────────────────────────────────────────────
const pass = steps.every((s) => s.ok);
const version = (cmd, args, re) => (spawnSync(cmd, args, { encoding: "utf8", shell: !cmd.endsWith(".exe"), env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain } }).stdout ?? "").match(re)?.[1] ?? "?";
const versions = {
	Verus: version(verus, ["--version"], /Version:\s*(\S+)/),
	Rust: version("rustc", [`+${toolchain}`, "--version"], /(rustc .*)/),
	Node: process.version,
	Vitest: JSON.parse(readFileSync(join(root, "node_modules", "vitest", "package.json"), "utf8")).version,
};
const now = new Date().toISOString().replace("T", " ").slice(0, 19);
const gitHead = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "uncommitted";

const REQS = [
	["L1", "The legitimacy score is (2·prior + 3·review) / 5.", "legitimacy"],
	["L2", "The score stays within 0 to 100.", "legitimacy"],
	["L3", "More evidence never lowers the score or turns a pass into a fail.", "legitimacy"],
	["L4", "The reviewer's \"not legit\" is a veto.", "legitimacy"],
	["L5", "The model alone can't pass anything: evidence below the floor never passes.", "legitimacy"],
	["L6", "Otherwise it passes exactly when the score reaches the threshold.", "legitimacy"],
	["S1", "Nothing is sound for a technique that failed Gate 1.", "soundness"],
	["S2", "The reviewer's \"unsound\" is a veto.", "soundness"],
	["S3", "No way to measure the impact, no pass.", "soundness"],
	["S4", "Riskier changes need a stronger case (+0, +5, +15).", "soundness"],
	["S5", "Otherwise it passes exactly when the score reaches the risk-adjusted bar.", "soundness"],
	["S6", "The inbox rank is exact, within 0 to 100, and monotone.", "rank"],
	["T1", "Only an open recommendation is approved (or a failed one retried).", "transition"],
	["T2", "A swarm starts only from approved; a PR or failure only from a running swarm.", "transition"],
	["T3", "Nothing reaches the inbox without passing the gates.", "transition"],
	["T4", "Gated out can only go back to candidate.", "transition"],
	["T5", "A draft PR is the end.", "transition"],
	["T6", "A rejected recommendation reopens as a candidate, re-gated.", "transition"],
	["T7", "No swarm without both gates and your approval, for every event history.", "replay"],
	["W1", "Never merge, push to the default branch, or force-push.", "authorize"],
	["W2", "No write until you approve.", "authorize"],
	["W3", "Only repos you opted in.", "authorize"],
	["W4", "Only the recommendation's own repo.", "authorize"],
	["W5", "Pull requests are drafts.", "authorize"],
	["W6", "Agent work stops at the budget; publishing finished work doesn't.", "authorize"],
	["W7", "Otherwise the write is allowed, and only then.", "authorize"],
];
const proved = steps.find((s) => s.id === "prove")?.ok;
const sec = Object.fromEntries(diff.sections.map((s) => [s.name, s]));
const mutBy = (id) => mutation.mutants.filter((m) => m.target === id && m.ok).map((m) => m.id).join(", ");
const fmt = (n) => n.toLocaleString("en-US");

const md = [];
md.push("# Receipt: elevate's policy kernel", "");
md.push(`**${pass ? "PASS" : "FAIL"}.** Run ${now} UTC on ${process.platform} ${process.arch}, at elevate \`${gitHead}\`. Written by \`proof/run.mjs\` from \`proof/results/\`; the requirements and decisions are in \`proof/intent.md\`.`, "");
md.push("## Requirements", "");
md.push("| # | Requirement | Formally verified (Verus) | Mutant rejected | Empirically checked (D) |", "|---|---|---|---|---|");
for (const [id, text, s] of REQS) {
	const d = sec[s];
	md.push(`| ${id} | ${text} | ${proved ? `proved (${id})` : "NOT proved"} | ${mutBy(id) || "none"} | ${d ? `${s}: ${fmt(d.mismatches)} of ${fmt(d.inputs)} differ` : "not run"} |`);
}
md.push("", "## Steps", "", "| Step | Command | Exit | Time | Result |", "|---|---|---|---|---|");
for (const s of steps) md.push(`| ${s.name} | \`${s.command}\` | ${s.exit} | ${s.seconds.toFixed(1)} s | ${s.ok ? "ok" : "FAIL"}: ${s.detail} |`);
md.push("", "## Mutation check", "", "One bug planted per clause in a scratch copy. Each must fail the proof on the clause it targets; one that proves means that clause rules out nothing.", "");
md.push("| Mutant | Planted bug | Aimed at | Verus rejected it on | Result |", "|---|---|---|---|---|");
for (const m of mutation.mutants) md.push(`| ${m.id} | ${m.bug} | ${m.target} | ${m.caughtBy.join(", ") || "nothing"} | ${m.ok ? "caught" : "**NOT CAUGHT**"} |`);
md.push("", `**The draft-spec gap.** W1 to W6 only say when a write is refused. With them alone, today's guard ${mutation.draftGap?.withoutW7?.todayProves ? "proves" : "fails"} and so ${mutation.draftGap?.withoutW7?.mw7Proves ? "does" : "does not"} MW7, a guard that refuses every draft PR, so the safety clauses permit a guard that never lets a swarm deliver. W7 pins the exact rule.`);
md.push("", "## The differential test (D)", "", "The shipped TypeScript (`packages/policy`) against the proved WASM:", "", "| Section | Inputs | Mismatches | Outcomes seen |", "|---|---|---|---|");
for (const s of diff.sections) md.push(`| ${s.name} | ${fmt(s.inputs)} | ${fmt(s.mismatches)} | ${Object.keys(s.outcomes).length} |`);
md.push("", `**Negative control.** The same test against mutant ${NEGATIVE} (${mutant.bug}) built to WASM must fail. ${negSection ? `It failed, as it must: ${fmt(negSection.mismatches)} of ${fmt(negSection.inputs)} ${negSection.name} inputs differ. One of them: \`${JSON.stringify(negSection.example)}\`.` : "**It did not fail.**"}`);
md.push("", "## Trusted pieces", "", "| | Trusted | Check |", "|---|---|---|");
md.push("| TB1 | The WASM shim's code mapping | D, and the negative control |");
md.push("| TB2 | The TypeScript is what runs (decision D1) | D over every input class |");
md.push("| TB3 | Every GitHub write goes through the guard | `guardedGitHub` unit test in packages/executors |");
md.push("| TB4 | Normalization (`pct`) | packages/policy/test/policy.test.ts |");
md.push(`| TB5 | Verus ${versions.Verus}, Z3, vstd, ${versions.Rust} | None: assumed, as in PDD Kit |`);
md.push("| TB6 | The intent, turned into clauses | Review of `proof/intent.md` |");
md.push("", "## Versions and hashes", "", "| | |", "|---|---|");
for (const [k, v] of Object.entries(versions)) md.push(`| ${k} | ${v} |`);
md.push(`| sha256 \`proof/verified/src/lib.rs\` | \`${sha(lib)}\` |`);
md.push(`| sha256 \`packages/policy/src/index.ts\` | \`${sha(join(root, "packages", "policy", "src", "index.ts"))}\` |`);
if (existsSync(wasm)) md.push(`| sha256 \`proof/build/elevate_policy.wasm\` | \`${sha(wasm)}\` |`);
if (existsSync(negWasm)) md.push(`| sha256 ${NEGATIVE} WASM (negative control) | \`${sha(negWasm)}\` |`);
writeFileSync(join(here, "RECEIPT.md"), `${md.join("\n")}\n`);
writeFileSync(join(results, "run.json"), `${JSON.stringify({ pass, at: now, gitHead, steps, versions }, null, "\t")}\n`);
console.log(pass ? "proof: PASS (proof/RECEIPT.md)" : "proof: FAIL (proof/RECEIPT.md)");
process.exit(pass ? 0 : 1);
