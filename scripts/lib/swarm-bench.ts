import { z } from "zod";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { CopilotLLM, estimateCostUsd, modelConfigFromEnv, UsageRecorder, type LLM } from "../../packages/agent/src/index.ts";
import { FakeExecutor, FakeGitHub, LocalExecutor, createLocalBenchmarkGitHub, guardedGitHub, topoOrder, type Executor, type ExecutorOptions, type LocalAgent, type SwarmPlan, type SwarmRun } from "../../packages/executors/src/index.ts";
import { PLAN_SYSTEM, PlanSchema, REVIEW_SYSTEM, ReviewSchema } from "../../packages/engine/src/prompts.ts";

export type BenchOptions = { model?: string; runs: number; executor: "fake" | "local"; out?: string };
export type FailureStage = "plan" | "implement" | "test" | "review";
export const BENCH_BUDGET = { maxTasks: 4, maxMinutes: 5, maxAgentTurns: 8 };

export const FixtureSchema = z.object({
  source: z.literal("packages/engine/src/demo.ts"),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    repo: z.enum(["demo/ledger-api", "demo/llm-router", "demo/edge-firmware"]),
    surface: z.string().min(1),
    title: z.string().min(1),
    touchpoints: z.array(z.string().min(1)).min(1),
    instructions: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    verification: z.string().min(1),
    fixture: z.object({
      runtime: z.enum(["node", "python", "rust"]),
      expectedTests: z.number().int().positive(),
      files: z.record(z.string().regex(/^(src|router)\/[a-zA-Z0-9_/-]+\.(ts|py|rs)$/), z.string().min(1)).refine((files) => Object.keys(files).length > 0),
      acceptanceScript: z.string().min(1),
    }),
  })).min(5).max(10).refine((tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length, "Task IDs must be unique"),
});
export type BenchTask = z.infer<typeof FixtureSchema>["tasks"][number];
export type TaskResult = {
  taskId: string;
  run: number;
  repo: string;
  model: string | null;
  simulated: boolean;
  success: boolean;
  realSuccess: boolean;
  failureStage: FailureStage | null;
  error: string | null;
  elapsedMs: number;
  budgetExceeded: boolean;
  testsPassed: boolean | null;
  simulatedTestsCompleted: boolean;
  draftPayload: { head: string; base: string; title: string; body: string } | null;
  tokens: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
  sdkUsage?: ReturnType<UsageRecorder["snapshot"]>;
  sdkTokens?: { inputTokens: number; outputTokens: number } | null;
  sdkCostUsd?: number | null;
  verification?: { command: string; args: string[]; output: string } | null;
  review?: z.infer<typeof ReviewSchema> | null;
};

export function parseBenchArgs(args: string[]): BenchOptions {
  const options: BenchOptions = { runs: 1, executor: "fake" };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--model", "--runs", "--executor", "--out"].includes(flag!)) throw new Error(`Unknown argument: ${flag}`);
    const value = args[++i]?.trim();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--runs") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--runs must be a positive integer");
      options.runs = Number(value);
    } else if (flag === "--executor") {
      if (value !== "fake" && value !== "local") throw new Error("--executor must be fake or local");
      options.executor = value;
    } else if (flag === "--model") options.model = value;
    else options.out = value;
  }
  return options;
}

export function assertSafeExecutor(executor: BenchOptions["executor"], env: NodeJS.ProcessEnv = process.env) {
  if (executor === "local") {
    const agent = localAgent(env);
    if (!findExecutable(agent, env)) throw new Error(`Local benchmark prerequisite missing: install/authenticate the ${agent} CLI (ELEVATE_LOCAL_AGENT=copilot|claude|codex). Fixture mode never clones remote repositories, requests clone/push credentials, pushes git, or uses a live GitHub writer.`);
    for (const runtime of ["python3", "rustc"]) {
      if (!findExecutable(runtime, env)) throw new Error(`Local benchmark prerequisite missing: ${runtime} is required by the committed fixture acceptance tests`);
    }
  }
}

function localAgent(env: NodeJS.ProcessEnv = process.env): LocalAgent {
  const agent = env.ELEVATE_LOCAL_AGENT || "copilot";
  if (agent !== "copilot" && agent !== "claude" && agent !== "codex") throw new Error("ELEVATE_LOCAL_AGENT must be copilot, claude or codex");
  return agent;
}

function findExecutable(command: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    try { accessSync(join(dir, command), constants.X_OK); return true; } catch {}
  }
  return false;
}

export function taskPlan(task: BenchTask): SwarmPlan {
  return {
    summary: task.title,
    acceptanceCriteria: task.acceptanceCriteria,
    verification: task.verification,
    tasks: [
      { key: "plan", role: "planner", title: "Plan the fixture change", instructions: task.instructions, dependsOn: [] },
      { key: "implement", role: "implementer", title: task.title, instructions: `${task.instructions}\nTouchpoints: ${task.touchpoints.join(", ")}`, dependsOn: ["plan"] },
      { key: "test", role: "tester", title: "Run acceptance tests", instructions: task.verification, dependsOn: ["implement"] },
      { key: "review", role: "reviewer", title: "Review acceptance evidence", instructions: task.acceptanceCriteria.join("\n"), dependsOn: ["test"] },
      { key: "publish", role: "publisher", title: "Capture draft payload only", instructions: "Capture a draft payload in memory. Never contact GitHub.", dependsOn: ["review"] },
    ],
  };
}

/** Dependencies are test hooks, not a local execution or sandbox bypass. */
export async function runBenchTask(task: BenchTask, runNumber: number, options: BenchOptions, deps: {
  executor?: Executor;
  now?: () => number;
  budget?: { maxTasks: number; maxMinutes: number; maxAgentTurns: number };
} = {}): Promise<TaskResult> {
  if (options.executor === "local") return runLocalBenchTask(task, runNumber, options);
  assertSafeExecutor(options.executor);
  const executor = deps.executor ?? new FakeExecutor();
  if (executor.kind !== "fake") throw new Error("Only the offline fake executor is safe for this benchmark");
  const now = deps.now ?? Date.now;
  const start = now();
  const budget = deps.budget ?? BENCH_BUDGET;
  const writer = new FakeGitHub();
  const captured: { payload: TaskResult["draftPayload"] } = { payload: null };
  let budgetExceeded = false;
  const github = guardedGitHub({
    createIssue: (...args) => writer.createIssue(args[0], args[1]),
    comment: (...args) => writer.comment(...args),
    assignAgent: (...args) => writer.assignAgent(args[0], args[1]),
    linkedPrs: (...args) => writer.linkedPrs(...args),
    openDraftPr: async (repo, payload) => {
      const result = await writer.openDraftPr(repo, payload);
      captured.payload = { ...payload };
      return result;
    },
  }, {
    repoFullName: task.repo,
    defaultBranch: "main",
    budget,
    state: async () => ({ status: "in_progress", allowSwarm: true }),
    audit: async (_action, _target, details) => { if (details.verdict === "budget_exhausted") budgetExceeded = true; },
    now,
  });
  let stage: FailureStage = "plan";
  let success = false;
  let error: string | null = null;
  const statuses = new Map<string, string>();
  const stages: Record<string, FailureStage> = { plan: "plan", implement: "implement", test: "test", review: "review", publish: "review" };
  try {
    const plan = taskPlan(task);
    topoOrder(plan.tasks);
    const run: SwarmRun = {
      swarmId: `bench-${runNumber}-${task.id}`,
      repo: { fullName: task.repo, defaultBranch: "main" },
      recommendation: { id: task.id, title: task.title, rationale: task.instructions, expectedImpact: task.acceptanceCriteria.join("; ") },
      branch: `elevate/bench-${task.id}-${runNumber}`,
      plan,
      github,
      token: async () => { throw new Error("Offline benchmark must never request credentials"); },
      log: async () => {},
      setTask: async (key, status) => {
        stage = stages[key] ?? "review";
        statuses.set(key, status);
      },
      budgetMinutes: budget.maxMinutes,
    };
    const outcome = await executor.run(run);
    for (const step of plan.tasks) {
      if (statuses.get(step.key) !== "done") {
        stage = stages[step.key]!;
        throw new Error(`Executor did not complete ${step.key}`);
      }
    }
    stage = "review";
    if (!outcome.prUrl || !captured.payload || !captured.payload.body.trim()) throw new Error("Executor did not produce a draft payload");
    success = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const elapsedMs = Math.max(0, now() - start);
  const used = github.usage();
  budgetExceeded ||= elapsedMs >= budget.maxMinutes * 60_000 || used.tasks > budget.maxTasks || used.agentTurns > budget.maxAgentTurns;
  if (budgetExceeded && success) {
    success = false;
    error = "Benchmark budget exceeded";
  }
  return {
    taskId: task.id, run: runNumber, repo: task.repo, model: options.model || null,
    simulated: true, success, realSuccess: false, failureStage: success ? null : stage, error,
    elapsedMs, budgetExceeded, testsPassed: null, simulatedTestsCompleted: statuses.get("test") === "done",
    draftPayload: captured.payload, tokens: null, costUsd: null,
  };
}

export function fixtureVerification(task: BenchTask): { command: string; args: string[]; minimumTests: number; successMarker: string } {
  const { runtime, acceptanceScript, expectedTests } = task.fixture;
  const successMarker = `ELEVATE_SWARM_BENCH_ACCEPTANCE_PASSED:${expectedTests}`;
  const commands = runtime === "node"
    ? [[process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", acceptanceScript.replaceAll("'../src/", "'./src/")]]]
    : runtime === "python"
      ? [["python3", ["-B", "-c", acceptanceScript]]]
      : [["rustc", ["--edition=2021", "--test", ".elevate/benchmark-acceptance.rs", "-o", ".elevate/benchmark-acceptance"]], ["./.elevate/benchmark-acceptance", []]];
  const runner = [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "fs.mkdirSync('.elevate', {recursive:true});",
    ...(runtime === "rust" ? [`fs.writeFileSync('.elevate/benchmark-acceptance.rs', ${JSON.stringify(acceptanceScript)});`] : []),
    "let finalOutput = '';",
    `for (const [cmd,args] of ${JSON.stringify(commands)}) {`,
    "const result = spawnSync(cmd,args,{encoding:'utf8',timeout:60000,env:{...process.env,TMPDIR:require('node:path').resolve('.elevate')}});",
    "process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');",
    "if (result.error) process.stderr.write(result.error.message);",
    "if (result.status !== 0) process.exit(1);",
    "finalOutput = (result.stdout || '') + '\\n' + (result.stderr || '');",
    "}",
    runtime === "node"
      ? `const complete = /^# tests ${expectedTests}\\r?$/m.test(finalOutput) && /^# pass ${expectedTests}\\r?$/m.test(finalOutput) && /^# fail 0\\r?$/m.test(finalOutput);`
      : runtime === "python"
        ? `const complete = /Ran ${expectedTests} tests? in /.test(finalOutput) && /\\nOK\\s*$/.test(finalOutput);`
        : `const complete = /test result: ok\\. ${expectedTests} passed; 0 failed;/.test(finalOutput);`,
    "if (!complete) { process.stderr.write('Incomplete acceptance evidence: expected all committed tests to run and pass\\n'); process.exit(1); }",
    `process.stdout.write(${JSON.stringify(`${successMarker}\n`)});`,
  ].join("\n");
  return { command: process.execPath, args: ["-e", runner], minimumTests: expectedTests, successMarker };
}

export async function materializeFixture(task: BenchTask): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const root = resolve(".data-swarm-bench-fixtures");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, `${task.id}-`));
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
    await rmdir(root).catch(() => {});
  };
  try {
    for (const [path, content] of Object.entries(task.fixture.files)) {
      if (!/^(src|router)\/[a-zA-Z0-9_/-]+\.(ts|py|rs)$/.test(path)) throw new Error(`Unsafe fixture path: ${path}`);
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content, "utf8");
    }
    return { directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function measuredTokens(records: ReturnType<UsageRecorder["snapshot"]>) {
  if (!records.length || records.some((r) => r.inputTokens === null || r.outputTokens === null)) return null;
  return records.reduce((sum, r) => ({ inputTokens: sum.inputTokens + r.inputTokens!, outputTokens: sum.outputTokens + r.outputTokens! }), { inputTokens: 0, outputTokens: 0 });
}

function measuredCost(records: ReturnType<UsageRecorder["snapshot"]>) {
  if (!records.length) return null;
  const costs = records.map((r) => r.model ? estimateCostUsd(r.model, r) : null);
  return costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + cost!, 0);
}

export async function runLocalBenchTask(task: BenchTask, runNumber: number, options: BenchOptions, deps: {
  llm?: LLM;
  recorder?: UsageRecorder;
  /** Test hook; production always constructs LocalExecutor in fixture mode. */
  createExecutor?: (options: ExecutorOptions) => Executor;
} = {}): Promise<TaskResult> {
  if (!deps.createExecutor) assertSafeExecutor("local");
  const recorder = deps.recorder ?? new UsageRecorder();
  const llm = deps.llm ?? new CopilotLLM(modelConfigFromEnv(), recorder);
  const start = Date.now();
  let stage: FailureStage = "plan";
  let testsPassed: boolean | null = null;
  const inspected: { review: z.infer<typeof ReviewSchema> | null } = { review: null };
  let verification: TaskResult["verification"] = null;
  let success = false;
  let error: string | null = null;
  let budgetExceeded = false;
  let draftPayload: TaskResult["draftPayload"] = null;
  let executorUsage: ReturnType<UsageRecorder["snapshot"]> | null = null;
  let fixture: Awaited<ReturnType<typeof materializeFixture>> | undefined;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), BENCH_BUDGET.maxMinutes * 60_000);
  deadline.unref();
  const remainingMs = () => Math.max(1, BENCH_BUDGET.maxMinutes * 60_000 - (Date.now() - start));
  const { github, writer } = createLocalBenchmarkGitHub({
    repoFullName: task.repo,
    defaultBranch: "main",
    budget: BENCH_BUDGET,
    state: async () => ({ status: "in_progress", allowSwarm: true }),
    audit: async (_action, _target, details) => { if (details.verdict === "budget_exhausted") budgetExceeded = true; },
  });
  try {
    fixture = await materializeFixture(task);
    const planned = PlanSchema.parse(await llm.json({
      task: "plan", role: "swarm", ...(options.model ? { model: options.model } : {}),
      system: `${PLAN_SYSTEM}\nWork only on the supplied offline fixture. No network, repository remotes, commits, pushes or GitHub operations. Preserve the documented function interfaces. Use at most ${BENCH_BUDGET.maxTasks - 1} implementation tasks.`,
      prompt: [
        `Repository profile: ${task.repo}; surface: ${task.surface}`,
        `Approved task: ${task.title}\n${task.instructions}`,
        `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}`,
        `Verification: ${task.verification}`,
        `Fixture sources:\n${JSON.stringify(task.fixture.files, null, 2)}`,
      ].join("\n\n"),
      schema: PlanSchema, timeoutMs: remainingMs(),
    }));
    github.turn();
    if (planned.subtasks.length > BENCH_BUDGET.maxTasks - 1) {
      budgetExceeded = true;
      throw new Error("Planner exceeded the implementation task budget");
    }
    const earlier = new Map<string, string>();
    const implementers = planned.subtasks.map((subtask, index) => {
      const key = `impl-${index + 1}`;
      const dependsOn = subtask.dependsOn.flatMap((dependency) => earlier.has(dependency) ? [earlier.get(dependency)!] : []);
      earlier.set(subtask.key, key);
      return { key, role: "implementer" as const, title: subtask.title, instructions: `${subtask.instructions}\n${task.instructions}\nDo not change function interfaces or add network/dependency requirements.`, dependsOn: ["plan", ...dependsOn] };
    });
    const plan: SwarmPlan = {
      summary: planned.summary,
      acceptanceCriteria: task.acceptanceCriteria,
      verification: task.verification,
      tasks: [
        { key: "plan", role: "planner", title: "Plan the fixture change", instructions: planned.summary, dependsOn: [] },
        ...implementers,
        { key: "test", role: "tester", title: "Add and run fixture tests", instructions: `${planned.verification}\n${task.verification}\nThe harness independently checks immutable acceptance tests after your work.`, dependsOn: implementers.map((t) => t.key) },
        { key: "review", role: "reviewer", title: "Review actual diff", instructions: "The harness independently reviews the actual diff.", dependsOn: ["test"] },
        { key: "publish", role: "publisher", title: "Capture draft payload", instructions: "In-memory draft payload only; no git push or real PR.", dependsOn: ["review"] },
      ],
    };
    const executorOptions: ExecutorOptions = {
      ...(options.model ? { model: options.model } : {}),
      benchmark: {
        fixtureDirectory: fixture.directory,
        verify: fixtureVerification(task),
        beforePublish: async (_cwd, checked) => {
          const { diff } = checked;
          verification = checked.verification;
          testsPassed = true;
          stage = "review";
          if (!diff.trim()) throw new Error("No implementation diff to review");
          const review = ReviewSchema.parse(await llm.json({
            task: "review", role: "swarm", ...(options.model ? { model: options.model } : {}),
            system: REVIEW_SYSTEM,
            prompt: `Approved task: ${task.title}\n${task.instructions}\nAcceptance criteria: ${task.acceptanceCriteria.join("; ")}\nPlan: ${planned.summary}\nIndependent acceptance tests passed.\nActual diff:\n${diff}`,
            schema: ReviewSchema, timeoutMs: remainingMs(),
          }));
          inspected.review = review;
          github.turn();
          if (!review.approve || review.issues.length) throw new Error(`Review rejected: ${review.summary}; ${review.issues.join("; ")}`);
        },
      },
    };
    const executor = deps.createExecutor?.(executorOptions) ?? new LocalExecutor(localAgent(), executorOptions);
    if (executor.kind !== "local") throw new Error("A real local executor is required for local benchmark mode");
    stage = "implement";
    const outcome = await executor.run({
      swarmId: `bench-${runNumber}-${task.id}`,
      repo: { fullName: task.repo, defaultBranch: "main" },
      recommendation: { id: task.id, title: task.title, rationale: task.instructions, expectedImpact: task.acceptanceCriteria.join("; ") },
      branch: `elevate/bench-${task.id}-${runNumber}`, plan, github,
      token: async () => { throw new Error("Fixture benchmarks never request GitHub clone/push credentials"); },
      log: async () => {},
      setTask: async (_key, status, _output) => {
        if (status === "running" || status === "failed") stage = _key === "test" ? "test" : _key.startsWith("impl-") ? "implement" : "review";
      },
      signal: controller.signal, budgetMinutes: remainingMs() / 60_000,
    });
    verification = outcome.verification ?? null;
    executorUsage = outcome.usage ?? null;
    stage = "review";
    const published = writer.writes.find((write) => write.op === "openDraftPr");
    if (published) {
      const { head, base, title, body } = published.detail;
      if ([head, base, title, body].every((value) => typeof value === "string" && value.trim())) draftPayload = { head: head as string, base: base as string, title: title as string, body: body as string };
    }
    if (!outcome.prUrl || !draftPayload || !verification || testsPassed !== true || !inspected.review?.approve) throw new Error("Real success requires independent tests, model diff approval and a captured draft payload");
    success = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (error.startsWith("Fixture verification failed")) {
      stage = "test";
      testsPassed = false;
    }
  } finally {
    clearTimeout(deadline);
    await fixture?.cleanup();
  }
  const elapsedMs = Math.max(0, Date.now() - start);
  const usage = github.usage();
  budgetExceeded ||= controller.signal.aborted || elapsedMs >= BENCH_BUDGET.maxMinutes * 60_000 || usage.agentTurns > BENCH_BUDGET.maxAgentTurns || usage.tasks > BENCH_BUDGET.maxTasks;
  if (budgetExceeded) {
    success = false;
    error ??= "Benchmark budget exceeded";
  }
  const sdkUsage = recorder.snapshot();
  const fullUsage = executorUsage !== null && sdkUsage.length ? [...sdkUsage, ...executorUsage] : [];
  return {
    taskId: task.id, run: runNumber, repo: task.repo, model: options.model || null, simulated: false,
    success, realSuccess: success, failureStage: success ? null : stage, error, elapsedMs, budgetExceeded,
    testsPassed, simulatedTestsCompleted: false, draftPayload,
    tokens: measuredTokens(fullUsage), costUsd: measuredCost(fullUsage),
    sdkUsage, sdkTokens: measuredTokens(sdkUsage), sdkCostUsd: measuredCost(sdkUsage), verification, review: inspected.review,
  };
}

export function sampleStats(values: number[]) {
  if (!values.length) return null;
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  return { mean, sd: values.length === 1 ? 0 : Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (values.length - 1)) };
}

export function aggregateBench(rows: TaskResult[]) {
  const knownTokens = rows.length > 0 && rows.every((row) => row.tokens !== null);
  const knownCost = rows.length > 0 && rows.every((row) => row.costUsd !== null);
  const runIds = [...new Set(rows.map((r) => r.run))];
  const runs = runIds.map((run) => {
    const tasks = rows.filter((r) => r.run === run);
    const knownTokens = tasks.every((r) => r.tokens !== null);
    const knownCost = tasks.every((r) => r.costUsd !== null);
    return {
      run, successRate: tasks.filter((r) => r.success).length / tasks.length,
      elapsedMs: tasks.reduce((sum, r) => sum + r.elapsedMs, 0),
      tokens: knownTokens ? tasks.reduce((sum, r) => sum + r.tokens!.inputTokens + r.tokens!.outputTokens, 0) : null,
      costUsd: knownCost ? tasks.reduce((sum, r) => sum + r.costUsd!, 0) : null,
    };
  });
  return {
    totals: {
      tasks: rows.length,
      successes: rows.filter((row) => row.success).length,
      elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
      inputTokens: knownTokens ? rows.reduce((sum, row) => sum + row.tokens!.inputTokens, 0) : null,
      outputTokens: knownTokens ? rows.reduce((sum, row) => sum + row.tokens!.outputTokens, 0) : null,
      tokens: knownTokens ? rows.reduce((sum, row) => sum + row.tokens!.inputTokens + row.tokens!.outputTokens, 0) : null,
      costUsd: knownCost ? rows.reduce((sum, row) => sum + row.costUsd!, 0) : null,
    },
    runs,
    successRate: sampleStats(runs.map((r) => r.successRate)),
    elapsedMs: sampleStats(runs.map((r) => r.elapsedMs)),
    tokens: runs.length && runs.every((r) => r.tokens !== null) ? sampleStats(runs.map((r) => r.tokens!)) : null,
    costUsd: runs.length && runs.every((r) => r.costUsd !== null) ? sampleStats(runs.map((r) => r.costUsd!)) : null,
  };
}

export function formatBenchTable(rows: TaskResult[], model?: string): string {
  const simulated = rows.every((row) => row.simulated);
  const summary = aggregateBench(rows);
  const header = ["run", "task", "result", "stage", "seconds", "exec-budget", "tokens", "USD"];
  const cells = rows.map((row) => [
    String(row.run), row.taskId,
    row.success ? row.simulated ? "simulated-ok" : "PASS" : "FAIL",
    row.failureStage ?? "-", (row.elapsedMs / 1000).toFixed(3),
    row.budgetExceeded ? "EXCEEDED" : "ok",
    row.tokens ? String(row.tokens.inputTokens + row.tokens.outputTokens) : "null",
    row.costUsd === null ? "null" : row.costUsd.toFixed(6),
  ]);
  const widths = header.map((label, index) => Math.max(label.length, ...cells.map((row) => row[index]!.length)));
  const line = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  const rate = summary.successRate;
  return [
    `${simulated ? "SIMULATED — not measured model quality" : "LOCAL — fixture acceptance tests + model diff review"} | model: ${model || "runtime default"}`,
    line(header), ...cells.map(line),
    `Run success rate mean ± sample SD: ${rate ? `${rate.mean.toFixed(3)} ± ${rate.sd.toFixed(3)}` : "null"}${simulated ? " (simulated)" : ""}`,
    `Total tokens: ${summary.totals.tokens ?? "null"} | total USD: ${summary.totals.costUsd ?? "null"}`,
    `Run tokens mean: ${summary.tokens?.mean ?? "null"} | run USD mean: ${summary.costUsd?.mean ?? "null"}`,
  ].join("\n");
}
