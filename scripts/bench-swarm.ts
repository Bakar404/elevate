import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { modelConfigFromEnv, resolveModel, stopCopilotClient } from "../packages/agent/src/index.ts";
import { aggregateBench, assertSafeExecutor, BENCH_BUDGET, FixtureSchema, formatBenchTable, parseBenchArgs, runBenchTask, type TaskResult } from "./lib/swarm-bench.ts";

let local = false;
function gitSha(): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

try {
  const options = parseBenchArgs(process.argv.slice(2));
  local = options.executor === "local";
  assertSafeExecutor(options.executor);
  options.model ??= resolveModel("swarm") || undefined;
  const fixtureBytes = await readFile(new URL("../fixtures/swarm-bench-tasks.json", import.meta.url), "utf8");
  const fixture = FixtureSchema.parse(JSON.parse(fixtureBytes));
  const tasks: TaskResult[] = [];
  for (let run = 1; run <= options.runs; run++) {
    for (const task of fixture.tasks) tasks.push(await runBenchTask(task, run, options));
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    executor: options.executor,
    provider: local ? modelConfigFromEnv().provider : null,
    localAgent: local ? process.env.ELEVATE_LOCAL_AGENT || "copilot" : null,
    model: options.model ?? null,
    modelLabel: options.model ?? "runtime default",
    simulated: !local,
    notice: local
      ? "Fixture-only local execution: real model planning, local CLI edits, independent acceptance tests and model diff review. No remote clones, git pushes or live GitHub writes. CLI token usage may be unknown; SDK-only accounting is partial."
      : "SIMULATED ONLY: no model calls, code changes, acceptance tests, network or real GitHub writes. Success means the simulated executor flow completed, not a measured model success rate.",
    fixtureSource: fixture.source,
    fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
    budget: BENCH_BUDGET,
    tasks,
    summary: aggregateBench(tasks),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, json, "utf8");
  }
  console.log(formatBenchTable(tasks, options.model));
  console.log(report.notice);
  if (options.out) console.log(`JSON report: ${options.out}`);
  if (tasks.some((task) => !task.success)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (local) await stopCopilotClient().catch(() => {});
}
