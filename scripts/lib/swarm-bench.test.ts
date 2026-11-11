import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { FakeLLM, UsageRecorder } from "../../packages/agent/src/index.ts";
import { FakeExecutor, LocalExecutor, type ExecutorOptions, type SwarmRun } from "../../packages/executors/src/index.ts";
import { aggregateBench, assertSafeExecutor, fixtureVerification, FixtureSchema, formatBenchTable, materializeFixture, parseBenchArgs, runBenchTask, runLocalBenchTask, sampleStats, taskPlan } from "./swarm-bench.ts";

const execute = promisify(execFile);

const fixture = FixtureSchema.parse(JSON.parse(readFileSync(new URL("../../fixtures/swarm-bench-tasks.json", import.meta.url), "utf8")));
const task = fixture.tasks[0]!;
const options = { runs: 1, executor: "fake" as const, model: "gpt-5.4" };

describe("swarm benchmark", () => {
  it("validates flags and positive integer runs", () => {
    expect(parseBenchArgs(["--model", "gpt-5.4", "--runs", "3", "--executor", "fake", "--out", "bench.json"])).toEqual({ model: "gpt-5.4", runs: 3, executor: "fake", out: "bench.json" });
    for (const value of ["0", "-1", "1.5", "NaN", "1e2", "9007199254740992"]) expect(() => parseBenchArgs(["--runs", value])).toThrow("positive integer");
    expect(() => parseBenchArgs(["--model"])).toThrow("Missing value");
    expect(() => parseBenchArgs(["--executor", "cloud"])).toThrow("fake or local");
    expect(() => parseBenchArgs(["--unknown"])).toThrow("Unknown argument");
  });

  it("reports missing or unsupported local CLI prerequisites", () => {
    expect(() => assertSafeExecutor("local", { PATH: "", ELEVATE_LOCAL_AGENT: "copilot" })).toThrow("prerequisite");
    expect(() => assertSafeExecutor("local", { PATH: "", ELEVATE_LOCAL_AGENT: "unknown" })).toThrow("copilot, claude or codex");
  });

  it("covers all demo repos with uniquely identified, testable plans", () => {
    expect(new Set(fixture.tasks.map((t) => t.repo)).size).toBe(3);
    for (const task of fixture.tasks) {
      expect(taskPlan(task).tasks.map((t) => t.role)).toEqual(["planner", "implementer", "tester", "reviewer", "publisher"]);
    }
    expect(() => FixtureSchema.parse({ ...fixture, tasks: fixture.tasks.map(() => task) })).toThrow("unique");
  });

  it("runs the actual fake executor offline and captures guarded draft payloads", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("network forbidden"); });
    try {
      const result = await runBenchTask(task, 1, options);
      expect(result).toMatchObject({ success: true, simulated: true, realSuccess: false, testsPassed: null, simulatedTestsCompleted: true, failureStage: null, budgetExceeded: false, tokens: null, costUsd: null });
      expect(result.draftPayload).toMatchObject({ base: "main", title: task.title, head: `elevate/bench-${task.id}-1` });
      expect(result.draftPayload?.body).toContain(task.title);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it.each(["plan", "implement", "test", "review"] as const)("records %s failures", async (stage) => {
    class FailedExecutor extends FakeExecutor {
      override async run(run: SwarmRun): Promise<never> {
        await run.setTask(stage, "failed");
        throw new Error(`${stage} failed`);
      }
    }
    expect(await runBenchTask(task, 1, options, { executor: new FailedExecutor() })).toMatchObject({ success: false, failureStage: stage, error: `${stage} failed` });
  });

  it("requires completed tests and a draft payload, not just an outcome URL", async () => {
    class IncompleteExecutor extends FakeExecutor {
      override async run(run: SwarmRun) {
        await run.setTask("plan", "done");
        await run.setTask("implement", "done");
        return { prUrl: "memory://not-evidence", summary: "incomplete" };
      }
    }
    expect(await runBenchTask(task, 1, options, { executor: new IncompleteExecutor() })).toMatchObject({ success: false, failureStage: "test", draftPayload: null });
    class MissingDraftExecutor extends FakeExecutor {
      override async run(run: SwarmRun) {
        for (const step of run.plan.tasks) await run.setTask(step.key, "done");
        return { prUrl: "memory://not-evidence", summary: "no payload" };
      }
    }
    expect(await runBenchTask(task, 1, options, { executor: new MissingDraftExecutor() })).toMatchObject({ success: false, failureStage: "review", draftPayload: null });
  });

  it("records guard budget refusals without publishing", async () => {
    const result = await runBenchTask(task, 1, options, { budget: { maxTasks: 1, maxMinutes: 5, maxAgentTurns: 8 } });
    expect(result).toMatchObject({ success: false, failureStage: "test", budgetExceeded: true, draftPayload: null });
    expect(result.error).toContain("budget_exhausted");
  });

  it("does not capture non-draft publication attempts", async () => {
    class UnsafePublisher extends FakeExecutor {
      override async run(run: SwarmRun) {
        await run.setTask("review", "running");
        await run.github.openDraftPr(task.repo, { head: run.branch, base: "main", title: task.title, body: "unsafe", draft: false });
        return { summary: "must not reach writer" };
      }
    }
    expect(await runBenchTask(task, 1, options, { executor: new UnsafePublisher() })).toMatchObject({ success: false, failureStage: "review", draftPayload: null });
  });

  it("records elapsed time and post-run wall budget exhaustion", async () => {
    let time = 0;
    class SlowExecutor extends FakeExecutor {
      override async run(run: SwarmRun) {
        const result = await super.run(run);
        time = 360_000;
        return result;
      }
    }
    const result = await runBenchTask(task, 1, options, { executor: new SlowExecutor(), now: () => time });
    expect(result.elapsedMs).toBe(360_000);
    expect(result.budgetExceeded).toBe(true);
    expect(result.success).toBe(false);
  });

  it("aggregates per-run rates with sample standard deviation and preserves unknown accounting", async () => {
    const a = await runBenchTask(task, 1, options);
    const summary = aggregateBench([a, { ...a, run: 2, success: false }]);
    expect(summary.successRate?.mean).toBe(0.5);
    expect(summary.successRate?.sd).toBeCloseTo(Math.sqrt(0.5));
    expect(summary.tokens).toBeNull();
    expect(summary.costUsd).toBeNull();
    expect(summary.totals).toMatchObject({ tasks: 2, successes: 1, inputTokens: null, outputTokens: null, tokens: null, costUsd: null });
    expect(sampleStats([1])).toEqual({ mean: 1, sd: 0 });
    expect(sampleStats([])).toBeNull();
  });

  it("prints compact simulation results without fabricating unknown tokens or cost", async () => {
    const row = await runBenchTask(task, 1, options);
    const table = formatBenchTable([row]);
    expect(table).toContain("SIMULATED — not measured model quality");
    expect(table).toContain("runtime default");
    expect(table).toContain("simulated-ok");
    expect(table).toContain("1.000 ± 0.000 (simulated)");
    expect(table).toContain("Run tokens mean: null | run USD mean: null");
    expect(table).toContain("Total tokens: null | total USD: null");
  });

  it.each(fixture.tasks.map((task) => [task.id, task] as const))("independent acceptance tests reject the intentional %s seed defect", async (_id, seed) => {
    const workspace = await materializeFixture(seed);
    try {
      const { command, args } = fixtureVerification(seed);
      const error = await execute(command, args, { cwd: workspace.directory, timeout: 60_000 }).then(() => null, (error: Error & { stdout: string; stderr: string }) => error);
      expect(error).not.toBeNull();
      expect(`${error?.stdout}\n${error?.stderr}`).toMatch(/not ok|FAILED|test result: FAILED/);
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects unsafe seed paths", () => {
    const invalid = structuredClone(fixture);
    invalid.tasks[0]!.fixture.files = { "../escape.ts": "unsafe" };
    expect(() => FixtureSchema.parse(invalid)).toThrow();
  });

  it("materializes fixture seeds under the configured system temporary directory", async () => {
    const workspace = await materializeFixture(task);
    try {
      expect(dirname(workspace.directory)).toBe(tmpdir());
    } finally {
      await workspace.cleanup();
    }
  });

  it("explicitly enables TypeScript stripping on the minimum supported Node runtime", () => {
    expect(fixtureVerification(task).args.join(" ")).toContain("--experimental-strip-types");
  });

  it.each(["node", "python", "rust"] as const)("rejects an early zero exit that omits %s acceptance tests", async (runtime) => {
    const seed = structuredClone(fixture.tasks.find((candidate) => candidate.fixture.runtime === runtime)!);
    const [path, original] = Object.entries(seed.fixture.files)[0]!;
    seed.fixture.files[path] = runtime === "node" ? `process.exit(0);\n${original}`
      : runtime === "python" ? `import os\nos._exit(0)\n${original}`
      : original.replace(/\{[\s\S]*$/, "{ std::process::exit(0); }\n");
    const workspace = await materializeFixture(seed);
    try {
      const { command, args } = fixtureVerification(seed);
      const error = await execute(command, args, { cwd: workspace.directory, timeout: 60_000 }).then(() => null, (error: Error & { stderr: string }) => error);
      expect(error?.stderr).toContain("Incomplete acceptance evidence");
    } finally {
      await workspace.cleanup();
    }
  });
});

const correctParser = `export function parseQuery(text: string): [string, string][] {
  if (!text) return [];
  return text.split('&').map((part) => {
    const position = part.indexOf('=');
    if (position <= 0) throw new Error('Invalid query');
    return [decodeURIComponent(part.slice(0, position)), decodeURIComponent(part.slice(position + 1))];
  });
}
export function serializeQuery(ast: [string, string][]): string {
  return ast.map(([key,value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
}
`;

function localHarness({ fix = true, approve = true }: { fix?: boolean; approve?: boolean } = {}) {
  const recorder = new UsageRecorder();
  const llm = new FakeLLM()
    .on("plan", () => {
      recorder.record({ role: "swarm", model: "gpt-5.4", inputTokens: 10, outputTokens: 5 });
      return { summary: "Fix encoding", acceptanceCriteria: task.acceptanceCriteria, subtasks: [{ key: "encoding", title: "Fix encoding", instructions: task.instructions, files: task.touchpoints, dependsOn: [] }], verification: task.verification };
    })
    .on("review", () => {
      recorder.record({ role: "swarm", model: "gpt-5.4", inputTokens: 20, outputTokens: 5 });
      return { approve, summary: approve ? "Verified encoding change" : "Rejected", issues: approve ? [] : ["Incorrect implementation"] };
    });
  const createExecutor = (executorOptions: ExecutorOptions) => ({
    kind: "local" as const, label: "Test-only local executor",
    async run(run: SwarmRun) {
      const benchmark = executorOptions.benchmark!;
      await run.github.authorize("run_local_agent", task.repo);
      await run.setTask("impl-1", "running");
      if (fix) await writeFile(join(benchmark.fixtureDirectory, "src/parser/query.ts"), correctParser);
      run.github.turn();
      await run.setTask("impl-1", "done");
      await run.setTask("test", "running");
      await run.setTask("test", "done");
      await run.setTask("review", "running");
      await run.setTask("review", "done");
      await run.setTask("publish", "done");
      let output: string;
      try {
        const checked = await execute(benchmark.verify.command, benchmark.verify.args, { cwd: benchmark.fixtureDirectory, timeout: 60_000 });
        output = checked.stdout;
      } catch {
        throw new Error("Fixture verification failed: independent acceptance command exited nonzero");
      }
      await benchmark.beforePublish?.(benchmark.fixtureDirectory, { diff: `diff --git a/src/parser/query.ts b/src/parser/query.ts\n+${correctParser}`, verification: { ...benchmark.verify, output } });
      await run.github.authorizePush(task.repo, run.branch);
      const pr = await run.github.openDraftPr(task.repo, { head: run.branch, base: "main", title: task.title, body: "Independently checked fixture diff" });
      return { prUrl: pr.url, summary: "Test-only result", usage: null, verification: { ...benchmark.verify, output } };
    },
  });
  return { llm, recorder, createExecutor };
}

describe("local fixture benchmark", () => {
  it.skipIf(process.platform === "win32").each([
    ["python", "def decode(draft_tokens, target_tokens, eos=0):\n    result = []\n    for token in target_tokens:\n        if token == eos:\n            break\n        result.append(token)\n    return result\n"],
    ["rust", "pub fn encode(seq: u16, payload: &[u8], out: &mut [u8]) -> Result<usize, &'static str> {\n    if payload.len() > 255 || out.len() < 3 + payload.len() { return Err(\"Invalid size\"); }\n    let bytes = seq.to_le_bytes();\n    out[0] = bytes[0]; out[1] = bytes[1]; out[2] = payload.len() as u8;\n    out[3..3 + payload.len()].copy_from_slice(payload);\n    Ok(3 + payload.len())\n}\n"],
  ] as const)("accepts fixed %s through actual LocalExecutor trusted-marker verification", async (runtime, fixedSource) => {
    const seed = fixture.tasks.find((candidate) => candidate.fixture.runtime === runtime)!;
    const [path] = Object.keys(seed.fixture.files);
    const bin = await mkdtemp(join(tmpdir(), "elevate-test-cli-"));
    await writeFile(join(bin, "copilot"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path)}, ${JSON.stringify(fixedSource)});\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const llm = new FakeLLM()
      .on("plan", () => ({
        summary: seed.title, acceptanceCriteria: seed.acceptanceCriteria, verification: seed.verification,
        subtasks: [{ key: "fix", title: seed.title, instructions: seed.instructions, files: seed.touchpoints, dependsOn: [] }],
      }))
      .on("review", () => ({ approve: true, summary: "Test-only review of verified fixture", issues: [] }));
    try {
      const result = await runLocalBenchTask(seed, 1, { ...options, executor: "local" }, {
        llm, createExecutor: (executorOptions) => new LocalExecutor("copilot", executorOptions),
      });
      expect(result.error).toBeNull();
      expect(result).toMatchObject({ success: true, testsPassed: true, failureStage: null, tokens: null, costUsd: null });
      expect(result.verification?.output.split(/\r?\n/)).toContain(fixtureVerification(seed).successMarker);
      expect(result.draftPayload).not.toBeNull();
      expect(llm.calls.map((call) => call.task)).toEqual(["plan", "review"]);
    } finally {
      vi.unstubAllEnvs();
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("plans and reviews with the selected model, runs immutable acceptance tests and captures only an in-memory draft", async () => {
    const hooks = localHarness();
    const result = await runLocalBenchTask(task, 1, { ...options, executor: "local" }, hooks);
    expect(result).toMatchObject({ simulated: false, success: true, realSuccess: true, testsPassed: true, failureStage: null, tokens: null, costUsd: null, sdkTokens: { inputTokens: 30, outputTokens: 10 } });
    expect(result.verification?.output).toContain("pass 2");
    expect(result.verification?.output).toContain(fixtureVerification(task).successMarker);
    expect(result.draftPayload?.head).toContain("elevate/bench-");
    expect(hooks.llm.calls.map((call) => ({ task: call.task, role: call.role, model: call.model }))).toEqual([
      { task: "plan", role: "swarm", model: "gpt-5.4" },
      { task: "review", role: "swarm", model: "gpt-5.4" },
    ]);
    expect(hooks.llm.calls[1]!.prompt).toContain(correctParser);
  });

  it("attributes independent verification failure to test after review and publish were marked done", async () => {
    const hooks = localHarness({ fix: false });
    expect(await runLocalBenchTask(task, 1, { ...options, executor: "local" }, hooks)).toMatchObject({ success: false, testsPassed: false, failureStage: "test", draftPayload: null });
    expect(hooks.llm.calls.map((call) => call.task)).toEqual(["plan"]);
  });

  it("requires independent diff review approval after passing tests", async () => {
    const result = await runLocalBenchTask(task, 1, { ...options, executor: "local" }, localHarness({ approve: false }));
    expect(result).toMatchObject({ success: false, testsPassed: true, failureStage: "review", draftPayload: null });
  });

  it("records planning failures before attempting local agents", async () => {
    const hooks = localHarness();
    hooks.llm.on("plan", () => { throw new Error("Planning unavailable"); });
    expect(await runLocalBenchTask(task, 1, { ...options, executor: "local" }, hooks)).toMatchObject({ success: false, failureStage: "plan", testsPassed: null, tokens: null, costUsd: null });
  });

  it("reports configured SDK-only costs without pretending opaque CLI usage is known", async () => {
    vi.stubEnv("ELEVATE_MODEL_PRICES_JSON", '{"gpt-5.4":{"inputPerMTok":2,"outputPerMTok":4}}');
    try {
      const result = await runLocalBenchTask(task, 1, { ...options, executor: "local" }, localHarness());
      expect(result.sdkCostUsd).toBeCloseTo(0.0001);
      expect(result.costUsd).toBeNull();
      expect(aggregateBench([result]).costUsd).toBeNull();
      expect(aggregateBench([result]).totals).toMatchObject({ tokens: null, costUsd: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not pass a model sentinel when runtime selection is requested", async () => {
    const hooks = localHarness();
    const result = await runLocalBenchTask(task, 1, { runs: 1, executor: "local" }, hooks);
    expect(result.model).toBeNull();
    expect(hooks.llm.calls.every((call) => call.model === undefined)).toBe(true);
  });

  it("records oversized model plans as budget failures before implementation", async () => {
    const hooks = localHarness();
    hooks.llm.on("plan", () => ({
      summary: "Over budget", acceptanceCriteria: task.acceptanceCriteria, verification: task.verification,
      subtasks: Array.from({ length: 4 }, (_, index) => ({ key: `task-${index}`, title: "Work", instructions: "Work", files: task.touchpoints, dependsOn: [] })),
    }));
    expect(await runLocalBenchTask(task, 1, { ...options, executor: "local" }, hooks)).toMatchObject({ success: false, budgetExceeded: true, failureStage: "plan", testsPassed: null });
  });
});
